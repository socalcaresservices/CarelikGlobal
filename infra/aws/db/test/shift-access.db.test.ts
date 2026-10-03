// 0014: a caregiver can clock in for a client they are scheduled to serve
// now, without a standing assignment (e.g. a Care Request replacement).
// Access comes only from the live shift and ends with it. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageVisit,
  api,
  asActor,
  createTestDb,
  expectPgError,
  freshClient,
  seedWorld,
  visitRow,
  type Actor,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;

type Fixture = { client: string; service: string; auth: string };

async function recordOf(a: Actor) {
  return (
    await db.admin.query<{ id: string }>(
      "select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2",
      [a.userId, w.orgA],
    )
  ).rows[0]!.id;
}

/** A scheduled shift for `a` (test setup, as a Care Request assignment writes it). */
async function shift(a: Actor, f: Fixture, offsetMin: number, minutes = 210) {
  return (
    await db.admin.query<{ id: string }>(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
       values ($1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(mins => $6 + $7)) returning id`,
      [w.orgA, f.client, f.service, a.userId, await recordOf(a), offsetMin, minutes],
    )
  ).rows[0]!.id;
}

async function pickerClients(a: Actor) {
  return asActor(db, a.sub, async (c) =>
    (await c.query<{ client_id: string; active_service_count: number }>(
      "select client_id, active_service_count from ogevia_api.list_assigned_visit_clients($1)", [w.orgA],
    )).rows,
  );
}

async function pickerServices(a: Actor, client: string) {
  return asActor(db, a.sub, async (c) =>
    (await c.query<{ service_id: string }>(
      "select service_id from ogevia_api.list_authorized_services_for_client($1,$2)", [w.orgA, client],
    )).rows.map((r) => r.service_id),
  );
}

const refused = (a: Actor, f: Fixture) =>
  expectPgError(api.start(db, a, w.orgA, f.client, f.service), "OGA03", /not assigned to you/);

describe("0014 clock-in from a scheduled shift without a standing assignment", () => {
  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 600);
  });
  afterAll(async () => db?.drop());

  it("lets a replacement caregiver clock in for the shift, and only while it lasts", async () => {
    // The client is standing-assigned to A1 only; A2 is the replacement.
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const s = await shift(w.caregiverA1, f, -15);
    await refused(w.caregiverA2, f);
    expect((await pickerClients(w.caregiverA2)).map((r) => r.client_id)).not.toContain(f.client);

    // Agency reassigns the shift (as assign_care_request does on replacement).
    await db.admin.query(
      "update ogevia.shifts set caregiver_user_id = $2, caregiver_record_id = $3 where id = $1",
      [s, w.caregiverA2.userId, await recordOf(w.caregiverA2)],
    );
    const listed = (await pickerClients(w.caregiverA2)).find((r) => r.client_id === f.client);
    expect(listed?.active_service_count).toBe(1);
    expect(await pickerServices(w.caregiverA2, f.client)).toEqual([f.service]);

    const visit = await api.start(db, w.caregiverA2, w.orgA, f.client, f.service);
    expect((await visitRow(db, visit)).scheduled_shift_id).toBe(s);
    await ageVisit(db, visit, 60);
    await api.end(db, w.caregiverA2, visit);
    const evidence = await api.registerEvidence(db, w.caregiverA2, w.orgA, visit);
    await api.confirm(db, w.caregiverA2, visit, { evidence });

    // Shift delivered (completed) -> access is gone; nothing to revoke.
    await refused(w.caregiverA2, f);
    expect((await pickerClients(w.caregiverA2)).map((r) => r.client_id)).not.toContain(f.client);
    // A1 keeps the standing assignment.
    expect((await pickerClients(w.caregiverA1)).map((r) => r.client_id)).toContain(f.client);
  });

  it("gives nothing for a shift 90 minutes away, a called-out shift, or someone else's shift", async () => {
    const later = await freshClient(db, w, w.caregiverA1, 600);
    await shift(w.caregiverA3, later, 90);
    await refused(w.caregiverA3, later);

    const calledOut = await freshClient(db, w, w.caregiverA1, 600);
    const s = await shift(w.caregiverA3, calledOut, -15);
    await db.admin.query(
      "insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type) values ($1,$2,'called_out')",
      [w.orgA, s],
    );
    await refused(w.caregiverA3, calledOut);

    const others = await freshClient(db, w, w.caregiverA1, 600);
    await shift(w.caregiverA1, others, -15);
    await refused(w.caregiverA3, others);

    const picker = (await pickerClients(w.caregiverA3)).map((r) => r.client_id);
    expect(picker).not.toContain(later.client);
    expect(picker).not.toContain(calledOut.client);
    expect(picker).not.toContain(others.client);
  });

  it("keeps the new helpers internal", async () => {
    const { rows } = await db.admin.query(
      `select has_function_privilege('ogevia_app', 'ogevia.caregiver_has_current_shift(uuid,uuid,uuid)', 'execute') shift_access,
              has_function_privilege('ogevia_app', 'ogevia.visit_shift_early_arrival()', 'execute') win,
              has_function_privilege('ogevia_app', 'ogevia_api.list_assigned_visit_clients(uuid)', 'execute') picker`,
    );
    expect(rows[0]).toEqual({ shift_access: false, win: false, picker: true });
    await expect(
      asActor(db, w.caregiverA2.sub, (c) => c.query("select ogevia.caregiver_has_current_shift(null,null,null)")),
    ).rejects.toThrow(/permission denied/);
  });
});
