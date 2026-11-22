// CORRECT_INVITATION_EMAIL.sh on a real disposable PostgreSQL with a stand-in `aws` (the sign-in service is a JSON file). Nothing touches AWS. SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_URL, createTestDb, type TestDb } from "./harness.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const script = join(root, "docs/releases/2026-11-22-invitation-email-fix/CORRECT_INVITATION_EMAIL.sh");
const u = new URL(ADMIN_URL);
const SUB = randomUUID(); const OLD = "wrong.typo@example.org"; const NEW = "right.person@example.org"; const CODE = "CG-DUMMY-01";
let db: TestDb; let dir: string; let bin: string; let state: string; let calls: string; let org: string; let rec: string; let user: string;

const writeState = (o: unknown) => writeFileSync(state, JSON.stringify(o));
const readState = () => JSON.parse(readFileSync(state, "utf8")) as { users: Array<{ email: string; sub: string; status: string; enabled: boolean }>; failResend?: boolean; sent: string[] };
const aws = (account = "300094796789") => `#!/usr/bin/env python3
import json, sys
a = [x for x in sys.argv[1:]]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "30"]): a = a[2:]
open(${JSON.stringify(calls)}, "a").write("aws " + " ".join(a) + "\\n")
st = json.load(open(${JSON.stringify(state)}))
def opt(n):
    return a[a.index(n) + 1] if n in a else None
def save(): json.dump(st, open(${JSON.stringify(state)}, "w"))
def user(name): return next((x for x in st["users"] if x["email"] == name or x["sub"] == name), None)
cmd = a[1] if a[0] == "cognito-idp" else a[0]
if a[0] == "sts": print("${account}")
elif cmd == "admin-get-user":
    x = user(opt("--username"))
    if not x: sys.stderr.write("UserNotFoundException\\n"); sys.exit(254)
    print(json.dumps({"UserStatus": x["status"], "Enabled": x["enabled"], "UserAttributes": [{"Name": "sub", "Value": x["sub"]}, {"Name": "email", "Value": x["email"]}, {"Name": "email_verified", "Value": "true"}]}))
elif cmd == "list-users":
    f = opt("--filter"); em = f.split('"')[1]; print(len([x for x in st["users"] if x["email"] == em]))
elif cmd == "admin-update-user-attributes":
    x = user(opt("--username")); attrs = [v for i, v in enumerate(a) if a[i - 1] == "--user-attributes" or (i > 1 and v.startswith("Name="))]
    x["email"] = [v.split("Value=")[1] for v in a if v.startswith("Name=email,")][0]; save()
elif cmd == "admin-create-user":
    if st.get("failResend"): sys.stderr.write("LimitExceededException\\n"); sys.exit(254)
    st["sent"].append(opt("--username")); save()
else: sys.stderr.write("UNEXPECTED AWS CALL: " + " ".join(a) + "\\n"); sys.exit(9)
`;
function run(env: Record<string, string> = {}, opts: { account?: string } = {}) {
  writeFileSync(join(bin, "aws"), aws(opts.account)); chmodSync(join(bin, "aws"), 0o755);
  return spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: db.name,
    OGEVIA_LOCAL_REHEARSAL: "1", OGEVIA_NO_CONFIRM: "1", TARGET: "test", POOL: "us-west-2_TESTPOOL", CAREGIVER_CODE: CODE, NEW_EMAIL: NEW, REASON: "Invitation went to a mistyped address (synthetic)", ...env }, timeout: 60000 });
}
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows;
const awsCalls = () => readFileSync(calls, "utf8");
const writes = () => awsCalls().split("\n").filter((l) => /admin-update-user-attributes|admin-create-user/.test(l));

beforeAll(async () => {
  db = await createTestDb({ includePendingUx: true });
  dir = mkdtempSync(join(tmpdir(), "cie-")); bin = join(dir, "bin"); mkdirSync(bin); state = join(dir, "state.json"); calls = join(dir, "calls");
  org = (await q("insert into ogevia.organizations (slug, display_name, timezone) values ('dummy-agency', 'Dummy Agency (synthetic)', 'America/Los_Angeles') returning id"))[0].id;
  const owner = (await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'SYNTHETIC OWNER') returning id", [randomUUID()]))[0].id;
  await q("insert into ogevia.organization_memberships (organization_id, user_id, role) values ($1, $2, 'organization_owner')", [org, owner]);
  user = (await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'SYNTHETIC CAREGIVER') returning id", [SUB]))[0].id;
  rec = (await q("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1, $2, $3, 'Dummy', 'Caregiver', 'onboarding') returning id", [org, user, CODE]))[0].id;
  await q("insert into ogevia.caregiver_invitations (organization_id, caregiver_record_id, user_id, email, existing_account, invited_by) values ($1, $2, $3, $4, false, $5)", [org, rec, user, OLD, owner]);
});
afterAll(async () => { await db?.drop(); if (dir) rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => {
  writeFileSync(calls, "");
  writeState({ users: [{ email: OLD, sub: SUB, status: "FORCE_CHANGE_PASSWORD", enabled: true }], sent: [] });
  await q("update ogevia.caregiver_invitations set email = $1, first_signed_in_at = null, existing_account = false, send_count = 1 where caregiver_record_id = $2", [OLD, rec]);
  await q("delete from ogevia.caregiver_contacts where caregiver_record_id <> $1 or caregiver_record_id = $1", [rec]);
});
const auditCount = async () => (await q("select count(*)::int n from ogevia.audit_events where action = 'caregiver_invitation.email_corrected'"))[0].n as number;
const invitationEmail = async () => (await q("select email, send_count from ogevia.caregiver_invitations where caregiver_record_id = $1", [rec]))[0] as { email: string; send_count: number };

describe("CORRECT_INVITATION_EMAIL.sh", () => {
  it("refuses a wrong target database, a bad new address, the same address and a bad code, before any change", async () => {
    expect(run({ TARGET: "production" }).stderr).toContain("connected to the wrong database");
    expect(run({ NEW_EMAIL: "not-an-email" }).stderr).toContain("not valid");
    expect(run({ NEW_EMAIL: OLD }).stderr).toContain("same as the invited one");
    expect(run({ CAREGIVER_CODE: "CG-NOPE" }).stderr).toContain("exactly one invited caregiver");
    expect(writes()).toEqual([]); expect((await invitationEmail()).email).toBe(OLD);
  });
  it("refuses when the caregiver already signed in, had an existing account, or the account is not waiting for its first password / is another account / the new address is taken", async () => {
    await q("update ogevia.caregiver_invitations set first_signed_in_at = now() where caregiver_record_id = $1", [rec]);
    expect(run().stderr).toContain("already signed in"); await q("update ogevia.caregiver_invitations set first_signed_in_at = null where caregiver_record_id = $1", [rec]);
    await q("update ogevia.caregiver_invitations set existing_account = true where caregiver_record_id = $1", [rec]);
    expect(run().stderr).toContain("already had a sign-in account"); await q("update ogevia.caregiver_invitations set existing_account = false where caregiver_record_id = $1", [rec]);
    writeState({ users: [{ email: OLD, sub: SUB, status: "CONFIRMED", enabled: true }], sent: [] }); expect(run().stderr).toContain("not waiting for its first password");
    writeState({ users: [{ email: OLD, sub: randomUUID(), status: "FORCE_CHANGE_PASSWORD", enabled: true }], sent: [] }); expect(run().stderr).toContain("not the one Ogevia has linked");
    writeState({ users: [{ email: OLD, sub: SUB, status: "FORCE_CHANGE_PASSWORD", enabled: false }], sent: [] }); expect(run().stderr).toContain("not waiting for its first password");
    writeState({ users: [{ email: OLD, sub: SUB, status: "FORCE_CHANGE_PASSWORD", enabled: true }, { email: NEW, sub: randomUUID(), status: "CONFIRMED", enabled: true }], sent: [] }); expect(run().stderr).toContain("already uses the corrected address");
    expect(writes()).toEqual([]); expect((await invitationEmail()).email).toBe(OLD);
  });
  it("corrects the sign-in account and Ogevia together, resends to the corrected address, audits it, prints only masked addresses, and a repeat is refused", async () => {
    const before = await auditCount();
    const r = run(); expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("wrong.typo@example.org"); expect(r.stdout + r.stderr).not.toContain("right.person@example.org");
    expect(r.stdout).toContain("wr***@example.org"); expect(r.stdout).toContain("ri***@example.org"); expect(r.stdout).toContain("same account: yes"); expect(r.stdout).toContain("DONE:");
    const s = readState(); expect(s.users[0]!.email).toBe(NEW); expect(s.users[0]!.sub).toBe(SUB); expect(s.sent).toEqual([NEW]);
    expect(await invitationEmail()).toEqual({ email: NEW, send_count: 2 });
    expect((await q("select contact_email from ogevia.caregiver_contacts where caregiver_record_id = $1", [rec]))[0].contact_email).toBe(NEW);
    const a = await q("select before_state, after_state, reason from ogevia.audit_events where action = 'caregiver_invitation.email_corrected' order by occurred_at desc limit 1");
    expect(await auditCount()).toBe(before + 1); expect(a[0].before_state).toEqual({ email: OLD }); expect(a[0].after_state).toEqual({ email: NEW }); expect(a[0].reason).toContain("mistyped");
    expect(run().stderr).toContain("same as the invited one");   // a repeat with the same address is refused; the old address no longer has an account
  });
  it("reverses the sign-in account change if the database step fails, and leaves everything as it was", async () => {
    const before = await auditCount();
    const other = (await q("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1, 'CG-OTHER-01', 'Other', 'Person', 'onboarding') returning id", [org]))[0].id;
    await q("insert into ogevia.caregiver_contacts (caregiver_record_id, organization_id, contact_email) values ($1, $2, $3)", [other, org, NEW]);   // the SQL guard refuses; Cognito does not know it
    const r = run(); expect(r.status).toBe(1); expect(r.stderr).toContain("REVERSED"); expect(r.stderr).toContain("already used by another caregiver");
    expect(readState().users[0]!.email).toBe(OLD); expect(readState().sent).toEqual([]); expect(await invitationEmail()).toEqual({ email: OLD, send_count: 1 });
    expect(await auditCount()).toBe(before);
    await q("delete from ogevia.caregiver_contacts where caregiver_record_id = $1", [other]);
  });
  it("if only the invitation email cannot be sent, the account and Ogevia stay corrected and it says to press Resend in the app", async () => {
    writeState({ users: [{ email: OLD, sub: SUB, status: "FORCE_CHANGE_PASSWORD", enabled: true }], failResend: true, sent: [] });
    const r = run(); expect(r.status).toBe(1); expect(r.stderr).toContain("Resend sign-in link");
    expect(readState().users[0]!.email).toBe(NEW); expect((await invitationEmail()).email).toBe(NEW);
  });
});
