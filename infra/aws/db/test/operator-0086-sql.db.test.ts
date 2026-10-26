// The statements the TEST operator package runs for migration 0086 (docs/releases/2026-10-26-redesign-operator), on a REAL PostgreSQL with 0001-0085 applied (the TEST ledger state):
// the exact psql command line of apply-0086-test.sh, verify-0086.sql (110 checks, each one broken on purpose and caught), the 0086-state query shared with ledger-recheck.sh and the
// apply script, the rollback command line, and the invariants the wrapper enforces (ledger untouched, people and access rows untouched). SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, seedWorld, type TestDb, type World } from "./harness.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PKG = `${ROOT}docs/releases/2026-10-26-redesign-operator/scripts/`;
const UP = `${ROOT}infra/aws/db/pending/migrations/0086_staff_management.sql`;
const DOWN = `${ROOT}infra/aws/db/pending/rollback/0086_staff_management.down.sql`;
const VERIFY = readFileSync(`${PKG}verify-0086.sql`, "utf8");
const ADMIN = process.env.OGEVIA_TEST_DATABASE_URL ?? "";
const urlOf = (name: string) => { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.toString(); };
/** the SQL strings the wrapper scripts use, taken from the scripts themselves so the test cannot drift from them */
const scriptSql = (file: string, name: string) => {
  const m = new RegExp(`${name}="([^"]+)"`).exec(readFileSync(`${PKG}${file}`, "utf8"));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[1]!;
};
const S86_Q = scriptSql("apply-0086-test.sh", "S86_Q");
const PEOPLE_Q = scriptSql("apply-0086-test.sh", "PEOPLE_Q");
const LEDGER_Q = scriptSql("apply-0086-test.sh", "LEDGER_Q");
const ledgerRecheck = readFileSync(`${PKG}ledger-recheck.sh`, "utf8");

// exactly what apply-0086-test.sh and its rollback run (apart from the connection, which is the tunnel in AWS)
const applyCmd = (name: string, file: string) => spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-d", urlOf(name), "-c", "set local role ogevia_owner", "-f", file, "-c", "reset role"], { encoding: "utf8" });
// the read-only session of the wrapper (PGOPTIONS), tab/pipe separated like its RO() helper
const ro = (name: string, args: string[]) => spawnSync("psql", ["-X", "-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-d", urlOf(name), ...args], { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000" } });
const scalar = (name: string, sql: string) => { const r = ro(name, ["-c", sql]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
type Check = { check_name: string; ok: boolean; detail: string | null };
const verify = async (db: TestDb): Promise<Check[]> => (await db.admin.query(VERIFY)).rows as Check[];
const failing = (rows: Check[]) => rows.filter((r) => r.ok !== true).map((r) => r.check_name);

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });   // 0001-0085 only: the state of TEST
afterAll(async () => db?.drop());

describe("before: TEST as it is (0001-0085, no 0086)", () => {
  it("the 0086 state query reads 0|0|0, the ledger is 85|0085, and all 110 checks exist and fail (nothing passes by default)", async () => {
    expect(scalar(db.name, S86_Q)).toBe("0|0|0");
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    const rows = await verify(db);
    expect(rows).toHaveLength(110);
    expect(rows.filter((r) => r.ok === true).map((r) => r.check_name).sort()).toEqual([]);   // no check is true while 0086 is absent
    expect(rows.every((r) => r.ok === false)).toBe(true);                                      // and none is NULL (a NULL would slip past a "= false" test); the query does not error
  });
  it("the same state query is the one ledger-recheck.sh runs (so TEST can be asked 'absent' before and 'present' after)", () => {
    const q = /S86=\$\(RO -d "\$DB_EXPECT" -c "(select \(to_regclass[^"]+)"\)/.exec(ledgerRecheck)?.[1];
    expect(q).toBe(S86_Q.replace(/^select /, "select "));
  });
});

describe("apply: the exact command line", () => {
  let before: string;
  it("applies in one transaction, writes no ledger row, and leaves people and access untouched", async () => {
    before = scalar(db.name, PEOPLE_Q);
    const r = applyCmd(db.name, UP);
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    expect(scalar(db.name, PEOPLE_Q)).toBe(before);
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
    const r = applyCmd(db.name, UP);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
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
    const r = applyCmd(db.name, DOWN);
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("0|0|0");
    expect(scalar(db.name, PEOPLE_Q)).toBe(people);
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    expect(scalar(db.name, "select (pg_get_functiondef(to_regprocedure('ogevia_api.note_my_sign_in()')) not like '%staff_profiles%')::int || '|' || (select count(*) from ogevia.permissions where key like 'staff.%')")).toBe("1|0");
    expect(scalar(db.name, `select role::text from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '${sub}'`)).toBe("scheduler");   // the invited person keeps the access they were given
    expect(Number(scalar(db.name, "select count(*) from ogevia.audit_events where action like 'staff.%'"))).toBeGreaterThanOrEqual(2);   // the history stays
    expect((await verify(db)).every((x) => x.ok === false)).toBe(true);
  });
  it("the round trip works: applying again restores everything and every check passes", async () => {
    const r = applyCmd(db.name, UP);
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(failing(await verify(db))).toEqual([]);
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
  });
});
