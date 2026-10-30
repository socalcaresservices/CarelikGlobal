// The statements the PRODUCTION operator package runs for migration 0086 (docs/releases/2026-10-26-redesign-prd-operator), on a REAL PostgreSQL with 0001-0085 applied (the production ledger state (85 / 0085)):
// the exact psql command line of apply-0086-prd.sh, verify-0086.sql (110 checks, each one broken on purpose and caught), the 0086-state query shared with ledger-recheck-prd.sh and the
// apply script, the rollback command line, and the invariants the wrapper enforces (ledger untouched, people and access rows untouched). SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, seedWorld, type TestDb, type World } from "./harness.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PKG = `${ROOT}docs/releases/2026-10-26-redesign-prd-operator/scripts/`;
const UP = `${ROOT}infra/aws/db/pending/migrations/0086_staff_management.sql`;
const DOWN = `${ROOT}infra/aws/db/pending/rollback/0086_staff_management.down.sql`;
const UP87 = `${ROOT}infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql`;
const DOWN87 = `${ROOT}infra/aws/db/pending/rollback/0087_staff_invitation_acceptance.down.sql`;
const VERIFY = readFileSync(`${PKG}verify-0086.sql`, "utf8");
const VERIFY87 = readFileSync(`${PKG}verify-0087.sql`, "utf8");
const ADMIN = process.env.OGEVIA_TEST_DATABASE_URL ?? "";
const urlOf = (name: string) => { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.toString(); };
/** the SQL strings the wrapper scripts use, taken from the scripts themselves so the test cannot drift from them */
const scriptSql = (file: string, name: string) => {
  const m = new RegExp(`${name}="([^"]+)"`).exec(readFileSync(`${PKG}${file}`, "utf8"));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[1]!;
};
const S86_Q = scriptSql("apply-0086-prd.sh", "S86_Q");
const S87_Q = scriptSql("apply-0086-prd.sh", "S87_Q");
const PEOPLE_Q = scriptSql("apply-0086-prd.sh", "PEOPLE_Q");
const LEDGER_Q = scriptSql("apply-0086-prd.sh", "LEDGER_Q");
const ledgerRecheck = readFileSync(`${PKG}ledger-recheck-prd.sh`, "utf8");

// exactly what apply-0086-prd.sh and its rollback run (apart from the connection, which is the tunnel in AWS)
const applyCmd = (name: string, ...files: string[]) => spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-d", urlOf(name), "-c", "set local role ogevia_owner", ...files.flatMap((f) => ["-f", f]), "-c", "reset role"], { encoding: "utf8" });
// the read-only session of the wrapper (PGOPTIONS), tab/pipe separated like its RO() helper
const ro = (name: string, args: string[]) => spawnSync("psql", ["-X", "-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-d", urlOf(name), ...args], { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000" } });
const scalar = (name: string, sql: string) => { const r = ro(name, ["-c", sql]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
type Check = { check_name: string; ok: boolean; detail: string | null };
const verify = async (db: TestDb): Promise<Check[]> => (await db.admin.query(VERIFY)).rows as Check[];
const verify87 = async (db: TestDb): Promise<Check[]> => (await db.admin.query(VERIFY87)).rows as Check[];
const failing = (rows: Check[]) => rows.filter((r) => r.ok !== true).map((r) => r.check_name);

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });   // 0001-0085 only: the state of production
afterAll(async () => db?.drop());

describe("before: production as it is (0001-0085, no 0086)", () => {
  it("the 0086 state query reads 0|0|0, the ledger is 85|0085, and all 110 checks exist and fail (nothing passes by default)", async () => {
    expect(scalar(db.name, S86_Q)).toBe("0|0|0");
    expect(scalar(db.name, S87_Q)).toBe("0");
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    const rows87 = await verify87(db);
    expect(rows87).toHaveLength(24);
    expect(rows87.every((r) => r.ok === false)).toBe(true);                                   // none of the 0087 checks passes by default either
    const rows = await verify(db);
    expect(rows).toHaveLength(110);
    expect(rows.filter((r) => r.ok === true).map((r) => r.check_name).sort()).toEqual([]);   // no check is true while 0086 is absent
    expect(rows.every((r) => r.ok === false)).toBe(true);                                      // and none is NULL (a NULL would slip past a "= false" test); the query does not error
  });
  it("the same state query is the one ledger-recheck-prd.sh runs (so production can be asked 'absent' before and 'present' after)", () => {
    const q = /S86=\$\(RO -d "\$DB_EXPECT" -c "(select \(to_regclass[^"]+)"\)/.exec(ledgerRecheck)?.[1];
    expect(q).toBe(S86_Q.replace(/^select /, "select "));
  });
});

describe("apply: the exact command line", () => {
  let before: string;
  it("applies in one transaction, writes no ledger row, and leaves people and access untouched", async () => {
    before = scalar(db.name, PEOPLE_Q);
    const r = applyCmd(db.name, UP, UP87);                                                    // exactly the wrapper's command: 0086 then 0087, one transaction
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(scalar(db.name, S87_Q)).toBe("2");
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    expect(scalar(db.name, PEOPLE_Q)).toBe(before);
  });
  it("verify-0087.sql: 24 checks, every one passes, through the same psql form the wrapper uses", async () => {
    expect(failing(await verify87(db))).toEqual([]);
    const r = ro(db.name, ["-F", "|", "-f", `${PKG}verify-0087.sql`]);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(24);
    expect(lines.every((l) => /\|t\|/.test(l))).toBe(true);
  });
  it("verify-0086.sql: 110 checks, every one passes, through the same psql form the wrapper uses (no 'f' line)", async () => {
    const rows = await verify(db);
    expect(failing(rows)).toEqual([]);
    const r = ro(db.name, ["-F", "|", "-f", `${PKG}verify-0086.sql`]);
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(110);
    expect(lines.filter((l) => l.includes("|f|"))).toEqual([]);
    expect(lines.every((l) => /\|t\|/.test(l))).toBe(true);
  });
  it("running it a second time fails and changes nothing (the wrapper's own precondition would refuse first)", async () => {
    const r = applyCmd(db.name, UP, UP87);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(scalar(db.name, S87_Q)).toBe("2");
    expect(failing(await verify(db))).toEqual([]);
    expect(scalar(db.name, PEOPLE_Q)).toBe(before);
  });
  it("a read-only session cannot run the apply file (the verification reads can never write)", () => {
    const r = ro(db.name, ["-c", "create table ogevia.should_not_exist (x int)"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/read-only/i);
  });
});

describe("verify-0086.sql catches each way the result can be wrong (every sabotage runs in a rolled-back transaction)", () => {
  const sabotages: [string, string, string[]][] = [
    ["a missing API function", "drop function ogevia_api.list_staff(uuid)", ["function_exists_ogevia_api.list_staff", "function_fixed_search_path_ogevia_api.list_staff", "function_security_definer_ogevia_api.list_staff", "function_no_public_execute_ogevia_api.list_staff", "function_app_execute_ogevia_api.list_staff"]],
    ["an API function executable by PUBLIC", "grant execute on function ogevia_api.list_staff(uuid) to public", ["function_no_public_execute_ogevia_api.list_staff"]],
    ["an API function the application role cannot run", "revoke execute on function ogevia_api.create_staff(uuid, text, uuid, text, text) from ogevia_app", ["function_app_execute_ogevia_api.create_staff"]],
    ["an internal function the application role can run", "grant execute on function ogevia.staff_guard(uuid, boolean) to ogevia_app", ["function_app_execute_ogevia.staff_guard"]],
    ["an internal function executable by PUBLIC", "grant execute on function ogevia.assignable_staff_role(text) to public", ["function_no_public_execute_ogevia.assignable_staff_role", "function_app_execute_ogevia.assignable_staff_role"]],
    ["a function without a fixed search_path", "alter function ogevia_api.list_role_permissions(uuid) reset search_path", ["function_fixed_search_path_ogevia_api.list_role_permissions"]],
    ["an internal function without a fixed search_path", "alter function ogevia.staff_guard(uuid, boolean) reset search_path", ["function_fixed_search_path_ogevia.staff_guard"]],
    ["a function that is not SECURITY DEFINER", "alter function ogevia_api.list_staff_audit(uuid, uuid) security invoker", ["function_security_definer_ogevia_api.list_staff_audit"]],
    ["direct table access for the application role", "grant select on ogevia.staff_profiles to ogevia_app", ["table_no_app_privilege_staff_profiles", "staff_profiles_login_email_not_exposed_to_app"]],
    ["row-level security switched off", "alter table ogevia.staff_types disable row level security", ["table_staff_types"]],
    ["a missing permission", "delete from ogevia.role_permissions where permission_key = 'staff.read'; delete from ogevia.permissions where key = 'staff.read'", ["permissions_exist", "permissions_owner_only"]],
    ["a permission also held by another role", "insert into ogevia.role_permissions (role, permission_key) values ('manager', 'staff.manage')", ["permissions_owner_only"]],
    ["an agency without a default type", "delete from ogevia.staff_types where lower(name) = 'supervisor' and organization_id = (select id from ogevia.organizations limit 1)", ["default_staff_types_every_agency"]],
    ["the trigger gone", "drop trigger organizations_seed_staff_types on ogevia.organizations", ["trigger_organizations_seed_staff_types"]],
    ["the unique name index gone", "drop index ogevia.staff_types_org_name_idx", ["index_staff_types_org_name_unique"]],
    ["note_my_sign_in still the old version", "create or replace function ogevia_api.note_my_sign_in() returns void language sql security definer set search_path = ogevia, pg_temp as $$ select 1 $$", ["note_my_sign_in_replaced"]],
  ];
  it.each(sabotages)("%s", async (_label, sql, expected) => {
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query("insert into ogevia.organizations (id, slug, display_name) values (gen_random_uuid(), 'verify-sabotage', 'Sabotage Org') on conflict do nothing").catch(() => undefined);
      await c.query("savepoint s");
      await c.query(sql);
      const rows = (await c.query(VERIFY)).rows as Check[];
      expect(rows).toHaveLength(110);
      const failed = failing(rows);
      for (const e of expected) expect(failed, `${e} must fail`).toContain(e);
      expect(failed.every((f) => expected.includes(f)), `only the expected checks fail, got ${failed.join(", ")}`).toBe(true);
    } finally { await c.query("rollback"); c.release(); }
    expect(failing(await verify(db))).toEqual([]);   // the sabotage was rolled back
  });
});

/** the 0048 definition of list_accounts, exactly as released (disabled is tested before invited) */
const LIST_ACCOUNTS_0048 = (() => {
  const src = readFileSync(`${ROOT}infra/aws/db/migrations/0048_account_status_enable_disable.sql`, "utf8");
  const m = /create function ogevia_api\.list_accounts\(.*?\n\$\$;\n/s.exec(src);
  if (!m) throw new Error("list_accounts not found in 0048");
  return m[0].replace("create function", "create or replace function");
})();

describe("verify-0087.sql catches each way the 0087 result can be wrong (every sabotage runs in a rolled-back transaction)", () => {
  const sabotages: [string, string, string[]][] = [
    ["accept function missing", "drop function ogevia_api.accept_staff_invitation(uuid)", ["function_exists_ogevia_api.accept_staff_invitation", "function_fixed_search_path_ogevia_api.accept_staff_invitation", "function_security_definer_ogevia_api.accept_staff_invitation", "function_no_public_execute_ogevia_api.accept_staff_invitation", "function_app_execute_ogevia_api.accept_staff_invitation", "accept_staff_invitation_acts_on_own_row_only", "api_function_count_unchanged_plus_two"]],
    ["list function executable by PUBLIC", "grant execute on function ogevia_api.list_my_staff_invitations() to public", ["function_no_public_execute_ogevia_api.list_my_staff_invitations"]],
    ["accept function the application role cannot run", "revoke execute on function ogevia_api.accept_staff_invitation(uuid) from ogevia_app", ["function_app_execute_ogevia_api.accept_staff_invitation"]],
    ["accept function without a fixed search_path", "alter function ogevia_api.accept_staff_invitation(uuid) reset search_path", ["function_fixed_search_path_ogevia_api.accept_staff_invitation"]],
    ["accept function not SECURITY DEFINER", "alter function ogevia_api.accept_staff_invitation(uuid) security invoker", ["function_security_definer_ogevia_api.accept_staff_invitation"]],
    ["complete_staff_invitation back to the 0086 reply (existing_account)", "drop function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text); create function ogevia_api.complete_staff_invitation(p_organization_id uuid, p_profile_id uuid, p_email text, p_cognito_sub text, p_existing_account boolean, p_role text) returns table (profile_id uuid, existing_account boolean) language sql security definer set search_path = ogevia, pg_temp as $$ select null::uuid, false $$; revoke all on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) from public; grant execute on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) to ogevia_app", ["complete_staff_invitation_reply_is_profile_id_only", "complete_staff_invitation_hardened"]],
    ["complete_staff_invitation executable by PUBLIC", "grant execute on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) to public", ["complete_staff_invitation_search_path_and_grants"]],
    ["note_my_sign_in back to the 0086 body", "create or replace function ogevia_api.note_my_sign_in() returns void language sql security definer set search_path = ogevia, pg_temp as $$ update ogevia.staff_profiles set first_signed_in_at = now() where user_id = ogevia.require_actor() and first_signed_in_at is null; update ogevia.caregiver_invitations set first_signed_in_at = now() where user_id = ogevia.require_actor() and first_signed_in_at is null $$", ["note_my_sign_in_marks_only_active_staff_membership"]],
    ["list_staff without the invited state", "create or replace function ogevia_api.list_staff(p_organization_id uuid) returns table (staff_key text, profile_id uuid, caregiver_record_id uuid, user_id uuid, display_name text, staff_type_id uuid, staff_type_name text, contact_email text, phone text, status text, system_role text, access_status text, invited_at timestamptz, first_signed_in_at timestamptz, is_self boolean) language sql stable security definer set search_path = ogevia, pg_temp as $$ select null::text, null::uuid, null::uuid, null::uuid, null::text, null::uuid, null::text, null::text, null::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, null::boolean where false $$", ["list_staff_shows_invited_as_invitation_pending"]],
    ["update_staff without the access suspension", "create or replace function ogevia_api.update_staff(p_organization_id uuid, p_profile_id uuid, p_display_name text, p_staff_type_id uuid, p_contact_email text, p_phone text, p_status text) returns void language sql volatile security definer set search_path = ogevia, pg_temp as $$ select 1 $$", ["update_staff_suspends_inactive_access"]],
    ["update_staff executable by PUBLIC", "grant execute on function ogevia_api.update_staff(uuid, uuid, text, uuid, text, text, text) to public", ["update_staff_keeps_0086_hardening"]],
    ["disable_account back to the 0048 behaviour (no refusal of a pending invitation)", "create or replace function ogevia_api.disable_account(p_organization_id uuid, p_user_id uuid, p_reason text) returns table (cognito_sub text, disable_sign_in boolean) language sql security definer set search_path = ogevia, pg_temp as $$ select null::text, false $$", ["disable_account_refuses_pending_invitation"]],
    ["list_accounts back to the 0048 body (disabled tested before invited)", LIST_ACCOUNTS_0048, ["list_accounts_shows_invited_before_disabled"]],
    ["a new table created", "create table ogevia.staff_invitation_acceptances (x int)", ["no_new_tables"]],
    ["a permission missing", "delete from ogevia.role_permissions where permission_key = 'staff.read'; delete from ogevia.permissions where key = 'staff.read'", ["staff_permissions_unchanged"]],
    ["direct table access for the application role", "grant select on ogevia.staff_profiles to ogevia_app", ["no_application_role_table_privilege_on_staff_tables"]],
  ];
  it.each(sabotages)("%s", async (_label, sql, expected) => {
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query(sql);
      const rows = (await c.query(VERIFY87)).rows as Check[];
      expect(rows).toHaveLength(24);
      const failed = failing(rows);
      for (const e of expected) expect(failed, `${e} must fail`).toContain(e);
      expect(failed.every((f) => expected.includes(f)), `only the expected checks fail, got ${failed.join(", ")}`).toBe(true);
    } finally { await c.query("rollback"); c.release(); }
    expect(failing(await verify87(db))).toEqual([]);   // the sabotage was rolled back
  });
});

describe("rollback: the exact command line, with staff data present", () => {
  let w: World;
  it("drops only staff management; people, memberships, roles and audit stay; note_my_sign_in is restored; the ledger is untouched; the verification then fails everywhere (as it must)", async () => {
    w = await seedWorld(db);
    const as = <T,>(sql: string, params: unknown[]) => asActor(db, w.ownerA.sub, async (x) => (await x.query(sql, params)).rows as T[]);
    const typeId = (await db.admin.query("select id from ogevia.staff_types where organization_id = $1 and name = 'Manager'", [w.orgA])).rows[0].id as string;
    const profile = (await as<{ id: string }>("select ogevia_api.create_staff($1,'Ro Rollback',$2,null,null) as id", [w.orgA, typeId]))[0]!.id;
    const sub = randomUUID();
    await as("select * from ogevia_api.complete_staff_invitation($1,$2,'ro@example.test',$3,false,'scheduler')", [w.orgA, profile, sub]);
    const people = scalar(db.name, PEOPLE_Q);
    expect(Number(scalar(db.name, "select count(*) from ogevia.staff_profiles"))).toBeGreaterThanOrEqual(1);
    const r = applyCmd(db.name, DOWN87, DOWN);                                                // exactly the wrapper's rollback: 0087 first, then 0086, one transaction
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("0|0|0");
    expect(scalar(db.name, S87_Q)).toBe("0");
    expect(scalar(db.name, PEOPLE_Q)).toBe(people);
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    expect(scalar(db.name, "select (pg_get_functiondef(to_regprocedure('ogevia_api.note_my_sign_in()')) not like '%staff_profiles%')::int || '|' || (select count(*) from ogevia.permissions where key like 'staff.%')")).toBe("1|0");
    expect(scalar(db.name, `select role::text from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '${sub}'`)).toBe("scheduler");   // the invited person keeps the access they were given
    expect(Number(scalar(db.name, "select count(*) from ogevia.audit_events where action like 'staff.%'"))).toBeGreaterThanOrEqual(2);   // the history stays
    expect((await verify(db)).every((x) => x.ok === false)).toBe(true);
  });
  it("the round trip works: applying again restores everything and every check passes", async () => {
    const r = applyCmd(db.name, UP, UP87);
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(scalar(db.name, S87_Q)).toBe("2");
    expect(failing(await verify(db))).toEqual([]);
    expect(failing(await verify87(db))).toEqual([]);
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
  });
});
