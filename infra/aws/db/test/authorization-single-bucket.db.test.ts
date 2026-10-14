// Accounting: a minute is counted once, as USED or as RESERVED - also for a scheduled visit that is in review with
// billable minutes (the schedule-variance rule of Wave 1, or over the authorization). Migration 0052 (D2, owner-approved
// 2026-10-14). Written FIRST: the tests marked "double count" fail on 0051 and pass after 0052. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string; auth: string };
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const recordOf = async (a: Actor) =>
  (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [a.userId, w.orgA])).rows[0].id as string;
const lineageOf = async (auth: string) =>
  (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [auth])).rows[0].lineage_id as string;

/** A staff shift (the shape create_shift writes) and its reservation, starting a minute ago. */
async function reservedShift(a: Actor, f: Fx, minutes: number) {
  const shift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() - interval '1 minute', now() - interval '1 minute' + make_interval(mins => $6), 'scheduled', a.lineage_id
     from ogevia.client_authorizations a where a.id = $7 returning id`,
    [w.orgA, f.client, f.service, a.userId, await recordOf(a), minutes, f.auth])).rows[0].id as string;
  await db.admin.query(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, null, $2, $3::date, $4 from ogevia.client_authorizations a where a.id = $5`,
    [w.orgA, shift, await orgToday(db), minutes, f.auth]);
  return shift;
}
const counted = async (f: Fx) => {
  const r = (await db.admin.query(
    "select ogevia.authorization_month_usage($1, $2::date) used, ogevia.authorization_month_reserved($1, $2::date) reserved", [await lineageOf(f.auth), await orgToday(db)])).rows[0];
  return { used: Number(r.used), reserved: Number(r.reserved) };
};
const monthStart = async () => `${(await orgToday(db)).slice(0, 7)}-01`;
const summary = async (f: Fx) =>
  (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, await monthStart(), f.client]))[0];
const reservationRow = async (shift: string) =>
  (await db.admin.query("select released_at, release_reason, reserved_minutes from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0];

/** Start on the shift, work `worked` minutes, end, and confirm with a drawn signature (or the given method). */
async function run(a: Actor, f: Fx, worked: number, confirm: { method?: string; reason?: string } = {}) {
  const visit = await api.start(db, a, w.orgA, f.client, f.service, null, null);
  await ageVisit(db, visit, worked);
  await api.end(db, a, visit);
  const method = confirm.method ?? "draw";
  const evidence = method === "draw" ? await api.registerEvidence(db, a, w.orgA, visit) : null;
  const result = await api.confirm(db, a, visit, { method, evidence, reason: confirm.reason ?? null });
  return { visit, result };
}

describe("one bucket: a scheduled visit in review with billable minutes", () => {
  it("double count: worked 60 on a 130-minute shift (schedule rule) is used 60 and NOT also reserved 130", async () => {
    const cg = w.caregiverA1;
    const f = await freshClient(db, w, cg, 600);
    const shift = await reservedShift(cg, f, 130);
    const { visit, result } = await run(cg, f, 60);
    expect(result.status).toBe("administrator_review");
    expect(result.billable_minutes).toBe(60);
    expect(await counted(f)).toEqual({ used: 60, reserved: 0 });
    expect(await summary(f)).toMatchObject({ billable_minutes: 60, reserved_minutes: 0, remaining_minutes: 540 });
    // Nothing stored is changed: visit status, billable minutes and the reservation row are as they were.
    expect((await db.admin.query("select status, billable_minutes, scheduled_shift_id from ogevia.service_visits where id = $1", [visit])).rows[0])
      .toEqual({ status: "administrator_review", billable_minutes: 60, scheduled_shift_id: shift });
    expect(await reservationRow(shift)).toEqual({ released_at: null, release_reason: null, reserved_minutes: 130 });
  });

  it("double count: over the authorization (billable capped at 100 of 150 worked) is used 100, not also reserved", async () => {
    const cg = w.caregiverA2;
    const f = await freshClient(db, w, cg, 100);
    const shift = await reservedShift(cg, f, 150);
    const { result } = await run(cg, f, 150);
    expect(result).toMatchObject({ status: "administrator_review", worked_minutes: 150, billable_minutes: 100 });
    expect(await counted(f)).toEqual({ used: 100, reserved: 0 });
    expect(await reservationRow(shift)).toMatchObject({ released_at: null });
  });

  it("double count: the freed capacity is real - a new 180-minute shift fits (60 used + 180 <= 300) while the review is open", async () => {
    const cg = w.caregiverA3;
    const f = await freshClient(db, w, cg, 300);
    await reservedShift(cg, f, 130);
    await run(cg, f, 60);
    const day = (await db.admin.query("select to_char(($1::date + 2), 'YYYY-MM-DD') d", [await orgToday(db)])).rows[0].d as string;
    const created = await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'12:00'::time,null,null)", [w.orgA, f.client, f.service, day]);
    expect(created[0].shift_id).toBeTruthy();
    expect(await counted(f)).toEqual({ used: 60, reserved: 180 });
    // ... and the cap still holds: 60 used + 180 reserved leaves 60, so a 120-minute shift is refused.
    await expect(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'13:00'::time,'15:00'::time,null,null)", [w.orgA, f.client, f.service, day])).rejects.toThrow();
  });

  it("a review decision does not move minutes between buckets: accept-as-worked keeps one bucket, and approval stays within billable", async () => {
    const cg = w.caregiverB1 ?? w.caregiverA1;
    const f = await freshClient(db, w, w.caregiverA1, 600);
    await reservedShift(w.caregiverA1, f, 130);
    const { visit } = await run(w.caregiverA1, f, 60);
    await q(w.managerA, "select ogevia_api.decide_visit_review($1, 'accept_capped_billable', 'Valid visit (synthetic)', null) as id", [visit]);
    expect(await counted(f)).toEqual({ used: 60, reserved: 0 });
    await q(w.managerA, "select ogevia_api.approve_visit_for_billing($1, 60, null, null) as id", [visit]);
    expect(await counted(f)).toEqual({ used: 60, reserved: 0 });
    expect(cg).toBeTruthy();
  });

  it("CHARACTERIZATION (unchanged by 0052): closing a review as not billable leaves the visit's billable minutes, so they stay in used, still once", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 600);
    await reservedShift(w.caregiverA2, f, 130);
    const { visit } = await run(w.caregiverA2, f, 60);
    await q(w.managerA, "select ogevia_api.decide_visit_review($1, 'close_not_billable', 'Not a valid visit (synthetic)', null) as id", [visit]);
    const c = await counted(f);
    expect(c.reserved).toBe(0);
    expect(c.used + c.reserved).toBe(c.used);
  });

  it("a correction that makes the visit match its shift signs it, releases the reservation, and still counts once", async () => {
    // Test setup only: earlier tests left this caregiver's other synthetic visits in the same hours; a correction may not overlap them.
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query("update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = $1, void_reason = 'Synthetic test cleanup' where caregiver_user_id = $1 and status in ('administrator_review','signed','draft','awaiting_signature')", [w.caregiverA3.userId]);
    } finally { await c.query("reset session_replication_role"); c.release(); }
    const f = await freshClient(db, w, w.caregiverA3, 600);
    const shift = await reservedShift(w.caregiverA3, f, 130);
    const { visit } = await run(w.caregiverA3, f, 60);
    const row = (await db.admin.query("select time_in from ogevia.service_visits where id = $1", [visit])).rows[0];
    const timeIn = row.time_in as Date;
    // 130 minutes (the shift's length), ending 5 minutes ago: the visit now matches its shift.
    await api.correct(db, w.managerA, visit, new Date(timeIn.getTime() - 70 * 60_000), new Date(timeIn.getTime() + 60 * 60_000 - 5 * 60_000), "Synthetic: actual times");
    expect(await counted(f)).toEqual({ used: 125, reserved: 0 });
    expect(await reservationRow(shift)).toMatchObject({ release_reason: "visit_signed" });
  });
});

describe("controls: the cases that must not change", () => {
  it("signed inside the rule: reservation released at signing, 120 used, once", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const shift = await reservedShift(w.caregiverA1, f, 120);
    const { result } = await run(w.caregiverA1, f, 120);
    expect(result.status).toBe("signed");
    expect(await counted(f)).toEqual({ used: 120, reserved: 0 });
    expect(await reservationRow(shift)).toMatchObject({ release_reason: "visit_signed" });
  });

  it("no billable minutes (client did not confirm): the shift's minutes stay reserved, nothing is used", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 600);
    await reservedShift(w.caregiverA2, f, 120);
    const { result } = await run(w.caregiverA2, f, 60, { method: "unable_to_confirm", reason: "Client asleep (synthetic)" });
    expect(result).toMatchObject({ status: "administrator_review", billable_minutes: 0 });
    expect(await counted(f)).toEqual({ used: 0, reserved: 120 });
    expect(await summary(f)).toMatchObject({ reserved_minutes: 120, remaining_minutes: 480 });
  });

  it("another shift for the same client stays reserved while one visit is in review", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 600);
    await reservedShift(w.caregiverA3, f, 120);
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status, authorization_lineage_id)
       select $1,$2,$3, now() + interval '2 days', now() + interval '2 days 3 hours', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $4`, [w.orgA, f.client, f.service, f.auth]);
    const other = (await db.admin.query("select id from ogevia.shifts where client_id = $1 order by starts_at desc limit 1", [f.client])).rows[0].id as string;
    await db.admin.query(
      `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, shift_id, service_date, reserved_minutes)
       select $1, a.lineage_id, $2, $3::date, 180 from ogevia.client_authorizations a where a.id = $4`, [w.orgA, other, await orgToday(db), f.auth]);
    await run(w.caregiverA3, f, 60);
    expect(await counted(f)).toEqual({ used: 60, reserved: 180 });
  });
});
