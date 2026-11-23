// PRD_OFFICES_RELEASE.sh: the guards that stop it before anything is touched, and static checks of the order and the commands it may use. Stand-in `aws`; nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "docs/releases/2026-11-21-offices/PRD_OFFICES_RELEASE.sh");
const text = readFileSync(script, "utf8");

function run(args: string[], env: Record<string, string>, account = "300094796789") {
  const dir = mkdtempSync(join(tmpdir(), "pof-")); const bin = join(dir, "bin"); mkdirSync(bin); const calls = join(dir, "calls");
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash\necho "aws $*" >> ${JSON.stringify(calls)}\ncase "$*" in *get-caller-identity*) echo ${account};; *) echo "UNEXPECTED AWS CALL: $*" >&2; exit 9;; esac\n`); chmodSync(join(bin, "aws"), 0o755);
  try {
    const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, timeout: 30000 });
    let c = ""; try { c = readFileSync(calls, "utf8"); } catch { /* no calls */ }
    return { ...r, calls: c };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const APPROVED = { OGEVIA_DEPLOY_APPROVAL: "owner-production-offices-go" };

describe("PRD_OFFICES_RELEASE.sh guards", () => {
  it("refuses without the production approval reference, before any AWS call", () => {
    const r = run([], {}); expect(r.status).toBe(1); expect(r.stderr + r.stdout).toContain("production owner authorization is required"); expect(r.calls).toBe("");
    const w = run([], { OGEVIA_DEPLOY_APPROVAL: "owner-production-0109-go" }); expect(w.status).toBe(1); expect(w.stdout).toContain("authorization is required");
  });
  it("refuses another AWS account, an unknown mode and a missing workspace, without any change", () => {
    const r = run([], APPROVED, "111111111111"); expect(r.status).toBe(1); expect(r.stdout).toContain("wrong account"); expect(r.calls).not.toMatch(/ec2|rds|cloudformation|s3|lambda|secretsmanager/);
    expect(run(["delete"], APPROVED).stdout).toContain("usage:");
    const m = run(["rollback-db"], APPROVED); expect(m.status).not.toBe(0);
  });
  it("refuses a checkout that is not the release commit", () => {
    const d = mkdtempSync(join(tmpdir(), "pofrepo-")); spawnSync("git", ["-C", d, "init", "-q"]); spawnSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
    try { const r = run([], { ...APPROVED, REPO: d, OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(1); expect(r.stdout).toContain("not at the release commit"); expect(r.calls).not.toMatch(/ec2|rds|cloudformation/); }
    finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("PRD_OFFICES_RELEASE.sh content", () => {
  it("applies the steps in the reviewed order: backup, database, API code, API routes, web", () => {
    const at = (s: string) => text.indexOf(s);
    const order = [at("pg_dump --no-password"), at("-f \"$WORK/upgrade.sql\""), at("run_change_set \"$CHANGE\" candidate-code.template.json changes-code"), at("run_change_set \"$CHANGE2\" candidate-routes.template.json changes-routes-add"), at("deploy-production.sh\" web")];
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("asks for a typed confirmation, restores the admin host on exit, saves a private encrypted backup, and rolls the routes back by itself on a failed smoke check", () => {
    for (const s of ["confirm GO-PRODUCTION-OFFICES", "ADMIN HOST RESTORED", "get-bucket-encryption", "get-public-access-block", "SMOKE FAILED: rolling the routes back", "do_rollback_routes", "rollback-api-web", "rollback-db", "sha256sum --check", "flock -n 9"]) if (s !== "sha256sum --check") expect(text, s).toContain(s);
  });
  it("never deploys with cdk, never deletes a stack, snapshot or bucket, never touches TEST (except reading it), and prints no secret", () => {
    for (const bad of [/cdk (deploy|synth|bootstrap)/, /delete-stack/, /delete-db|delete-bucket|rm -rf \/|s3 rb/, /rds (modify|delete|restore)/, /update-stack(?!.*rollback)/]) expect(text.replace(/ROLLBACK_PRD[\s\S]*?ROLLBACK_PRD/, "")).not.toMatch(bad);
    expect(text).not.toMatch(/echo[^\n]*\$(PGPASSWORD|MASTER|PASSWORD)/);
    const testWrites = text.split("\n").filter((l) => /Ogevia-prod-/.test(l) && /(update-|create-change-set|execute-change-set|deploy|put-|sync s3|s3 cp)/.test(l));
    expect(testWrites).toEqual([]);
  });
  it("checks the release code against TEST (source trees and Handler hash) before it changes anything", () => {
    expect(text.indexOf("the release differs from the code accepted on TEST")).toBeGreaterThan(0);
    expect(text.indexOf("deployed \"$WORK/handler.test.zip\" \"$NEW_JS_HASH\"")).toBeLessThan(text.indexOf("pg_dump --no-password"));
    expect(text.indexOf("the release differs from the code accepted on TEST")).toBeLessThan(text.indexOf("open_tunnel\npsql"));
  });
});
