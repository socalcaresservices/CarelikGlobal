// 0013: a visit is linked to the scheduled shift it delivers; Time Out
// completes the shift; signing a linked visit releases the shift's
// authorization reservation (so the cap never counts the same time twice).
// SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageVisit,
  api,
  asActor,
  createTestDb,
  freshClient,
  orgToday,
  seedWorld,
  visitRow,
  type Actor,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;

type Fixture = { client: string; service: string; auth: string };

async function recordOf(a: Actor, org: string) {
  return (
    await db.admin.query<{ id: string }>(
      "select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2",
      [a.userId, org],
    )
  ).rows[0]!.id;
}

/** A scheduled shift for `a` starting `offsetMin` from now (test setup). */
async function shift(a: Actor, org: string, f: Fixture, offsetMin: number, minutes: number) {
  const record = await recordOf(a, org);
  return (
    await db.admin.query<{ id: string }>(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
       values ($1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(mins => $6 + $7)) returning id`,
      [org, f.client, f.service, a.userId, record, offsetMin, minutes],
    )
  ).rows[0]!.id;
}

/** The reservation an agency assignment holds for `shiftId` (as 0011 creates it). */
async function reserve(a: Actor, org: string, f: Fixture, shiftId: string, minutes: number) {
  const record = await recordOf(a, org);
  const request = (
    await db.admin.query<{ id: string }>(
      `insert into ogevia.care_requests (organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at,
                                         requested_minutes, status, request_key, assigned_shift_id, assigned_caregiver_record_id, assigned_at)
       select $1, $2, $3, a.lineage_id, s.starts_at, s.ends_at, $4, 'assigned', gen_random_uuid(), s.id, $6, now()
       from ogevia.client_authorizations a, ogevia.shifts s where a.id = $5 and s.id = $7 returning id`,
      [org, f.client, f.service, minutes, f.auth, record, shiftId],
    )
  ).rows[0]!.id;
  await db.admin.query(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, $2, $3, $4::date, $5 from ogevia.client_authorizations a where a.id = $6`,
    [org, request, shiftId, await orgToday(db), minutes, f.auth],
  );
  return request;
}

async function shiftStatus(id: string) {
  return (await db.admin.query<{ status: string }>("select status from ogevia.shifts where id = $1", [id])).rows[0]!.status;
}

async function reservation(shiftId: string) {
  return (
    await db.admin.query<{ released_at: Date | null; release_reason: string | null; lineage: string }>(
      "select released_at, release_reason, authorization_lineage_id lineage from ogevia.authorization_reservations where shift_id = $1",
      [shiftId],
    )
  ).rows[0]!;
}

async function usage(lineage: string) {
  return (
    await db.admin.query<{ worked: string; reserved: string }>(
      "select ogevia.authorization_month_usage($1, $2::date) worked, ogevia.care_request_reserved_usage($1, $2::date) reserved",
      [lineage, await orgToday(db)],
    )
  ).rows[0]!;
}

/** Age -> end -> evidence -> drawn client confirmation. */
async function closeVisit(a: Actor, org: string, visit: string, minutes = 60) {
  await ageVisit(db, visit, minutes);
  await api.end(db, a, visit);
  const evidence = await api.registerEvidence(db, a, org, visit);
  return api.confirm(db, a, visit, { evidence });
}

describe("0013 visit <-> scheduled shift link", () => {
  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 600);
  });
  afterAll(async () => db?.drop());

  it("links the caregiver's own in-progress shift and completes it at Time Out", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const s = await shift(w.caregiverA1, w.orgA, f, -30, 210);
    const visit = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service);
    expect((await visitRow(db, visit)).scheduled_shift_id).toBe(s);
    const audit = await db.admin.query(
      "select after_state->>'scheduled_shift_id' shift from ogevia.audit_events where action = 'service_visit.started' and entity_id = $1",
      [visit],
    );
    expect(audit.rows[0]!.shift).toBe(s);

    await ageVisit(db, visit, 60);
    expect(await shiftStatus(s)).toBe("scheduled");
    const ended = await api.end(db, w.caregiverA1, visit);
    expect(ended.worked_minutes).toBe(60);
    expect(await shiftStatus(s)).toBe("completed");
    // Visit records return the linked shift's scheduled window.
    const listed = await asActor(db, w.managerA.sub, async (c) =>
      (await c.query("select * from ogevia_api.list_service_visits($1) where id = $2", [w.orgA, visit])).rows[0]!,
    );
    const sh = (await db.admin.query("select starts_at, ends_at from ogevia.shifts where id = $1", [s])).rows[0]!;
    expect(listed).toMatchObject({ scheduled_shift_id: s, scheduled_starts_at: sh.starts_at, scheduled_ends_at: sh.ends_at });
    // Retry-safe end returns the original visit and leaves the shift completed.
    expect((await api.end(db, w.caregiverA1, visit)).visit_id).toBe(visit);
    expect(await shiftStatus(s)).toBe("completed");

    // The delivered shift is never linked to a second visit.
    const evidence = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
    await api.confirm(db, w.caregiverA1, visit, { evidence });
    const again = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service);
    expect((await visitRow(db, again)).scheduled_shift_id).toBeNull();
    await closeVisit(w.caregiverA1, w.orgA, again);
  });

  it("links a shift starting within the early-arrival window, not one 90 minutes away", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 600);
    const soon = await shift(w.caregiverA2, w.orgA, f, 45, 180);
    const visit = await api.start(db, w.caregiverA2, w.orgA, f.client, f.service);
    expect((await visitRow(db, visit)).scheduled_shift_id).toBe(soon);
    await closeVisit(w.caregiverA2, w.orgA, visit);

    const g = await freshClient(db, w, w.caregiverA2, 600);
    await shift(w.caregiverA2, w.orgA, g, 90, 180);
    const later = await api.start(db, w.caregiverA2, w.orgA, g.client, g.service);
    expect((await visitRow(db, later)).scheduled_shift_id).toBeNull();
    await closeVisit(w.caregiverA2, w.orgA, later);
  });

  it("never links a called-out shift or another caregiver's shift", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 600);
    const calledOut = await shift(w.caregiverA3, w.orgA, f, -30, 210);
    await db.admin.query(
      "insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type) values ($1, $2, 'called_out')",
      [w.orgA, calledOut],
    );
    const visit = await api.start(db, w.caregiverA3, w.orgA, f.client, f.service);
    expect((await visitRow(db, visit)).scheduled_shift_id).toBeNull();
    // An unlinked visit ends exactly as before and leaves shifts alone.
    await closeVisit(w.caregiverA3, w.orgA, visit);
    expect(await shiftStatus(calledOut)).toBe("scheduled");

    const g = await freshClient(db, w, w.caregiverA3, 600);
    const othersShift = await shift(w.caregiverA1, w.orgA, g, -30, 210);
    const mine = await api.start(db, w.caregiverA3, w.orgA, g.client, g.service);
    expect((await visitRow(db, mine)).scheduled_shift_id).toBeNull();
    await closeVisit(w.caregiverA3, w.orgA, mine);
    expect(await shiftStatus(othersShift)).toBe("scheduled");
  });

  it("signing a linked visit releases the shift's reservation, so the cap counts the time once", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const s = await shift(w.caregiverA1, w.orgA, f, -10, 210);
    await reserve(w.caregiverA1, w.orgA, f, s, 210);
    const { lineage } = await reservation(s);
    expect(await usage(lineage)).toEqual({ worked: "0", reserved: "210" });

    const visit = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service);
    expect((await visitRow(db, visit)).scheduled_shift_id).toBe(s);
    const result = await closeVisit(w.caregiverA1, w.orgA, visit, 60);
    expect(result.status).toBe("signed");

    const r = await reservation(s);
    expect(r.released_at).not.toBeNull();
    expect(r.release_reason).toBe("visit_signed");
    // Before 0013 this read worked 60 + reserved 210 for one 60-minute visit.
    expect(await usage(lineage)).toEqual({ worked: "60", reserved: "0" });
    const audit = await db.admin.query(
      "select after_state->>'visit_id' visit from ogevia.audit_events where action = 'authorization_reservation.released' and after_state->>'shift_id' = $1",
      [s],
    );
    expect(audit.rows.map((x) => x.visit)).toEqual([visit]);
  });

  it("keeps the reservation while a linked visit is in administrator review; a correction that signs it releases it", async () => {
    const f = await freshClient(db, w, w.caregiverB1, 240, w.orgB);
    const s = await shift(w.caregiverB1, w.orgB, f, -10, 210);
    await reserve(w.caregiverB1, w.orgB, f, s, 210);
    const visit = await api.start(db, w.caregiverB1, w.orgB, f.client, f.service);
    expect((await visitRow(db, visit)).scheduled_shift_id).toBe(s);

    // 300 worked minutes against a 240-minute month -> administrator review.
    const result = await closeVisit(w.caregiverB1, w.orgB, visit, 300);
    expect(result.status).toBe("administrator_review");
    expect((await reservation(s)).released_at).toBeNull();

    const row = await visitRow(db, visit);
    const timeIn = row.time_in as Date;
    const corrected = await api.correct(
      db, w.managerB, visit, timeIn, new Date(timeIn.getTime() + 200 * 60_000), "Synthetic: actual end time",
    );
    const fixed = await visitRow(db, corrected);
    expect(fixed.status).toBe("signed");
    expect(fixed.scheduled_shift_id).toBe(s);
    const r = await reservation(s);
    expect(r.released_at).not.toBeNull();
    expect(r.release_reason).toBe("visit_signed");
  });

  it("keeps the helper internal and the app's visit functions callable", async () => {
    const { rows } = await db.admin.query(
      `select has_function_privilege('ogevia_app', 'ogevia.match_scheduled_shift_for_visit(uuid,uuid,uuid,uuid,uuid,timestamptz)', 'execute') helper,
              has_function_privilege('ogevia_app', 'ogevia_api.start_ad_hoc_service_visit(uuid,uuid,uuid,text[],text,uuid)', 'execute') start,
              has_function_privilege('ogevia_app', 'ogevia_api.end_service_visit(uuid,text[],text)', 'execute') "end"`,
    );
    expect(rows[0]).toEqual({ helper: false, start: true, end: true });
    // The runtime role still cannot reach the helper directly.
    await expect(
      asActor(db, w.caregiverA1.sub, (c) =>
        c.query("select ogevia.match_scheduled_shift_for_visit(null,null,null,null,null,now())"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
