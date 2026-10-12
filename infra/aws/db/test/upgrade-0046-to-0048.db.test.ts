// Upgrade rehearsal: a POPULATED database at migration 0046 is upgraded to 0048 with the real runner.
// Proves which existing rows change (none) and what is added. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { asActor, createTestDb, freshClient, seedWorld, setBaselineAvailability, type Actor, type TestDb, type World } from "./harness.js";

const DOWN = new URL("../rollback/", import.meta.url);
let db: TestDb;
let w: World;
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);

async function runDown(file: string) {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role ogevia_owner");
    await client.query(readFileSync(new URL(file, DOWN), "utf8"));
    await client.query("reset role");
    await client.query("delete from ogevia_meta.schema_migrations where version = $1", [file.slice(0, 4)]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** A fingerprint of the rows of a table, on the columns that existed at 0046 (so added columns do not count as a change). */
const TABLES: Record<string, string> = {
  app_users: "*", organizations: "*", organization_memberships: "*", caregiver_records: "*", clients: "*", services: "*",
  client_authorizations: "*", caregiver_assignments: "*", caregiver_invitations: "*", shifts: "*", shift_coverage_events: "*",
  authorization_reservations: "*", service_visits: "*", caregiver_availability_windows: "*", audit_events: "*",
  availability_overrides: "id, organization_id, caregiver_record_id, range_start, range_end, reason, authorised_by, created_at, expires_at, used_count, last_used_at",
  permissions: "*", role_permissions: "*",
};
const EXPECTED_NEW_ROWS = "permission_key = 'accounts.manage'";
async function fingerprints() {
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const [table, cols] of Object.entries(TABLES)) {
    const filter = table === "permissions" ? "where key <> 'accounts.manage'" : table === "role_permissions" ? "where permission_key <> 'accounts.manage'" : "";
    const r = await db.admin.query(
      `select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from (select ${cols} from ogevia.${table} ${filter}) x`);
    out[table] = { rows: r.rows[0].n, hash: r.rows[0].h };
  }
  return out;
}

beforeAll(async () => {
  db = await createTestDb(); // migrated from zero (0001-0049)
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

describe("upgrade from 0046 to 0048 on a populated database", () => {
  it("changes no existing row; adds one permission and its owner grant; legacy overrides stay readable; the runner applies exactly 0047 and 0048", async () => {
    // Put the database back at 0046 (the state production is expected to be in), exactly as the rollback does.
    await runDown("0049_reservation_not_counted_when_late_confirmation_accepted.down.sql");
    await runDown("0048_account_status_enable_disable.down.sql");
    await runDown("0047_availability_override_one_shift.down.sql");
    expect((await db.admin.query("select max(version) v from ogevia_meta.schema_migrations")).rows[0].v).toBe("0046");
    expect((await db.admin.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ogevia_api' and p.proname in ('list_accounts','disable_account')")).rows[0].n).toBe(0);

    // Realistic data at 0046: clients, shifts, a signed-in caregiver, availability, and an OLD-STYLE override (range, multi-use).
    const fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 60 });
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id as string;
    await setBaselineAvailability(db, w.orgA, w.caregiverA1, []);
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, now() + interval '3 days', now() + interval '3 days 2 hours', 'scheduled')`, [w.orgA, fx.client, fx.service, w.caregiverA1.userId, rec]);
    const oldOverride = (await call(w.ownerA, "select ogevia_api.authorize_availability_override($1,$2,now(), now() + interval '2 days','Phone agreement') as id", [w.orgA, rec]))[0].id as string;
    const before = await fingerprints();
    expect(before.availability_overrides!.rows).toBe(1);
    expect(before.shifts!.rows).toBeGreaterThan(0);

    // The real runner applies whatever is missing.
    const client = await db.admin.connect();
    let applied: string[];
    try { applied = (await migrate(client)).applied.map((x) => x.slice(0, 4)); } finally { client.release(); }
    expect(applied).toEqual(["0047", "0048", "0049"]); // 0049 is the function-only accounting fix; it changes no row

    const after = await fingerprints();
    expect(after).toEqual(before); // NO existing row, in any table, changed or disappeared
    // What was added:
    expect((await db.admin.query(`select count(*)::int n from ogevia.role_permissions where ${EXPECTED_NEW_ROWS}`)).rows[0].n).toBe(1);
    expect((await db.admin.query("select role::text r from ogevia.role_permissions where permission_key = 'accounts.manage'")).rows).toEqual([{ r: "organization_owner" }]);
    expect((await db.admin.query("select count(*)::int n from ogevia.permissions where key = 'accounts.manage'")).rows[0].n).toBe(1);
    // The legacy override keeps its data; its new columns are empty, so it can no longer be used (it was already expired or expires within 30 minutes).
    const legacy = (await db.admin.query("select reason, client_id, consumed_at, shift_id, original_status from ogevia.availability_overrides where id = $1", [oldOverride])).rows[0];
    expect(legacy).toEqual({ reason: "Phone agreement", client_id: null, consumed_at: null, shift_id: null, original_status: null });
    expect((await db.admin.query("select ogevia.availability_override_for($1,$2,now(),now() + interval '1 hour','shift',null) id", [w.orgA, rec])).rows[0].id).toBeNull();
    // Nobody's access changed: every person still has exactly the membership and role they had.
    expect((await call(w.managerA, "select role::text r from ogevia_api.get_my_context()")).map((r) => r.r)).toEqual(["manager"]);
    expect((await call(w.ownerA, "select role::text r from ogevia_api.get_my_context()")).map((r) => r.r)).toEqual(["organization_owner"]);
    // Re-running changes nothing (idempotent runner).
    const again = await db.admin.connect();
    try { expect((await migrate(again)).applied).toEqual([]); } finally { again.release(); }
    expect(await fingerprints()).toEqual(before);
    // The fingerprint is not vacuous: a change to a single existing row IS detected.
    await db.admin.query("update ogevia.app_users set display_name = display_name || ' x' where id = $1", [w.managerA.userId]);
    expect((await fingerprints()).app_users!.hash).not.toBe(before.app_users!.hash);
  });
});
