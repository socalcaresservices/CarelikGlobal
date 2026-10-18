// What the deployed ComplianceSweep (EventBridge every 15 minutes, apps/sv-api/src/scheduled.ts) does while readiness enforcement is OFF, and the moment it is ON.
// Real database, real scheduled code, the application role. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedWorld, freshClient, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { runComplianceSweep } from "../src/scheduled";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

/** Row count of every table in the ogevia schema: a complete picture of "nothing was written". */
async function counts(): Promise<Record<string, number>> {
  const tables = (await db.admin.query("select tablename from pg_tables where schemaname = 'ogevia' order by tablename")).rows.map((r) => r.tablename as string);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (await db.admin.query(`select count(*)::int n from ogevia."${t}"`)).rows[0].n;
  return out;
}
const sweep = () => runComplianceSweep({ db: { connect: () => db.admin.connect() } as never, dbSetRole: "ogevia_app", log: () => {} });

describe("ComplianceSweep with enforcement off, then on", () => {
  it("while no agency has activated enforcement the run selects no agency, evaluates nothing, writes no row to any table (holds, flags, audit, events) and activates nothing", async () => {
    // a caregiver who WOULD be held (no clearance, no hire date documents) with a scheduled shift: report-only means nothing happens
    const fx = await freshClient(db, w, w.caregiverA3, 600, w.orgA, { before: 5, after: 120 });
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       select $1, $2, $3, null, cr.id, now() + interval '30 hours', now() + interval '32 hours', 'scheduled' from ogevia.caregiver_records cr where cr.linked_user_id = $4`,
      [w.orgA, fx.client, fx.service, w.caregiverA3.userId]);
    const active = (await db.admin.query("select count(*)::int n from ogevia.organization_readiness_settings where enforcement_active_from is not null")).rows[0].n;
    expect(active).toBe(0);
    const before = await counts();
    const result = await sweep();
    expect(result).toEqual({ organizations: 0, evaluated: 0, holdsOpened: 0, holdsReleased: 0, failedOrganizations: 0 });
    expect(await counts()).toEqual(before);
    expect((await db.admin.query("select count(*)::int n from ogevia.organization_readiness_settings where enforcement_active_from is not null")).rows[0].n).toBe(0);
    // repeated runs stay a no-op
    await sweep(); await sweep();
    expect(await counts()).toEqual(before);
  });

  it("the sweep never activates anything itself: only the owner's activation makes it act, and then it does so for that agency alone", async () => {
    // activation is recorded by the owner's one-way call; the column it sets is set directly here because this test is about what the sweep does with it
    await db.admin.query(
      "update ogevia.organization_readiness_settings set enforcement_active_from = now() - interval '1 minute' where organization_id = $1", [w.orgA]).then(async (r) => {
      if (r.rowCount === 0) await db.admin.query("insert into ogevia.organization_readiness_settings (organization_id, enforcement_active_from) values ($1, now() - interval '1 minute')", [w.orgA]);
    });
    const result = await sweep();
    expect(result.organizations).toBe(1);
    expect(result.failedOrganizations).toBe(0);
    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    // the other agency is still untouched
    const other = (await db.admin.query("select count(*)::int n from ogevia.organization_readiness_settings where organization_id = $1 and enforcement_active_from is not null", [w.orgB])).rows[0].n;
    expect(other).toBe(0);
  });
});
