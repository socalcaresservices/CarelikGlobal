// 0015: a visit manager closes a missed clock-out with the actual Time Out.
// The visit goes back to the caregiver for client confirmation; the manager
// never supplies the confirmation. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
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

const close = (a: Actor, visit: string, timeOut: Date, reason: string, key: string | null = null) =>
  asActor(db, a.sub, async (c) =>
    (await c.query("select * from ogevia_api.close_missed_service_visit($1,$2,$3,$4)", [visit, timeOut, reason, key])).rows[0] as {
      visit_id: string; worked_minutes: number; time_in: Date; time_out: Date;
    },
  );

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe("0015 manager close-out of a missed clock-out", () => {
  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 600);
  });
  afterAll(async () => db?.drop());

  it("closes a visit left open for 30 hours and hands it back for client confirmation", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 5 });
    const record = (await db.admin.query<{ id: string }>(
      "select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [w.caregiverA1.userId, w.orgA],
    )).rows[0]!.id;
    const shift = (await db.admin.query<{ id: string }>(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
       values ($1,$2,$3,$4,$5, now() - interval '30 hours', now() - interval '27 hours') returning id`,
      [w.orgA, f.client, f.service, w.caregiverA1.userId, record],
    )).rows[0]!.id;
    // Started 30 hours ago inside that shift, then forgotten.
    await db.admin.query("update ogevia.shifts set starts_at = now() + interval '5 minutes', ends_at = now() + interval '4 hours' where id = $1", [shift]);
    const visit = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service, null, null);
    await db.admin.query("update ogevia.shifts set starts_at = now() - interval '30 hours', ends_at = now() - interval '27 hours' where id = $1", [shift]);
    expect((await visitRow(db, visit)).scheduled_shift_id).toBe(shift);
    await ageVisit(db, visit, 30 * 60);

    // The caregiver can no longer end it themselves.
    await expectPgError(api.end(db, w.caregiverA1, visit), "OGC09", /open for over 24 hours/);

    await expectPgError(close(w.caregiverA1, visit, hoursAgo(27.2), "Forgot"), "OGA03", /Only a visit manager/);
    await expectPgError(close(w.managerA, visit, hoursAgo(27.2), "   "), "OGV22", /reason is required/);
    await expectPgError(close(w.managerA, visit, new Date(Date.now() + 300_000), "Forgot"), "OGV22", /future/);
    await expectPgError(close(w.managerA, visit, hoursAgo(31), "Forgot"), "OGV22", /after the Time In/);
    await expectPgError(close(w.managerA, visit, hoursAgo(5), "Forgot"), "OGV22", /longer than 24 hours/);
    await expectPgError(close(w.managerB, visit, hoursAgo(27.2), "Forgot"), "OGN04", /Visit not found/);

    const key = randomUUID();
    const timeOut = hoursAgo(27);
    const closed = await close(w.managerA, visit, timeOut, "  Caregiver confirmed by phone  ", key);
    expect(closed.worked_minutes).toBe(180);
    // Retry with the same key returns the stored result instead of an error.
    expect((await close(w.managerA, visit, timeOut, "  Caregiver confirmed by phone  ", key)).visit_id).toBe(visit);
    await expectPgError(close(w.managerA, visit, timeOut, "Again"), "OGC09", /Only an open visit/);

    const row = await visitRow(db, visit);
    expect(row).toMatchObject({
      status: "awaiting_signature",
      worked_minutes: 180,
      time_out_entered_by: w.managerA.userId,
      time_out_reason: "Caregiver confirmed by phone",
      caregiver_attested_at: null,
    });
    expect((await db.admin.query("select status from ogevia.shifts where id = $1", [shift])).rows[0]!.status).toBe("completed");
    const audit = await db.admin.query(
      "select reason, after_state from ogevia.audit_events where action = 'service_visit.closed_by_manager' and entity_id = $1", [visit],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.reason).toBe("Caregiver confirmed by phone");

    // The caregiver's app reopens it at confirmation, flagged as manager-entered.
    const active = await asActor(db, w.caregiverA1.sub, async (c) =>
      (await c.query("select * from ogevia_api.get_active_service_visit($1)", [w.orgA])).rows[0]!,
    );
    expect(active).toMatchObject({ visit_id: visit, visit_status: "awaiting_signature", time_out_entered_by_manager: true });
    const listed = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query("select id, time_out_entered_by_manager from ogevia_api.list_service_visits($1)", [w.orgA])).rows,
    );
    expect(listed.find((r) => r.id === visit)?.time_out_entered_by_manager).toBe(true);
    expect(listed.filter((r) => r.id !== visit).every((r) => r.time_out_entered_by_manager === false)).toBe(true);

    // The caregiver then completes confirmation through the normal path.
    const evidence = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
    const confirmed = await api.confirm(db, w.caregiverA1, visit, { evidence });
    expect(confirmed.status).toBe("signed");
    expect(confirmed.billable_minutes).toBe(180);
  });

  it("refuses a Time Out that overlaps another visit of the caregiver", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 6000, w.orgA, { before: 5, after: 5 });
    const open = await api.start(db, w.caregiverA2, w.orgA, f.client, f.service);
    await ageVisit(db, open, 10 * 60);
    // Another (already signed) visit of the same caregiver 8h-7h ago.
    await db.admin.query(
      `insert into ogevia.service_visits (organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
         caregiver_name_snapshot, service_authorization_id, service_id, service_date, time_in, time_out, worked_minutes,
         verified_minutes, billable_minutes, authorization_status, signed_at, locked_at, status, created_by)
       select v.organization_id, v.client_id, v.client_code_snapshot, v.caregiver_user_id, v.caregiver_record_id,
         v.caregiver_name_snapshot, v.service_authorization_id, v.service_id, v.service_date,
         now() - interval '8 hours', now() - interval '7 hours', 60, 60, 60, 'within_authorization', now(), now(), 'signed', v.created_by
       from ogevia.service_visits v where v.id = $1`,
      [open],
    );
    await expectPgError(close(w.managerA, open, hoursAgo(6), "Forgot"), "OGC09", /overlaps another visit/);
    expect((await close(w.managerA, open, hoursAgo(8.5), "Forgot")).worked_minutes).toBe(90);
  });

  it("keeps the function callable only through the app role", async () => {
    const { rows } = await db.admin.query(
      `select has_function_privilege('ogevia_app', 'ogevia_api.close_missed_service_visit(uuid,timestamptz,text,uuid)', 'execute') app,
              has_function_privilege('public', 'ogevia_api.close_missed_service_visit(uuid,timestamptz,text,uuid)', 'execute') pub`,
    );
    expect(rows[0]).toEqual({ app: true, pub: false });
  });
});
