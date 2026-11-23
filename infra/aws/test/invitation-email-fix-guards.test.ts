// The wrappers and the content of the invitation-email correction procedure. Stand-in `aws`; nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(root, "docs/releases/2026-11-22-invitation-email-fix");
const read = (f: string) => readFileSync(join(dir, f), "utf8");
const core = read("CORRECT_INVITATION_EMAIL.sh"); const prd = read("PRD_CORRECT_INVITATION_EMAIL.sh"); const test = read("TEST_CORRECT_INVITATION_EMAIL.sh"); const sql = read("CORRECT_INVITATION_EMAIL.sql");

function runPrd(env: Record<string, string>, account = "300094796789") {
  const d = mkdtempSync(join(tmpdir(), "pie-")); const bin = join(d, "bin"); mkdirSync(bin); const calls = join(d, "calls");
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash\necho "aws $*" >> ${JSON.stringify(calls)}\ncase "$*" in *get-caller-identity*) echo ${account};; *) echo "UNEXPECTED AWS CALL: $*" >&2; exit 9;; esac\n`); chmodSync(join(bin, "aws"), 0o755);
  const repo = join(d, "repo"); mkdirSync(repo); spawnSync("git", ["-C", repo, "init", "-q"]); spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  try {
    const r = spawnSync("bash", [join(dir, "PRD_CORRECT_INVITATION_EMAIL.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO: repo, OGEVIA_RELEASE_COMMIT: head, WORK: join(d, "w"), CAREGIVER_CODE: "CG-1234", NEW_EMAIL: "x@example.org", REASON: "typo in the invited address", ...env }, timeout: 20000 });
    let c = ""; try { c = readFileSync(calls, "utf8"); } catch { /* none */ }
    return { ...r, calls: c };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const OK = { OGEVIA_DEPLOY_APPROVAL: "owner-production-invitation-email-go" };

describe("PRD_CORRECT_INVITATION_EMAIL.sh guards", () => {
  it("needs its own approval reference (the other procedures' references do not work) before any AWS call", () => {
    for (const ref of ["", "owner-production-offices-go", "owner-production-schedule-clear-go"]) { const r = runPrd({ OGEVIA_DEPLOY_APPROVAL: ref }); expect(r.status).toBe(2); expect(r.stderr).toContain("production owner authorization is required"); expect(r.calls).toBe(""); }
  });
  it("refuses another account, a checkout that is not the release commit, and a missing caregiver code, before touching the database", () => {
    const a = runPrd(OK, "111111111111"); expect(a.status).toBe(2); expect(a.calls).not.toMatch(/ec2|rds|secretsmanager|ssm|cognito/);
    expect(runPrd({ ...OK, OGEVIA_RELEASE_COMMIT: "0".repeat(40) }).stderr).toContain("not at the release commit");
    const { CAREGIVER_CODE: _c, ...none } = { CAREGIVER_CODE: "", ...OK }; void none;
    expect(runPrd({ ...OK, CAREGIVER_CODE: "" }).status).not.toBe(0);
  });
});

describe("what the procedure may and may not do", () => {
  it("only changes the one invited caregiver's account email and invitation: no password, delete, disable or enable calls, no secret read in the procedure itself", () => {
    expect(core).toContain("admin-update-user-attributes"); expect(core).toContain("--message-action RESEND");
    for (const bad of [/admin-set-user-password/, /admin-delete-user/, /admin-disable-user|admin-enable-user/, /admin-reset-user-password/, /get-secret-value/, /delete-user/, /cdk |cloudformation (update|deploy)/]) expect(core).not.toMatch(bad);
    expect(core).not.toMatch(/echo[^\n]*\$(NEW_EMAIL|OLD_EMAIL)(?![A-Za-z_])(?!"\))/); // addresses are printed only through mask()
  });
  it("no command is piped into grep -q under pipefail (an early-exiting grep breaks the pipe and fails a check that passed)", () => {
    for (const f of [core, prd, test]) expect(f).not.toMatch(/\|\s*grep\s+-[A-Za-z]*q/);
  });
  it("the SQL changes only the invitation, the contact (through the app's function) and the audit; it deletes and drops nothing", () => {
    const body = sql.replace(/--[^\n]*/g, "");
    expect(body).toMatch(/update ogevia\.caregiver_invitations set email/); expect(body).toContain("ogevia_api.set_caregiver_contact"); expect(body).toContain("ogevia.write_audit");
    expect(body).not.toMatch(/\b(delete\s+from|truncate|drop\s+|alter\s+table)\b/i);
    expect((body.match(/\bupdate\s+ogevia\./gi) ?? []).length).toBe(1);
    expect(body).toContain("first_signed_in_at is not null"); expect(body).toContain("existing_account");
  });
  it("is gated by a typed confirmation, restores the admin host in production, never widens a real target, and the TEST wrapper refuses the production pool", () => {
    expect(core).toContain("confirm CORRECT-INVITATION-EMAIL"); expect(prd).toContain("ADMIN HOST RESTORED"); expect(test).toContain("us-west-2_FHJoX71ca");
    expect(core).toContain('TARGET" == test'); expect(core).toContain("ogevia_test_[0-9a-f]{12}");
  });
});
