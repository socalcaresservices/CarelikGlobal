// 0081 Owner corrections to Batch 2, items 1, 2 and 4 (hours). SYNTHETIC data only.
//   1. PENDING HOURS: worked time that is Pending with NO reservation (an unscheduled visit awaiting confirmation or in review) must still count as consumed when
//      deciding whether more work fits (create, reschedule, series, assign, pickup, care request, make-up), without weakening the lineage lock or idempotency.
//   2. CLOSED, NOT BILLABLE: a review closed as not billable is not "Pending"; its worked time stays visible, its hold (if it has one) is counted in Reserved on its own line.
//   4. WORKED, NOT BILLABLE: time worked beyond billable cannot make later overbooking possible; rounding is counted exactly once.
// Each test names the exact numbers. Dates are agency-local "today"/"tomorrow" in the current month (a test is skipped on the last day of a month, when tomorrow is in the next one).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let tomorrow: string;
let sameMonth: boolean;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  tomorrow = (await db.admin.query<{ d: string }>("select to_char($1::date + 1, 'YYYY-MM-DD') d", [today])).rows[0]!.d;
  sameMonth = tomorrow.slice(0, 7) === today.slice(0, 7);
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string; auth: string; cg: Actor; lineage: string; authorized: number };
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
async function person(): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Pat Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, userId]);
  await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Pat')", [w.orgA, userId, "CG-" + sub.slice(0, 6)]);
  return { userId, sub };
}
async function fx(minutes: number): Promise<Fx> {
  const cg = await person();
  const f = await freshClient(db, w, cg, minutes);
  const lineage = (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id as string;
  return { ...f, cg, lineage, authorized: minutes };
}
const recordOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [a.userId, w.orgA])).rows[0].id as string;
const monthStart = () => `${today.slice(0, 7)}-01`;
const hhmm = (startMin: number, minutes: number) => {
  const f = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [f(startMin), f(startMin + minutes)] as const;
};
/** A shift made the real way (an open shift unless a caregiver record is given). 09:00 + minutes. */
const createShift = (f: Fx, minutes: number, day = tomorrow, startMin = 9 * 60, rec: string | null = null, key: string | null = randomUUID()) => {
  const [s, e] = hhmm(startMin, minutes);
  return q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,$8)", [w.orgA, f.client, f.service, day, s, e, rec, key]).then((r) => r[0]);
};
/** Start, work `worked` minutes, end; then optionally confirm. Unscheduled by default (no shift, no reservation). */
async function visit(f: Fx, worked: number, how: { confirm?: "draw" | "unable_to_confirm" | null; scheduled?: boolean } = {}) {
  const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, how.scheduled ? undefined : "Client asked for extra help (synthetic)");
  await ageVisit(db, v, worked);
  await api.end(db, f.cg, v);
  if (how.confirm === "draw") await api.confirm(db, f.cg, v, { method: "draw", evidence: await api.registerEvidence(db, f.cg, w.orgA, v) });
  if (how.confirm === "unable_to_confirm") await api.confirm(db, f.cg, v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  return v;
}
const close = (v: string) => q(w.managerA, "select ogevia_api.decide_visit_review($1, 'close_not_billable', 'Not a valid visit (synthetic)', null) as id", [v]);
const summary = async (f: Fx) => (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, monthStart(), f.client]))[0];
const hb = async (f: Fx) => (await db.admin.query("select * from ogevia.hours_breakdown($1, $2::date) where lineage_id = $3", [w.orgA, monthStart(), f.lineage])).rows[0];
const reserved = async (f: Fx) => Number((await db.admin.query("select ogevia.authorization_month_reserved($1, $2::date) n", [f.lineage, tomorrow])).rows[0].n);
const equation = (s: any) => s.hours_billable_minutes + s.hours_rounding_minutes + s.hours_pending_minutes + s.hours_reserved_minutes + s.hours_left_minutes;
const skipUnlessSameMonth = (ctx: { skip: () => void }) => { if (!sameMonth) ctx.skip(); };

describe("item 1: unreserved Pending time counts as consumed when deciding whether more work fits", () => {
  it("create_shift: authorized 600, an unscheduled visit awaiting confirmation worked 45 (Pending 45, Hours left 555): a 560-minute shift is refused, 555 fits, then 15 more does not", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await visit(f, 45, { confirm: null });
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 45, hours_pending_unreserved_minutes: 45, hours_left_minutes: 555 });
    await expectPgError(createShift(f, 560), "OGC09", /available/i);
    expect(await createShift(f, 555)).toMatchObject({ reserved_minutes: 555 });
    const after = await summary(f);
    expect(after).toMatchObject({ hours_pending_minutes: 45, hours_reserved_minutes: 555, hours_left_minutes: 0, hours_over_limit_minutes: 0 });
    expect(equation(after)).toBe(600);
    await expectPgError(createShift(f, 15, tomorrow, 20 * 60), "OGC09", /available/i);
  });

  it("create_shift: the same 45 minutes in administrator review with no signer (unscheduled) also count: 560 refused", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await visit(f, 45, { confirm: "unable_to_confirm" });
    expect(await summary(f)).toMatchObject({ hours_pending_unreserved_minutes: 45, hours_left_minutes: 555 });
    await expectPgError(createShift(f, 560), "OGC09", /available/i);
    expect(await createShift(f, 555)).toMatchObject({ reserved_minutes: 555 });
  });

  it("no double count: a pending visit that HOLDS a reservation (130-minute shift, worked 60) is counted once (130): 470 fits, 480 does not", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const shift = (await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
       select $1,$2,$3,$4,$5, now() - interval '1 minute', now() + interval '129 minutes', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
      [w.orgA, f.client, f.service, f.cg.userId, await recordOf(f.cg), f.auth])).rows[0].id as string;
    await db.admin.query(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
       select $1, a.lineage_id, null, $2, $3::date, 130 from ogevia.client_authorizations a where a.id = $4`, [w.orgA, shift, today, f.auth]);
    const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, null);
    await ageVisit(db, v, 60);
    await api.end(db, f.cg, v);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 130, hours_pending_unreserved_minutes: 0, hours_left_minutes: 470 });
    expect(Number((await db.admin.query("select ogevia.authorization_month_pending_unreserved($1, $2::date) n", [f.lineage, today])).rows[0].n)).toBe(0);
    await expectPgError(createShift(f, 480), "OGC09", /available/i);
    expect(await createShift(f, 470)).toMatchObject({ reserved_minutes: 470 });
  });

  it("rounding counts once in the guard: signed 50 + rounding +10 leaves 540: a 545-minute shift is refused, 540 fits", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 50, { confirm: "draw", scheduled: true }); // on a 50-minute shift: signed, its reservation released
    expect(await summary(f)).toMatchObject({ hours_billable_minutes: 50, hours_left_minutes: 550 });
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica"); // fixture row; the product path (approve_billing_rounding) is covered by rounding.db.test.ts
      await c.query(
        `insert into ogevia.billing_rounding_adjustments (organization_id, unit_kind, visit_id, authorization_lineage_id, client_id, service_id, service_date, policy_id,
           covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
         values ($1,'visit',$2,$3,$4,$5,$6::date,$7,array[$2::uuid],50,60,10,false,$8)`,
        [w.orgA, v, f.lineage, f.client, f.service, today, randomUUID(), w.managerA.userId]);
    } finally { await c.query("reset session_replication_role"); c.release(); }
    const s = await summary(f);
    expect(s).toMatchObject({ hours_billable_minutes: 50, hours_rounding_minutes: 10, hours_left_minutes: 540 });
    expect(Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [f.lineage, today])).rows[0].n)).toBe(60); // 50 + 10, once
    expect(await reserved(f)).toBe(0); // rounding is not in the reserved total, and not in the pending term
    await expectPgError(createShift(f, 545), "OGC09", /available/i);
    expect(await createShift(f, 540)).toMatchObject({ reserved_minutes: 540 });
    const after = await summary(f);
    expect(after).toMatchObject({ hours_rounding_minutes: 10, hours_left_minutes: 0 });
    expect(equation(after)).toBe(600);
  });

  it("reschedule_shift: a 60-minute shift moved to 560 is refused while 45 are Pending (45 + 560 > 600) and moved to 555 is accepted", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const made = await createShift(f, 60);
    await visit(f, 45, { confirm: null });
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 45, hours_reserved_minutes: 60, hours_left_minutes: 495 });
    await expectPgError(q(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'09:00'::time,'18:20'::time,'Synthetic: longer visit',null)", [w.orgA, made.shift_id, tomorrow]), "OGC09", /available/i);
    expect((await q(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'09:00'::time,'18:15'::time,'Synthetic: longer visit',null)", [w.orgA, made.shift_id, tomorrow]))[0]).toMatchObject({ reserved_minutes: 555 });
    expect(equation(await summary(f))).toBe(600);
  });

  it("create_shift_series: one occurrence of 560 minutes is refused (nothing saved) while 45 are Pending; 555 is saved", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await visit(f, 45, { confirm: null });
    const dow = (await db.admin.query<{ d: number }>("select extract(dow from $1::date)::int d", [tomorrow])).rows[0]!.d;
    const series = (minutes: number) => {
      const [s, e] = hhmm(9 * 60, minutes);
      return q(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,null,$4::smallint[],$5::time,$6::time,$7::date,$7::date,'refuse',null)", [w.orgA, f.client, f.service, [dow], s, e, tomorrow]).then((r) => r[0]);
    };
    await expectPgError(series(560), "OGC09", /exceeds authorization/i);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_series where client_id = $1", [f.client])).rows[0].n).toBe(0);
    expect(await series(555)).toMatchObject({ created: 1, reserved_minutes: 555 });
  });

  it("assign_shift_caregiver and pickup share assert_shift_authorization_covered: an open 300-minute shift fits 600 alone, but once 400 minutes are Pending (700 > 600) assigning is refused and the check names the overage", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const open = await createShift(f, 300);
    const assignee = await person();
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, assignee.userId, f.client, f.service, today]);
    await db.admin.query("select ogevia.assert_shift_authorization_covered($1)", [open.shift_id]); // fits now
    await visit(f, 400, { confirm: null });
    await expectPgError(db.admin.query("select ogevia.assert_shift_authorization_covered($1)", [open.shift_id]), "OGC09", /Authorization no longer covers this shift \(1 hr 40 min over\)/);
    await expectPgError(q(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic fill',$4)", [w.orgA, open.shift_id, await recordOf(assignee), randomUUID()]), "OGC09", /no longer covers/i);
    expect((await db.admin.query("select caregiver_record_id from ogevia.shifts where id = $1", [open.shift_id])).rows[0].caregiver_record_id).toBeNull();
  });

  it("care requests use the same figure: care_request_reserved_usage adds the 45 unreserved Pending minutes to the reserved ones (0 before 0081)", async () => {
    const f = await fx(600);
    await visit(f, 45, { confirm: null });
    const n = Number((await db.admin.query("select ogevia.care_request_reserved_usage($1, $2::date, null) n", [f.lineage, today])).rows[0].n);
    expect(n).toBe(45);
    expect(Number((await db.admin.query("select ogevia.authorization_month_reserved($1, $2::date) n", [f.lineage, today])).rows[0].n)).toBe(45);
  });

  it("the guard's pending figure equals the Hours breakdown's Pending-unreserved figure in every state it can be in", async () => {
    const f = await fx(600);
    const guard = async () => Number((await db.admin.query("select ogevia.authorization_month_pending_unreserved($1, $2::date) n", [f.lineage, today])).rows[0].n);
    expect([await guard(), (await hb(f))?.pending_unreserved_minutes ?? 0]).toEqual([0, 0]);
    const v1 = await visit(f, 45, { confirm: null });
    expect([await guard(), (await hb(f)).pending_unreserved_minutes]).toEqual([45, 45]);
    await api.confirm(db, f.cg, v1, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" }); // now in review with nothing billable: still the same 45
    expect([await guard(), (await hb(f)).pending_unreserved_minutes]).toEqual([45, 45]);
    await visit(f, 30, { confirm: "draw" }); // unscheduled and signed by the client: goes to review CARRYING 30 billable minutes: counted by usage, not as unreserved Pending
    expect([await guard(), (await hb(f)).pending_unreserved_minutes]).toEqual([45, 45]);
    expect(Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [f.lineage, today])).rows[0].n)).toBe(30);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 75, hours_left_minutes: 525 });
  });
});

describe("item 1: the lineage lock and idempotency still decide a race for the last minutes", () => {
  it("two simultaneous 300-minute reservations race for the 555 left (600 - 45 Pending): exactly one succeeds, the other is refused, and the authorization is never over", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await visit(f, 45, { confirm: null });
    const res = await Promise.allSettled([createShift(f, 300, tomorrow, 6 * 60), createShift(f, 300, tomorrow, 12 * 60)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "OGC09" });
    const s = await summary(f);
    expect(s).toMatchObject({ hours_reserved_minutes: 300, hours_pending_minutes: 45, hours_left_minutes: 255, hours_over_limit_minutes: 0 });
    expect(equation(s)).toBe(600);
  });

  it("six simultaneous 100-minute reservations race for 555: exactly five succeed (500), one is refused, Hours left 55, never over", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await visit(f, 45, { confirm: null });
    const res = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => createShift(f, 100, tomorrow, (1 + i * 3) * 60)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect((res.filter((r) => r.status === "rejected") as PromiseRejectedResult[]).every((r) => r.reason?.code === "OGC09")).toBe(true);
    expect(await summary(f)).toMatchObject({ hours_reserved_minutes: 500, hours_left_minutes: 55, hours_over_limit_minutes: 0 });
  });

  it("the same idempotency key sent twice at once creates ONE shift and returns the same answer", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await visit(f, 45, { confirm: null });
    const key = randomUUID();
    const res = await Promise.allSettled([createShift(f, 300, tomorrow, 6 * 60, null, key), createShift(f, 300, tomorrow, 6 * 60, null, key)]);
    const ok = res.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    if (ok.length === 2) expect(ok[0]!.value.shift_id).toBe(ok[1]!.value.shift_id);
    expect((await db.admin.query("select count(*)::int n from ogevia.shifts where client_id = $1", [f.client])).rows[0].n).toBe(1);
    expect(await summary(f)).toMatchObject({ hours_reserved_minutes: 300 });
  });
});

describe("item 2: a review closed as not billable is not Pending", () => {
  async function closedOnShift() {
    const f = await fx(600);
    const shift = (await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
       select $1,$2,$3,$4,$5, now() - interval '1 minute', now() + interval '129 minutes', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
      [w.orgA, f.client, f.service, f.cg.userId, await recordOf(f.cg), f.auth])).rows[0].id as string;
    await db.admin.query(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
       select $1, a.lineage_id, null, $2, $3::date, 130 from ogevia.client_authorizations a where a.id = $4`, [w.orgA, shift, today, f.auth]);
    const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, null);
    await ageVisit(db, v, 60);
    await api.end(db, f.cg, v);
    await api.confirm(db, f.cg, v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
    return { f, shift, v };
  }

  it("scheduled visit: WHY the reservation stays: reservation_bucket still answers held_review, and nothing releases it (reconcile refuses a shift with a visit)", async () => {
    const { f, shift, v } = await closedOnShift();
    const res = async () => (await db.admin.query("select r.id, r.released_at, ogevia.reservation_bucket(r.id) b from ogevia.authorization_reservations r where r.shift_id = $1", [shift])).rows[0];
    expect(await res()).toMatchObject({ released_at: null, b: "held_review" }); // awaiting the review decision
    await close(v);
    expect(await res()).toMatchObject({ released_at: null, b: "held_review" }); // closing as not billable does not touch the reservation (0013 releases only at signing)
    await expectPgError(q(w.managerA, "select ogevia_api.reconcile_ended_shift($1,$2,'no_service_delivered','Checked with the family (synthetic)',null)", [w.orgA, shift]), "OGC09", /A visit exists/);
    expect(await res()).toMatchObject({ released_at: null });
    // policy-neutral: still consumes the authorization exactly as before (not billing, not released)
    expect(await reserved(f)).toBe(130);
  });

  it("scheduled visit: Hours breakdown shows it as 'Closed, not billable': Pending 0, its 130 held minutes in Reserved on their own line, worked 60 visible; the equation is exact", async () => {
    const { f, v } = await closedOnShift();
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 130, hours_reserved_minutes: 0, hours_left_minutes: 470 }); // before the decision: awaiting the review
    await close(v);
    const s = await summary(f);
    expect(s).toMatchObject({
      hours_pending_minutes: 0, hours_pending_held_minutes: 0, hours_pending_unreserved_minutes: 0,
      hours_reserved_minutes: 130, hours_closed_not_billable_held_minutes: 130, hours_closed_not_billable_worked_minutes: 60,
      hours_worked_not_billable_minutes: 60, hours_left_minutes: 470, hours_billable_minutes: 0, hours_over_limit_minutes: 0,
    });
    expect(equation(s)).toBe(600);
    expect(s.reserved_minutes).toBe(130); // the old total keeps its exact meaning
    // the worked time and the audit history are preserved
    const row = (await db.admin.query("select worked_minutes, status from ogevia.service_visits where id = $1", [v])).rows[0];
    expect(row).toMatchObject({ worked_minutes: 60, status: "administrator_review" });
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_review_decisions where visit_id = $1 and decision = 'close_not_billable' and revoked_at is null", [v])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1", [v])).rows[0].n).toBeGreaterThan(0);
  });

  it("unscheduled visit: closed leaves Pending (45 -> 0), shows Worked, not billable 45 and 'Closed, not billable' worked 45; it consumes nothing, so all 600 can be scheduled", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 45, hours_left_minutes: 555 });
    await close(v);
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 0, hours_closed_not_billable_held_minutes: 0, hours_closed_not_billable_worked_minutes: 45, hours_worked_not_billable_minutes: 45, hours_left_minutes: 600 });
    expect(equation(s)).toBe(600);
    expect(await createShift(f, 600, tomorrow, 0)).toMatchObject({ reserved_minutes: 600 }); // POLICY (documented): time the office closed as not billable does not consume authorization
  });

  it("nothing else releases it either: cancelling the shift is refused while the visit exists, so the hold stays until a policy decision (open question for the owner)", async () => {
    const { shift, v } = await closedOnShift();
    await close(v);
    await expectPgError(q(w.managerA, "select * from ogevia_api.cancel_shift($1,$2,'Synthetic: client unwell',null)", [w.orgA, shift]), "OGC09", /no longer scheduled|visit is linked to this shift/);
  });
});

describe("item 4: worked, not billable cannot make later overbooking possible", () => {
  it("worked 150 on an authorization of 100 (billable capped at 100, Worked not billable 50): the 100 stay consumed before and after the office accepts the capped minutes, so not even 15 more minutes can be scheduled", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const v = await visit(f, 150, { confirm: "draw" });
    let s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 100, hours_worked_not_billable_minutes: 50, hours_left_minutes: 0 });
    await expectPgError(createShift(f, 15), "OGC09", /available/i); // Pending 100 (billable carried by the review) is already consumption
    await q(w.managerA, "select ogevia_api.decide_visit_review($1, 'accept_capped_billable', 'Accepted the capped time (synthetic)', null) as id", [v]);
    s = await summary(f);
    expect(s).toMatchObject({ hours_billable_minutes: 0, hours_pending_minutes: 100, hours_worked_not_billable_minutes: 50, hours_left_minutes: 0, hours_over_limit_minutes: 0 }); // a review decision never changes the visit: it still carries 100 (Pending)
    expect(equation(s)).toBe(100);
    await expectPgError(createShift(f, 15), "OGC09", /available/i);
  });

  it("rounding is not double counted across the new buckets: Billable 50 + Rounding 10 + Pending 45 + Reserved 100 + Hours left 395 = 600, rounding in exactly one line", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const signed = await visit(f, 50, { confirm: "draw", scheduled: true });
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query(
        `insert into ogevia.billing_rounding_adjustments (organization_id, unit_kind, visit_id, authorization_lineage_id, client_id, service_id, service_date, policy_id,
           covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
         values ($1,'visit',$2,$3,$4,$5,$6::date,$7,array[$2::uuid],50,60,10,false,$8)`,
        [w.orgA, signed, f.lineage, f.client, f.service, today, randomUUID(), w.managerA.userId]);
    } finally { await c.query("reset session_replication_role"); c.release(); }
    await visit(f, 45, { confirm: null });
    await createShift(f, 100);
    const s = await summary(f);
    expect(s).toMatchObject({ hours_billable_minutes: 50, hours_rounding_minutes: 10, hours_pending_minutes: 45, hours_reserved_minutes: 100, hours_left_minutes: 395 });
    expect(equation(s)).toBe(600);
    const b = await hb(f);
    expect(b.rounding_minutes).toBe(10);
    // the guard's view of the same authorization: usage (50 + 10) + reserved 100 + pending 45
    const usage = Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [f.lineage, today])).rows[0].n);
    expect(usage + (await reserved(f))).toBe(60 + 100 + 45);
  });
});
