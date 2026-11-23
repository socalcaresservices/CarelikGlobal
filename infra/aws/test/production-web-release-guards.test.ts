// production-web-release.sh: the guards that run before anything in production can change. Stand-in `aws`; nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/production-web-release.sh", import.meta.url));
function setup(account: string) {
  const dir = mkdtempSync(join(tmpdir(), "prdweb-")); const bin = join(dir, "bin"), calls = join(dir, "calls"); mkdirSync(bin); writeFileSync(calls, "");
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "aws $*" >> ${JSON.stringify(calls)}\ncase "$*" in *get-caller-identity*) echo ${account};; *) exit 9;; esac\n`); chmodSync(join(bin, "aws"), 0o755);
  return { dir, bin, calls };
}
const run = (s: ReturnType<typeof setup>, env: Record<string, string> = {}) => spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, ...env } });
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });

it("refuses without the web authorization reference (the other production references do not authorize it), before any AWS call", () => {
  const s = setup("300094796789");
  try {
    for (const ref of [undefined, "owner-production-0109-go", "owner-production-request-cleanup-go", "owner-production-ux-go"]) {
      const r = run(s, ref ? { OGEVIA_DEPLOY_APPROVAL: ref } : {}); expect(r.status, String(ref)).toBe(1); expect(r.stdout + r.stderr).toContain("owner authorization is required");
    }
    expect(readFileSync(s.calls, "utf8")).toBe("");
  } finally { done(s); }
});
it("refuses in the wrong account after one identity call", () => {
  const s = setup("111111111111");
  try { const r = run(s, { OGEVIA_DEPLOY_APPROVAL: "owner-production-web-go" }); expect(r.status).toBe(1); expect(r.stdout + r.stderr).toContain("wrong account"); expect(readFileSync(s.calls, "utf8").trim().split("\n")).toHaveLength(1); } finally { done(s); }
});
it("stops at the typed confirmation (no terminal here) before restoring tools or touching AWS beyond the identity check", () => {
  const s = setup("300094796789");
  try {
    const r = run(s, { OGEVIA_DEPLOY_APPROVAL: "owner-production-web-go" });
    expect(r.status).not.toBe(0);
    expect(readFileSync(s.calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(s.calls, "utf8")).not.toMatch(/s3|cloudformation|cloudfront|ec2|rds|ssm|secretsmanager/);
  } finally { done(s); }
});
it("is web-only: it never touches the database, the API stack, security groups or secrets", () => {
  const text = readFileSync(script, "utf8");
  expect(text).not.toMatch(/modify-instance-attribute|ssm start-session|secretsmanager|pg_dump|psql |execute-change-set|update-stack|cdk deploy/);
  expect(text).toContain("deploy-production.sh");
});
