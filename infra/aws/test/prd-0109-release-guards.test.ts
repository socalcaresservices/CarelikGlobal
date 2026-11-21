// PRD_0109_RELEASE.sh: the guards that run before anything in production can change. Stand-in `aws`; nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "docs/releases/2026-11-20-test-plan/toolchain/PRD_0109_RELEASE.sh");
function setup(account: string) {
  const dir = mkdtempSync(join(tmpdir(), "prd0109-"));
  const bin = join(dir, "bin"), calls = join(dir, "calls"); mkdirSync(bin); writeFileSync(calls, "");
  mkdirSync(join(dir, "op")); copyFileSync(script, join(dir, "op/PRD_0109_RELEASE.sh")); copyFileSync(join(root, "infra/aws/scripts/production-0109-release.py"), join(dir, "op/production-0109-release.py"));
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "aws $*" >> ${JSON.stringify(calls)}\ncase "$*" in *get-caller-identity*) echo ${account};; *) exit 9;; esac\n`);
  chmodSync(join(bin, "aws"), 0o755);
  return { dir, bin, calls, op: join(dir, "op/PRD_0109_RELEASE.sh") };
}
const run = (s: ReturnType<typeof setup>, env: Record<string, string> = {}, args: string[] = []) =>
  spawnSync("bash", [s.op, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, ...env } });

it("refuses without the production authorization reference, and in the wrong account, before any other AWS call", () => {
  let s = setup("300094796789");
  try { const r = run(s); expect(r.status).toBe(1); expect(r.stdout + r.stderr).toContain("production owner authorization is required"); expect(readFileSync(s.calls, "utf8")).toBe(""); } finally { rmSync(s.dir, { recursive: true, force: true }); }
  s = setup("111111111111");
  try { const r = run(s, { OGEVIA_DEPLOY_APPROVAL: "owner-production-0109-go" }); expect(r.status).toBe(1); expect(r.stdout + r.stderr).toContain("wrong account"); expect(readFileSync(s.calls, "utf8").trim().split("\n")).toHaveLength(1); } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
it("the old production approval reference does not authorize this release", () => {
  const s = setup("300094796789");
  try { const r = run(s, { OGEVIA_DEPLOY_APPROVAL: "owner-production-ux-go" }); expect(r.status).toBe(1); expect(readFileSync(s.calls, "utf8")).toBe(""); } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
it("stops at the typed confirmation (no terminal here) before restoring tools or touching AWS beyond the identity check", () => {
  const s = setup("300094796789");
  try {
    const r = run(s, { OGEVIA_DEPLOY_APPROVAL: "owner-production-0109-go" });
    expect(r.status).not.toBe(0);
    expect(readFileSync(s.calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(s.calls, "utf8")).not.toMatch(/ec2|rds|ssm|cloudformation|s3|secretsmanager/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
it("the resume mode refuses without the same authorization and a saved workspace", () => {
  const s = setup("300094796789");
  try { const r = run(s, {}, ["resume", "/tmp/ogevia-production-release.nope"]); expect(r.status).toBe(1); expect(r.stdout + r.stderr).toContain("production authorization required"); } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
