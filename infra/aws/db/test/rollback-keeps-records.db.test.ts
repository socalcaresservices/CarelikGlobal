// Rollbacks 0026 and 0025 refuse while records they cannot keep exist, and a
// refusal changes nothing. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, seedWorld, type TestDb, type World } from "./harness.js";

const DIR = new URL("../rollback/", import.meta.url);
let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

async function runDown(file: string) {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role ogevia_owner");
    await client.query(readFileSync(new URL(file, DIR), "utf8"));
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
const counts = async () => (await db.admin.query(
  "select (select count(*) from ogevia.shifts) s, (select count(*) from ogevia.authorization_reservations) r, (select count(*) from ogevia.caregiver_invitations) i, (select count(*) from ogevia.caregiver_assignments) a, (select max(version) from ogevia_meta.schema_migrations) v")).rows[0];
const tomorrow = async () => (await db.admin.query("select (now() at time zone o.timezone)::date + 1 as d from ogevia.organizations o where o.id = $1", [w.orgA])).rows[0].d.toISOString().slice(0, 10);

describe("rollbacks keep records", () => {
  it("0026 refuses while a staff-scheduled shift exists; nothing changes", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const d = await tomorrow();
    await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.create_shift($1, $2, $3, $4::date, '09:00', '10:00', null, null)",
      [w.orgA, fresh.client, fresh.service, d]));
    const before = await counts();
    expect(before.v).toBe("0026");
    await expectPgError(runDown("0026_staff_shifts_coverage.down.sql"), "P0001", /ROLLBACK REFUSED: staff-scheduled shifts exist/);
    expect(await counts()).toEqual(before);
  });

  it("0025 refuses while an invitation or a planned assignment exists; nothing changes", async () => {
    // 0026 is first taken back on a copy of the situation without staff shifts.
    await db.admin.query("delete from ogevia.authorization_reservations where care_request_id is null");
    await db.admin.query("delete from ogevia.shifts where created_by is not null");
    await runDown("0026_staff_shifts_coverage.down.sql");
    const [rec] = (await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.create_caregiver($1, 'Synthetic', 'Planned Rollback', null, 'onboarding')", [w.orgA]))).rows;
    await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.create_assignment($1, $2, $3, $4, (now() at time zone 'America/Los_Angeles')::date, null, null)",
      [w.orgA, rec.caregiver_record_id, w.clientA1, w.serviceA]));
    const before = await counts();
    expect(before.v).toBe("0025");
    await expectPgError(runDown("0025_invitations_planned_assignments.down.sql"), "P0001", /ROLLBACK REFUSED: planned assignments/);
    expect(await counts()).toEqual(before);

    const [rec2] = (await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.create_caregiver($1, 'Synthetic', 'Invited Rollback', null, 'ready')", [w.orgA]))).rows;
    await asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia_api.complete_caregiver_invitation($1, $2, 'rollback@example.test', $3, false)",
      [w.orgA, rec2.caregiver_record_id, crypto.randomUUID()]));
    await db.admin.query("update ogevia.caregiver_assignments set is_active = false where caregiver_user_id is null");
    await db.admin.query("delete from ogevia.caregiver_assignments where caregiver_user_id is null");
    const before2 = await counts();
    await expectPgError(runDown("0025_invitations_planned_assignments.down.sql"), "P0001", /ROLLBACK REFUSED: caregiver invitations exist/);
    expect(await counts()).toEqual(before2);
  });
});
