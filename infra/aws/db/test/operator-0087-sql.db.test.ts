// The statements the TEST UPGRADE package runs for migration 0087 (docs/releases/2026-10-26-redesign-operator), on a REAL PostgreSQL in the state TEST is in today: 0001-0085 in the ledger
// and 0086 applied outside it (with staff data present). The exact psql command line of apply-0087-test.sh (0087 ALONE, on top of 0086), verify-0086.sql (still 110 passing checks) and
// verify-0087.sql (24 checks), the state queries shared with ledger-recheck.sh and the apply script, the rollback command line (0087 alone; 0086 and its data stay), and the invariants
// the wrapper enforces (ledger untouched, people and access rows untouched). SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, seedWorld, type TestDb, type World } from "./harness.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PKG = `${ROOT}docs/releases/2026-10-26-redesign-operator/scripts/`;
const PRD_PKG = `${ROOT}docs/releases/2026-10-26-redesign-prd-operator/scripts/`;
const UP86 = `${ROOT}infra/aws/db/pending/migrations/0086_staff_management.sql`;
const UP87 = `${ROOT}infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql`;
const DOWN87 = `${ROOT}infra/aws/db/pending/rollback/0087_staff_invitation_acceptance.down.sql`;
const VERIFY86 = readFileSync(`${PKG}verify-0086.sql`, "utf8");
const VERIFY87 = readFileSync(`${PKG}verify-0087.sql`, "utf8");
const ADMIN = process.env.OGEVIA_TEST_DATABASE_URL ?? "";
const urlOf = (name: string) => { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.toString(); };
const scriptSql = (file: string, name: string) => {
  const m = new RegExp(`${name}="([^"]+)"`).exec(readFileSync(`${PKG}${file}`, "utf8"));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[1]!;
};
const S86_Q = scriptSql("apply-0087-test.sh", "S86_Q");
const S87_Q = scriptSql("apply-0087-test.sh", "S87_Q");
const PEOPLE_Q = scriptSql("apply-0087-test.sh", "PEOPLE_Q");
const LEDGER_Q = scriptSql("apply-0087-test.sh", "LEDGER_Q");

// exactly what apply-0087-test.sh and its rollback run (apart from the connection, which is the tunnel in AWS)
const applyCmd = (name: string, ...files: string[]) => spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-d", urlOf(name), "-c", "set local role ogevia_owner", ...files.flatMap((f) => ["-f", f]), "-c", "reset role"], { encoding: "utf8" });
const ro = (name: string, args: string[]) => spawnSync("psql", ["-X", "-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-d", urlOf(name), ...args], { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000" } });
const scalar = (name: string, sql: string) => { const r = ro(name, ["-c", sql]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
type Check = { check_name: string; ok: boolean; detail: string | null };
const v86 = async (db: TestDb): Promise<Check[]> => (await db.admin.query(VERIFY86)).rows as Check[];
const v87 = async (db: TestDb): Promise<Check[]> => (await db.admin.query(VERIFY87)).rows as Check[];
const failing = (rows: Check[]) => rows.filter((r) => r.ok !== true).map((r) => r.check_name);

let db: TestDb;
let w: World;
let sub: string;
beforeAll(async () => {
  db = await createTestDb();                          // 0001-0085: the ledger state of TEST
  expect(applyCmd(db.name, UP86).status).toBe(0);     // 0086 outside the ledger: the state TEST is in after the 7870a04 deployment
  w = await seedWorld(db);
  const as = <T,>(sql: string, params: unknown[]) => asActor(db, w.ownerA.sub, async (x) => (await x.query(sql, params)).rows as T[]);
  const typeId = (await db.admin.query("select id from ogevia.staff_types where organization_id = $1 and name = 'Manager'", [w.orgA])).rows[0].id as string;
  const profile = (await as<{ id: string }>("select ogevia_api.create_staff($1,'Up Grade',$2,null,null) as id", [w.orgA, typeId]))[0]!.id;
  sub = randomUUID();
  await as("select * from ogevia_api.complete_staff_invitation($1,$2,'up@example.test',$3,false,'scheduler')", [w.orgA, profile, sub]);   // 0086 behaviour: active at once
});
afterAll(async () => db?.drop());

describe("the TEST and production copies of the verification are the same file", () => {
  it("verify-0086.sql and verify-0087.sql are byte-identical in both packages", () => {
    for (const f of ["verify-0086.sql", "verify-0087.sql"]) expect(readFileSync(`${PKG}${f}`, "utf8"), f).toBe(readFileSync(`${PRD_PKG}${f}`, "utf8"));
  });
});

describe("before: TEST as it is today (0001-0085 in the ledger, 0086 present, no 0087)", () => {
  it("the state queries read 1|1|21 and 0, the ledger is 85|0085, verify-0086 passes, and every verify-0087 check exists and fails", async () => {
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(scalar(db.name, S87_Q)).toBe("0");
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    expect(failing(await v86(db))).toEqual([]);
    const rows = await v87(db);
    expect(rows).toHaveLength(24);
    // checks that describe the UNCHANGED 0086 hardening may already pass; every check about 0087's own objects and bodies must fail
    for (const own of ["function_exists_ogevia_api.accept_staff_invitation", "function_exists_ogevia_api.list_my_staff_invitations", "complete_staff_invitation_hardened", "complete_staff_invitation_reply_is_profile_id_only", "note_my_sign_in_marks_only_active_staff_membership", "list_staff_shows_invited_as_invitation_pending", "update_staff_suspends_inactive_access", "api_function_count_unchanged_plus_two"]) {
      expect(rows.find((r) => r.check_name === own)?.ok, own).toBe(false);
    }
    expect(rows.every((r) => r.ok === true || r.ok === false)).toBe(true);   // never NULL
  });
});

describe("apply: the exact command line (0087 alone, on top of 0086)", () => {
  let before: string;
  it("applies in one transaction, writes no ledger row, keeps 0086 and leaves people and access untouched", async () => {
    before = scalar(db.name, PEOPLE_Q);
    const r = applyCmd(db.name, UP87);
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(scalar(db.name, S87_Q)).toBe("2");
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    expect(scalar(db.name, PEOPLE_Q)).toBe(before);
  });
  it("verify-0086.sql still reports 110 passing checks and verify-0087.sql 24, through the same psql form the wrapper uses", async () => {
    expect(failing(await v86(db))).toEqual([]);
    expect(failing(await v87(db))).toEqual([]);
    for (const [f, n] of [["verify-0086.sql", 110], ["verify-0087.sql", 24]] as const) {
      const r = ro(db.name, ["-F", "|", "-f", `${PKG}${f}`]);
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines, f).toHaveLength(n);
      expect(lines.every((l) => /\|t\|/.test(l)), f).toBe(true);
    }
  });
  it("a membership created under 0086 is untouched (still active, same role)", async () => {
    expect(scalar(db.name, `select m.status::text || '|' || m.role::text from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '${sub}'`)).toBe("active|scheduler");
  });
  it("running it a second time fails and changes nothing (the wrapper's own precondition would refuse first)", async () => {
    const r = applyCmd(db.name, UP87);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/already exists|cannot drop|does not exist/);
    expect(scalar(db.name, S87_Q)).toBe("2");
    expect(failing(await v87(db))).toEqual([]);
    expect(scalar(db.name, PEOPLE_Q)).toBe(before);
  });
  it("0087 applied WITHOUT 0086 fails and changes nothing (the wrapper requires 1|1|21 first)", async () => {
    const bare = await createTestDb();
    try {
      const r = applyCmd(bare.name, UP87);
      expect(r.status).not.toBe(0);
      expect(scalar(bare.name, S87_Q)).toBe("0");
    } finally { await bare.drop(); }
  });
});

describe("rollback: the exact command line (0087 alone), with invited and active staff present", () => {
  it("drops only the two acceptance functions and restores the 0086 versions; 0086 objects, people, roles, invited memberships and audit stay; the ledger is untouched", async () => {
    const as = <T,>(sql: string, params: unknown[]) => asActor(db, w.ownerA.sub, async (x) => (await x.query(sql, params)).rows as T[]);
    const typeId = (await db.admin.query("select id from ogevia.staff_types where organization_id = $1 and name = 'Manager'", [w.orgA])).rows[0].id as string;
    const profile = (await as<{ id: string }>("select ogevia_api.create_staff($1,'Pending Pat',$2,null,null) as id", [w.orgA, typeId]))[0]!.id;
    await as("select * from ogevia_api.complete_staff_invitation($1,$2,'pat@example.test',$3,true,'staff')", [w.orgA, profile, w.managerB.sub]);   // 0087: an invited membership
    expect(scalar(db.name, `select m.status::text from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where m.organization_id = '${w.orgA}' and u.cognito_sub = '${w.managerB.sub}'`)).toBe("invited");
    const people = scalar(db.name, PEOPLE_Q);
    const r = applyCmd(db.name, DOWN87);
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S86_Q)).toBe("1|1|21");
    expect(scalar(db.name, S87_Q)).toBe("0");
    expect(scalar(db.name, PEOPLE_Q)).toBe(people);
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
    expect(scalar(db.name, "select (pg_get_functiondef(to_regprocedure('ogevia_api.note_my_sign_in()')) like '%staff_profiles%' and pg_get_functiondef(to_regprocedure('ogevia_api.note_my_sign_in()')) not like '%m.status = ''active''%')::int || '|' || (select count(*) from ogevia.permissions where key like 'staff.%')")).toBe("1|2");
    expect(scalar(db.name, `select m.status::text from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where m.organization_id = '${w.orgA}' and u.cognito_sub = '${w.managerB.sub}'`)).toBe("invited");   // left as it is
    expect(scalar(db.name, `select m.status::text || '|' || m.role::text from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '${sub}'`)).toBe("active|scheduler");
    expect(failing(await v86(db))).toEqual([]);                                  // 0086 is complete and healthy
    expect((await v87(db)).filter((x) => x.ok === true).length).toBeLessThan(24);   // and 0087's own checks no longer pass
  });
  it("the round trip works: applying 0087 again restores the fix and every check passes", async () => {
    const r = applyCmd(db.name, UP87);
    expect(r.status, r.stderr).toBe(0);
    expect(scalar(db.name, S87_Q)).toBe("2");
    expect(failing(await v86(db))).toEqual([]);
    expect(failing(await v87(db))).toEqual([]);
    expect(scalar(db.name, LEDGER_Q)).toBe("85|0085");
  });
});
