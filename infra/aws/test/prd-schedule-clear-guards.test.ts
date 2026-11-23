// PRD_SCHEDULE_CLEAR.sh and CLEAR_SCHEDULE.sql: the guards, the reviewed-bytes pins and the order of steps. Stand-in `aws`; nothing touches AWS.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(root, "docs/releases/2026-11-21-schedule-clear");
const text = readFileSync(join(dir, "PRD_SCHEDULE_CLEAR.sh"), "utf8");
const sql = readFileSync(join(dir, "CLEAR_SCHEDULE.sql"), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(join(dir, p))).digest("hex");

function run(env: Record<string, string>, account = "300094796789") {
  const d = mkdtempSync(join(tmpdir(), "psc-")); const bin = join(d, "bin"); mkdirSync(bin); const calls = join(d, "calls");
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash\necho "aws $*" >> ${JSON.stringify(calls)}\ncase "$*" in *get-caller-identity*) echo ${account};; *) echo "UNEXPECTED AWS CALL: $*" >&2; exit 9;; esac\n`); chmodSync(join(bin, "aws"), 0o755);
  const repo = join(d, "repo"); mkdirSync(repo); spawnSync("git", ["-C", repo, "init", "-q"]); spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  try {
    const r = spawnSync("bash", [join(dir, "PRD_SCHEDULE_CLEAR.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO: repo, OGEVIA_RELEASE_COMMIT: head, WORK: join(d, "work"), ...env }, timeout: 30000 });
    let c = ""; try { c = readFileSync(calls, "utf8"); } catch { /* none */ }
    return { ...r, calls: c };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const OK = { OGEVIA_DEPLOY_APPROVAL: "owner-production-schedule-clear-go", EXPECT_NOV: "15", EXPECT_DEC: "26", EXPECT_SERIES: "1" };

describe("PRD_SCHEDULE_CLEAR.sh guards", () => {
  it("refuses without its own approval reference (the other releases' references do not work), before any AWS call", () => {
    for (const ref of ["", "owner-production-offices-go", "owner-production-0109-go"]) { const r = run({ ...OK, OGEVIA_DEPLOY_APPROVAL: ref }); expect(r.status).toBe(2); expect(r.stderr).toContain("production owner authorization is required"); expect(r.calls).toBe(""); }
  });
  it("needs the expected counts from the preview, as whole numbers", () => {
    const { EXPECT_NOV: _n, ...noNov } = OK; expect(run(noNov).stderr).toContain("EXPECT_NOV");
    expect(run({ ...OK, EXPECT_DEC: "26; drop table x" }).stderr).toContain("whole numbers");
  });
  it("refuses a checkout that is not the release commit, modified reviewed SQL, and another AWS account", () => {
    expect(run({ ...OK, OGEVIA_RELEASE_COMMIT: "0".repeat(40) }).stderr).toContain("not at the release commit");
    const r = run(OK); expect(r.status).toBe(2); expect(r.stderr).toContain("differs from the reviewed bytes");   // the throwaway repo has no SQL file
  });
});

describe("the clear: pins and content", () => {
  it("the runner pins the exact bytes of both SQL files", () => {
    expect(text).toContain(sha("CLEAR_SCHEDULE.sql")); expect(text).toContain(sha("PREVIEW_SCHEDULE_CLEAR.sql"));
  });
  it("saves and verifies the backup before the clear, asks for a typed confirmation first, restores the admin host, and re-runs the preview after", () => {
    const at = (s: string) => text.indexOf(s);
    const order = [at("confirm CLEAR-PRODUCTION-SCHEDULE"), at("pg_dump --no-password"), at("head-object"), at("-f \"$CLEAR\""), at("-f \"$PREVIEW\"")];
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("ADMIN HOST RESTORED"); expect(text).toContain("get-bucket-encryption");
  });
  it("the SQL only uses the app's history-preserving functions: no delete, truncate, drop, direct update of shifts, or change to authorizations", () => {
    const body = sql.replace(/--[^\n]*/g, "");
    expect(body).toContain("ogevia_api.end_shift_series"); expect(body).toContain("ogevia_api.cancel_shift");
    expect(body).not.toMatch(/\b(delete\s+from|truncate|drop\s+table|alter\s+table)\b/i);
    expect(body).not.toMatch(/\bupdate\s+ogevia\./i); expect(body).not.toMatch(/\binsert\s+into\s+ogevia\./i);
    expect(body).toContain("authorizations changed; nothing was changed"); expect(body).toContain("The data differs from the preview");
    expect(body.trim().endsWith("commit;")).toBe(true);
  });
});
