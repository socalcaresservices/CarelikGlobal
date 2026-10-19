// OWNER HOURS RULE (approved 2026-10-18): pay ALL actual hours worked; warn about overages; NEVER bill beyond the monthly authorized hours.
// Ogevia is not the payroll system: worked minutes are kept exactly as recorded (time out minus time in) and are never reduced by a billing cap.
// Decisions proven here (migration 0083 for D1 reopen and D3; D2 and D4 are behaviours that already hold and are pinned):
//   D1  ending a visit / closing a missed visit with no capacity left is ACCEPTED (Over limit shown); REOPENING (revoke) is REFUSED when it would take committed minutes
//       (Billable + Rounding + Pending + Reserved) above the authorization of that lineage-month, and stays allowed when it fits or adds nothing.
//   D2  closing a review as not billable does NOT release the shift reservation (pinned).
//   D3  correcting a visit with an active close is refused (also asserted in review-reopen-accounting.db.test.ts).
//   D4  a draft/open unscheduled visit holds NO provisional time.
// Then the rule is checked path by path: Billable + Rounding never exceeds Authorized per lineage-month; worked minutes stay exact. SYNTHETIC data only.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let tomorrow: string;
let sameMonth: boolean;
const PAYER = "SYNTHETIC-PAYER";
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  tomorrow = (await db.admin.query<{ d: string }>("select to_char($1::date + 1, 'YYYY-MM-DD') d", [today])).rows[0]!.d;
  sameMonth = tomorrow.slice(0, 7) === today.slice(0, 7);
  await q(w.ownerA, "select * from ogevia_api.set_billing_rounding_policy($1, $2, $3, 'up', 15, 'per_visit', 'Synthetic payer manual 7.1', '2026-01-15'::date, '2026-01-01'::date, 'Synthetic policy', null)", [w.orgA, PAYER, w.serviceA]);
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string; auth: string; cg: Actor; lineage: string; authorized: number };
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function person(): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Pat Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, userId]);
  await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Pat')", [w.orgA, userId, "CG-" + sub.slice(0, 6)]);
  await db.admin.query(`insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at)
    select r.id, r.organization_id, 'completed', 'approved', 'Synthetic fixture clearance', $2, now() from ogevia.caregiver_records r where r.linked_user_id = $1 and r.organization_id = $3`, [userId, w.ownerA.userId, w.orgA]);
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
const summary = async (f: Fx) => (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, monthStart(), f.client]))[0];
const usage = async (f: Fx) => Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [f.lineage, today])).rows[0].n); // Billable + Rounding (+ review-carried)
const reservedTotal = async (f: Fx) => Number((await db.admin.query("select ogevia.authorization_month_reserved($1, $2::date) n", [f.lineage, today])).rows[0].n);
const hhmm = (startMin: number, minutes: number) => {
  const p = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [p(startMin), p(startMin + minutes)] as const;
};
const tryShift = (f: Fx, minutes: number, startMin = 8 * 60) => {
  const [s, e] = hhmm(startMin, minutes);
  return q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,$7)", [w.orgA, f.client, f.service, tomorrow, s, e, randomUUID()]);
};
async function reservedShift(f: Fx, minutes: number, startMin = -1) {
  const shift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(mins => $6 + $7), 'scheduled', a.lineage_id
     from ogevia.client_authorizations a where a.id = $8 returning id`,
    [w.orgA, f.client, f.service, f.cg.userId, await recordOf(f.cg), startMin, minutes, f.auth])).rows[0].id as string;
  await db.admin.query(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, null, $2, $3::date, $4 from ogevia.client_authorizations a where a.id = $5`, [w.orgA, shift, today, minutes, f.auth]);
  return shift;
}
const REASON = "Client asked for extra help (synthetic)";
/** unscheduled (no shift) by default; scheduled = on a helper shift resized to the time worked, so a clean signature makes it Billing Ready (signed). */
async function startDraft(f: Fx, aged = 0, scheduled = false, cg: Actor = f.cg) {
  const v = await api.start(db, cg, w.orgA, f.client, f.service, null, scheduled ? undefined : REASON);
  if (aged) await ageVisit(db, v, aged);
  return v;
}
async function ended(f: Fx, worked: number, how: "awaiting" | "draw" | "unable" = "awaiting", scheduled = false, cg: Actor = f.cg) {
  const v = await startDraft(f, worked, scheduled, cg);
  await api.end(db, cg, v);
  if (how === "draw") return { v, c: await api.confirm(db, cg, v, { method: "draw", evidence: await api.registerEvidence(db, cg, w.orgA, v) }) };
  if (how === "unable") return { v, c: await api.confirm(db, cg, v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" }) };
  return { v, c: null };
}
/** a second caregiver assigned to the same client (visits of one caregiver may not overlap in a correction). */
async function secondCaregiver(f: Fx): Promise<Actor> {
  const cg = await person();
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, cg.userId, f.client, f.service, today]);
  } finally { await c.query("reset session_replication_role"); c.release(); }
  return cg;
}
const visitRow = async (v: string) => (await db.admin.query("select status::text s, worked_minutes wk, billable_minutes b, verified_minutes vr, floor(extract(epoch from (time_out - time_in)) / 60)::int real from ogevia.service_visits where id = $1", [v])).rows[0];
const close = (v: string) => q(w.managerA, "select ogevia_api.decide_visit_review($1, 'close_not_billable', 'Not a valid visit (synthetic)', null) as id", [v]).then((r) => r[0].id as string);
const revoke = (id: string) => q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1, 'Synthetic: reopened for another look', null) as id", [id]).then((r) => r[0].id as string);
const equation = (s: any) => s.hours_billable_minutes + s.hours_rounding_minutes + s.hours_pending_minutes + s.hours_reserved_minutes + s.hours_left_minutes;
const skipUnlessSameMonth = (ctx: { skip: () => void }) => { if (!sameMonth) ctx.skip(); };

describe("D4: a draft (open) unscheduled visit holds NO provisional time", () => {
  it("authorized 600: a draft visit already 45 minutes old changes nothing (Pending 0, Hours left 600) and does not block a 600-minute shift; the time is counted only when the visit ends (then Over limit 45)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await startDraft(f, 45);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 0, hours_left_minutes: 600, hours_over_limit_minutes: 0, hours_reserved_minutes: 0 });
    expect(await usage(f) + await reservedTotal(f)).toBe(0);
    expect((await visitRow(v)).s).toBe("draft");
    const made = await tryShift(f, 600); // not blocked by the open visit
    expect(made).toHaveLength(1);
    expect(await summary(f)).toMatchObject({ hours_reserved_minutes: 600, hours_left_minutes: 0, hours_over_limit_minutes: 0 });
    // D1 (ending is never refused): the care happened, so the end is recorded and the agency reads Over limit 45
    await api.end(db, f.cg, v);
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 45, hours_reserved_minutes: 600, hours_left_minutes: -45, hours_over_limit_minutes: 45 });
    expect(equation(s)).toBe(600);
    expect((await visitRow(v)).wk).toBe(45);
  });
});

describe("D1: ending and closing a missed visit with no capacity left are ACCEPTED and shown as Over limit", () => {
  it("authorized 600 fully scheduled: ending 45 -> Over limit 45; a manager closes a forgotten 30-minute visit -> Over limit 75; worked minutes exact (45, 30); Billable 0", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const b = await startDraft(f, 30);
    await tryShift(f, 600);
    const closed = await q(w.managerA, "select * from ogevia_api.close_missed_service_visit($1, now(), 'Caregiver forgot to end the visit (synthetic)', null)", [b]);
    expect(closed).toHaveLength(1);
    expect(await summary(f)).toMatchObject({ hours_over_limit_minutes: 30, hours_pending_minutes: 30 });
    const cg2 = await secondCaregiver(f); // the first caregiver's closed visit still awaits confirmation, so a second caregiver records the next one
    const a = await startDraft(f, 45, false, cg2);
    await api.end(db, cg2, a);
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 75, hours_left_minutes: -75, hours_over_limit_minutes: 75, hours_billable_minutes: 0 });
    expect(equation(s)).toBe(600);
    expect((await visitRow(a)).wk).toBe(45);
    expect((await visitRow(b)).wk).toBe(30);
    expect(await usage(f)).toBe(0); // nothing is billable beyond the limit: no billable minute exists
  });
});

describe("RULE (c): an overage is WARNED on the server figures every screen reads", () => {
  it("authorized 600 fully scheduled, a 45-minute visit ends: Over limit 45 in the client/reports summary, the Home utilisation row (hours_over_limit 45, critical tier), the chain report row and the tier is 'critical'", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await startDraft(f, 45);
    await tryShift(f, 600);
    await api.end(db, f.cg, v);
    const s = await summary(f);
    expect(s).toMatchObject({ hours_over_limit_minutes: 45, hours_left_minutes: -45, authorization_tier: "critical" });
    const home = (await q(w.managerA, "select * from ogevia_api.get_utilisation_overview($1, $2::date)", [w.orgA, monthStart()])).find((r) => r.service_id === f.service);
    expect(Number(home.hours_over_limit_minutes)).toBeGreaterThanOrEqual(45);
    expect(Number(home.critical_authorizations)).toBeGreaterThanOrEqual(1);
    const chain = (await q(w.managerA, "select * from ogevia_api.get_monthly_chain_report($1, $2::date, $3)", [w.orgA, monthStart(), f.client]))[0];
    expect(chain).toMatchObject({ hours_over_limit_minutes: 45, hours_left_minutes: -45 });
    // GAP reported (not built): the Action needed list has no 'over limit' item of its own (only amendment impacts, lowered-authorization reviews and reconciliation)
    const issues = (await q(w.managerA, "select ogevia_api.list_action_issues($1,null,null,null,$2,null,null,200,0) as r", [w.orgA, f.client]))[0].r;
    expect(issues).toBeTruthy();
    expect(JSON.stringify(issues)).not.toMatch(/over_?limit/i);
  });
});

describe("D1: REOPENING is refused when it would exceed the authorization, allowed when it fits or adds nothing (migration 0083)", () => {
  const audits = async (decision: string) => Number((await db.admin.query("select count(*) n from ogevia.audit_events where entity_id = $1 and action = 'visit.review_revoked'", [decision])).rows[0].n);
  it("closed 45 (left 600), a 600-minute shift is scheduled, reopening would be 645 of 600 -> refused with the numbers; nothing is written (decision stays active, no audit event, figures unchanged)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const { v } = await ended(f, 45, "unable");
    const d = await close(v);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 0, hours_left_minutes: 600 });
    await tryShift(f, 600);
    const before = await summary(f);
    await expectPgError(revoke(d), "OGC09", /^Reopening would put this authorization 45 min over its monthly limit \(10 hr 45 min committed of 10 hr authorized\)\. Over-limit time cannot be billed\.$/);
    expect(await summary(f)).toEqual(before);
    expect(await audits(d)).toBe(0);
    expect((await db.admin.query("select revoked_at from ogevia.visit_review_decisions where id = $1", [d])).rows[0].revoked_at).toBeNull();
    // the shift is cancelled: now it fits and the reopening is allowed
    const shift = (await db.admin.query("select id from ogevia.shifts where client_id = $1", [f.client])).rows[0].id as string;
    await q(w.managerA, "select ogevia_api.cancel_shift($1, 'Synthetic: schedule changed', null)", [shift]).catch(async () => {
      await db.admin.query("update ogevia.authorization_reservations set released_at = now(), release_reason = 'cancelled' where shift_id = $1", [shift]);
    });
    await revoke(d);
    expect(await audits(d)).toBe(1);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 45, hours_over_limit_minutes: 0 });
  });

  it("a reopening that exactly fits is allowed (555 scheduled + 45 = 600, Over limit 0); one minute more is refused (556 + 45 = 601: '1 min over')", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const { v } = await ended(f, 45, "unable");
    const d = await close(v);
    await tryShift(f, 555);
    await revoke(d);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 45, hours_reserved_minutes: 555, hours_left_minutes: 0, hours_over_limit_minutes: 0 });
    const g = await fx(600);
    const { v: v2 } = await ended(g, 45, "unable");
    const d2 = await close(v2);
    await tryShift(g, 555);
    await reservedShift(g, 1); // fixture: one more committed minute (556)
    await expectPgError(revoke(d2), "OGC09", /1 min over its monthly limit \(10 hr 1 min committed of 10 hr authorized\)/);
    expect(await audits(d2)).toBe(0);
  });

  it("a SCHEDULED visit closed as not billable keeps its reservation (D2), so reopening adds nothing: it stays allowed even when the authorization is already over limit", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const shift = await reservedShift(f, 130); // fixture: 130 reserved on 100 authorized (Over limit 30)
    const { v } = await ended(f, 60, "unable");
    const d = await close(v);
    expect(await summary(f)).toMatchObject({ hours_closed_not_billable_held_minutes: 130, hours_over_limit_minutes: 30 });
    expect((await db.admin.query("select released_at from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0].released_at).toBeNull(); // D2: not released
    await revoke(d);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 130, hours_closed_not_billable_held_minutes: 0, hours_over_limit_minutes: 30 });
    expect(await audits(d)).toBe(1);
  });

  it("revoking an accepted late confirmation only lowers billable time and is never refused", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const { v } = await ended(f, 45, "unable");
    const lc = await lateAccepted(v);
    expect(lc.accepted).toBe(45);
    await tryShift(f, 555);
    await revoke(await activeDecision(v)); // 45 billable -> 45 pending: same committed total
    expect(await summary(f)).toMatchObject({ hours_billable_minutes: 0, hours_pending_minutes: 45, hours_over_limit_minutes: 0 });
  });
});

// --- late confirmation helpers (public response through the real function) -----------------------------------------------------------------------------------
async function lateAccepted(visit: string) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha(token);
  const codeHash = sha(`${tokenHash}:123456`);
  await q(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'link',$2,'parent',$3,$4,$5,7,null)",
    [visit, "Synthetic Parent", "Called the number on file and confirmed the parent's name", tokenHash, codeHash]);
  const c = await db.admin.connect();
  let lcId: string;
  try {
    await c.query("begin"); await c.query("set local role ogevia_app");
    lcId = (await c.query("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed',$4,null,true,null,null,null,null,$5)",
      [tokenHash, codeHash, randomUUID(), "Synthetic Parent", randomUUID()])).rows[0].late_confirmation_id as string;
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  const r = (await q(w.managerA, "select * from ogevia_api.review_late_visit_confirmation($1,'accepted','Checked against the schedule (synthetic)',null)", [lcId]))[0];
  return { accepted: r.accepted_minutes as number, capped: r.capped_by_authorization as boolean };
}
const activeDecisionOrNull = async (visit: string) => (await db.admin.query("select id from ogevia.visit_review_decisions where visit_id = $1 and revoked_at is null", [visit])).rows[0]?.id as string | undefined;
const activeDecision = async (visit: string) => (await db.admin.query("select id from ogevia.visit_review_decisions where visit_id = $1 and revoked_at is null", [visit])).rows[0].id as string;

describe("RULE (a): Billable + Rounding never exceeds Authorized, on every path that creates billable minutes; worked time is kept in full", () => {
  it("confirm (sign): authorized 100, two visits of 80: first Billable 80, second capped at 20 (worked 80 kept, 60 'Worked, not billable'); Billable 100 of 100", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const one = await ended(f, 80, "draw", true);
    const two = await ended(f, 80, "draw", true);
    expect(await visitRow(one.v)).toMatchObject({ s: "signed", b: 80, wk: 80, real: 80 });
    expect(await visitRow(two.v)).toMatchObject({ s: "administrator_review", b: 20, wk: 80, real: 80 });
    const s = await summary(f);
    expect(s.hours_worked_not_billable_minutes).toBe(60);
    expect(await usage(f)).toBe(100);
    expect(s.worked_minutes).toBe(160); // payroll view: all 160 worked
    expect(s.hours_billable_minutes + s.hours_pending_minutes + s.hours_rounding_minutes).toBeLessThanOrEqual(100);
  });

  it("late-confirmation acceptance is capped at the room: authorized 100, signed 80, a 60-minute visit accepted late -> accepted 20 (capped), worked 60 kept; total 100", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    await ended(f, 80, "draw", true);
    const { v } = await ended(f, 60, "unable");
    const r = await lateAccepted(v);
    expect(r).toEqual({ accepted: 20, capped: true });
    expect(await usage(f)).toBe(100);
    expect((await visitRow(v)).wk).toBe(60);
  });

  it("correction: authorized 100, signed 50 + signed 50; correcting the first to 70 minutes cannot raise Billable beyond the room (50 allowed -> review), total stays 100 and the corrected visit keeps worked 70", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const a = await ended(f, 50, "draw", true);
    await ended(f, 50, "draw", true, await secondCaregiver(f));
    const t = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [a.v])).rows[0];
    const c = await api.correct(db, w.managerA, a.v, new Date(new Date(t.time_in).getTime() - 20 * 60000), t.time_out, "Time in was entered late (synthetic)");
    const row = await visitRow(c);
    expect(row.wk).toBe(70);
    expect(row.b).toBeLessThanOrEqual(50);
    expect(await usage(f)).toBeLessThanOrEqual(100);
    expect(await usage(f)).toBe(100);
  });

  it("rounding adjustment approve is capped: authorized 100, signed 95 approved, round-up to 15 would be 105 -> capped by the authorization to the largest whole unit that fits (90, adjustment -5, capped_by_authorization); Billable + Rounding = 90, never above 100; worked 95 kept", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const { v } = await ended(f, 95, "draw", true);
    await q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 95, 'Synthetic approval', null)", [v]);
    const adj = (await q(w.ownerA, "select * from ogevia_api.approve_billing_rounding_adjustment($1,$2,null,null,'Synthetic rounding',null)", [w.orgA, v]))[0];
    expect(adj).toMatchObject({ base_minutes: 95, proposed_minutes: 90, adjustment_minutes: -5, capped_by_authorization: true });
    expect(await usage(f)).toBe(90);
    expect((await visitRow(v)).wk).toBe(95);
  });

  it("billing approval cannot approve more than the capped billable minutes: a capped 20-minute visit is not approvable until a person accepts it, then only up to 20; the approved total per lineage-month stays within the cap", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const one = await ended(f, 80, "draw", true);
    const two = await ended(f, 80, "draw", true, await secondCaregiver(f)); // capped 20, in review: not billable until reviewed
    await expectPgError(q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 20, 'Synthetic', null)", [two.v]), "OGC09", /Ready for Review/);
    await expectPgError(q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 81, 'Synthetic', null)", [one.v]), "OGV22", /between 0 and the billable minutes \(80\)/);
    await q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 80, 'Synthetic', null)", [one.v]);
    await q(w.managerA, "select ogevia_api.decide_visit_review($1, 'accept_capped_billable', 'Client signed; accepted at the capped minutes (synthetic)', null)", [two.v]);
    await expectPgError(q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 21, 'Synthetic', null)", [two.v]), "OGV22", /between 0 and the billable minutes \(20\)/);
    await q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 20, 'Synthetic', null)", [two.v]);
    const approved = Number((await db.admin.query("select coalesce(sum(approved_minutes),0) n from ogevia.billing_approvals b join ogevia.service_visits v on v.id = b.visit_id where v.client_id = $1 and b.voided_at is null", [f.client])).rows[0].n);
    expect(approved).toBe(100);
    expect((await summary(f)).worked_minutes).toBe(160); // worked 160 stays; 60 is 'Worked, not billable'
  });

  it("retroactive decrease below what is already billed: authorized 100 -> 60 with 80 signed: the 80 signed minutes are PRESERVED (never rewritten), the visit goes to human review, approval is refused until a person resolves it, and the approvable minutes never exceed what was signed", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const { v } = await ended(f, 80, "draw", true);
    const out = await api.amend(db, w.managerA, f.auth, 60, "Synthetic: authorization lowered retroactively");
    expect(out.length).toBeGreaterThan(0);
    expect(await visitRow(v)).toMatchObject({ b: 80, wk: 80 }); // preserved, not rewritten
    const st = (await q(w.ownerA, "select billing_state from ogevia_api.list_billing_review_visits($1, $2::date, $3::date) where visit_id = $4", [w.orgA, monthStart(), tomorrow, v]))[0];
    expect(st.billing_state).not.toBe("ready_for_review"); // flagged: needs a person's decision
    await expectPgError(q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 80, 'Synthetic', null)", [v]), "OGC09");
    const s = await summary(f);
    expect(s.authorized_minutes).toBe(60);
    expect(s.hours_over_limit_minutes).toBe(20); // warned: 80 of 60
    expect(s.worked_minutes).toBe(80);
  });
});

describe("RULE (a) property test: random interleavings never let Billable + Rounding exceed Authorized, the equation stays exact, worked minutes stay exact", () => {
  // deterministic PRNG so a failure is reproducible
  const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const agg = { reopenRefused: 0, reopenOk: 0, shiftRefused: 0, capped: 0, over: 0, steps: 0 };
  for (const seed of [11, 23, 47, 91, 137, 311, 523, 1009]) {
    it(`seed ${seed}: 22 random operations on a 300-minute authorization`, async (ctx) => {
      skipUnlessSameMonth(ctx);
      const r = rng(seed);
      const f = await fx(300);
      const worked = new Map<string, number>(); // visit -> minutes aged (the real time)
      const states: Array<{ v: string; cg: Actor; kind: "awaiting" | "review" | "signed" }> = [];
      const log: string[] = [];
      const check = async (step: string) => {
        const sm = await summary(f);
        expect(equation(sm), `${step}: equation (${log.join(" > ")})`).toBe(300);
        expect(await usage(f), `${step}: Billable + Rounding <= Authorized (${log.join(" > ")})`).toBeLessThanOrEqual(300);
        expect(300 - (await usage(f) + await reservedTotal(f)), `${step}: guard = displayed Hours left`).toBe(sm.hours_left_minutes);
        expect(sm.hours_over_limit_minutes).toBe(Math.max(0, -sm.hours_left_minutes));
        if (sm.hours_over_limit_minutes > 0) agg.over++;
        for (const [v, m] of worked) {
          const row = await visitRow(v);
          expect(row.wk, `${step}: worked minutes of ${v}`).toBe(m);
          expect(row.real, `${step}: real time of ${v}`).toBe(m);
        }
      };
      const closedDecisions = async () => (await db.admin.query("select d.id from ogevia.visit_review_decisions d join ogevia.service_visits v on v.id = d.visit_id where v.client_id = $1 and d.revoked_at is null and d.decision = 'close_not_billable'", [f.client])).rows.map((x) => x.id as string);
      for (let i = 0; i < 22; i++) {
        const closed = await closedDecisions();
        const open = [];
        for (const x of states) if (x.kind === "review" && !(await activeDecisionOrNull(x.v))) open.push(x);
        const ops = ["end", "shift", ...(states.some((x) => x.kind === "awaiting") ? ["sign", "sign", "sign", "unable"] : []), ...(open.length ? ["close"] : []), ...(closed.length ? ["reopen"] : [])];
        const op = ops[Math.floor(r() * ops.length)];
        if (op === "end") { // a new caregiver each time: ending real work is never refused, whatever room is left
          const m = 40 + Math.floor(r() * 80);
          const cg = await secondCaregiver(f);
          const { v } = await ended(f, m, "awaiting", false, cg);
          worked.set(v, m); states.push({ v, cg, kind: "awaiting" }); log.push(`end ${m}`);
        } else if (op === "sign") {
          const aw = states.find((x) => x.kind === "awaiting")!;
          const c = await api.confirm(db, aw.cg, aw.v, { method: "draw", evidence: await api.registerEvidence(db, aw.cg, w.orgA, aw.v) });
          aw.kind = c.status === "signed" ? "signed" : "review";
          if ((await visitRow(aw.v)).b < worked.get(aw.v)!) agg.capped++;
          log.push(`sign ${aw.kind} billable ${(await visitRow(aw.v)).b}`);
        } else if (op === "unable") {
          const aw = states.find((x) => x.kind === "awaiting")!;
          await api.confirm(db, aw.cg, aw.v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" }); aw.kind = "review"; log.push("unable");
        } else if (op === "close") {
          await close(open[0]!.v); log.push("close");
        } else if (op === "reopen") {
          try { await revoke(closed[0]!); agg.reopenOk++; log.push("reopen ok"); }
          catch (e: any) { expect(e.code).toBe("OGC09"); expect(e.message).toMatch(/^Reopening would put this authorization/); agg.reopenRefused++; log.push("reopen refused"); }
        } else {
          const m = 30 + Math.floor(r() * 120);
          try { await tryShift(f, m, 6 * 60 + Math.floor(r() * 10) * 60); log.push(`shift ${m} ok`); } catch (e: any) { expect(e.code).toMatch(/OGC09|OGV22/); agg.shiftRefused++; log.push(`shift ${m} refused`); }
        }
        agg.steps++;
        await check(`step ${i + 1} (${op})`);
      }
      if (process.env.OGEVIA_TRACE) console.log(`seed ${seed}: ${log.join(" > ")}`);
      expect(worked.size, `visits recorded: ${log.join(" > ")}`).toBeGreaterThanOrEqual(3);
    });
  }

  it("the interleavings were not trivial: across the seeds a reopening was refused AND another allowed, a shift was refused, a signature was capped by the authorization and Over limit was reached", () => {
    if (!sameMonth) return;
    if (process.env.OGEVIA_TRACE) console.log(JSON.stringify(agg));
    expect(agg.reopenRefused).toBeGreaterThanOrEqual(1);
    expect(agg.reopenOk).toBeGreaterThanOrEqual(1);
    expect(agg.shiftRefused).toBeGreaterThanOrEqual(1);
    expect(agg.capped).toBeGreaterThanOrEqual(1);
    expect(agg.over).toBeGreaterThanOrEqual(1);
  });

  it("the 645-of-600 ordering: a shift takes the last 600 minutes, THEN a 45-minute visit ends and is signed: committed 645 (Over limit 45 warned) but Billable 45, never above 600; worked 45 exact", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await startDraft(f, 45);
    await tryShift(f, 600);
    await api.end(db, f.cg, v);
    const s0 = await summary(f);
    expect(s0).toMatchObject({ hours_over_limit_minutes: 45, hours_left_minutes: -45 });
    const c = await api.confirm(db, f.cg, v, { method: "draw", evidence: await api.registerEvidence(db, f.cg, w.orgA, v) });
    expect(c.billable_minutes).toBe(45);
    const s = await summary(f);
    expect(await usage(f)).toBe(45);
    expect(await usage(f)).toBeLessThanOrEqual(600);
    expect(s.hours_over_limit_minutes).toBe(45);
    expect(equation(s)).toBe(600);
    expect(await visitRow(v)).toMatchObject({ wk: 45, real: 45, b: 45 });
  });
});

describe("RULE (b): worked minutes equal the real time in/out difference whatever the cap, the review outcome or rounding", () => {
  it("capped, closed not billable, unable to confirm, late rejected and rounded: worked_minutes on the visit, the billing-review list (CSV source) and the monthly summary equal the real minutes", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    const capped1 = await ended(f, 80, "draw", true); // signed 80
    const capped2 = await ended(f, 77, "draw", true, await secondCaregiver(f)); // capped 20, worked 77
    const unable = await ended(f, 33, "unable");
    await close(unable.v); // closed not billable
    const rejected = await ended(f, 41, "unable");
    {
      const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      const tokenHash = sha(token); const codeHash = sha(`${tokenHash}:123456`);
      await q(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'link',$2,'parent',$3,$4,$5,7,null)", [rejected.v, "Synthetic Parent", "Called the number on file and confirmed the parent's name", tokenHash, codeHash]);
      const c = await db.admin.connect();
      try {
        await c.query("begin"); await c.query("set local role ogevia_app");
        const id = (await c.query("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed',$4,null,true,null,null,null,null,$5)", [tokenHash, codeHash, randomUUID(), "Synthetic Parent", randomUUID()])).rows[0].late_confirmation_id;
        await c.query("commit");
        await q(w.managerA, "select * from ogevia_api.review_late_visit_confirmation($1,'rejected','Could not verify the response (synthetic)',null)", [id]);
      } finally { c.release(); }
    }
    await q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 80, 'Synthetic', null)", [capped1.v]);
    const real: Record<string, number> = { [capped1.v]: 80, [capped2.v]: 77, [unable.v]: 33, [rejected.v]: 41 };
    for (const [v, m] of Object.entries(real)) expect(await visitRow(v), v).toMatchObject({ wk: m, real: m });
    const list = await q(w.ownerA, "select visit_id, worked_minutes from ogevia_api.list_billing_review_visits($1, $2::date, $3::date)", [w.orgA, monthStart(), tomorrow]);
    for (const [v, m] of Object.entries(real)) expect(list.find((x) => x.visit_id === v)?.worked_minutes, `list_billing_review_visits ${v}`).toBe(m);
    expect((await summary(f)).worked_minutes).toBe(80 + 77 + 33 + 41);
  });

  it("a visit still awaiting confirmation keeps its worked minutes on the visit row, but is NOT in the monthly summary worked column or the billing-review list (reported: payroll must read the visit row / Pending until it is confirmed)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const { v } = await ended(f, 52, "awaiting");
    expect(await visitRow(v)).toMatchObject({ s: "awaiting_signature", wk: 52, real: 52 });
    expect((await summary(f)).worked_minutes).toBe(0);
    const list = await q(w.ownerA, "select visit_id from ogevia_api.list_billing_review_visits($1, $2::date, $3::date) where visit_id = $4", [w.orgA, monthStart(), tomorrow, v]);
    expect(list).toHaveLength(0);
    expect((await summary(f)).hours_pending_minutes).toBe(52); // still visible, as Pending
  });
});

describe("RULE (a): rounding down then voiding cannot lift Billable + Rounding above Authorized (found while verifying)", () => {
  it("authorized 100, policy round DOWN to 15: signed 50 approved and rounded to 45 (-5); a second visit then takes the freed room (billable 55); voiding the -5 would make 105 of 100 -> must be refused", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(100);
    // a dedicated payer so the 'down' policy applies to this authorization only
    const c = await db.admin.connect();
    try { await c.query("set session_replication_role = replica"); await c.query("update ogevia.client_authorizations set payer = 'SYNTHETIC-DOWN-PAYER' where id = $1", [f.auth]); } finally { await c.query("reset session_replication_role"); c.release(); }
    await q(w.ownerA, "select * from ogevia_api.set_billing_rounding_policy($1, 'SYNTHETIC-DOWN-PAYER', $2, 'down', 15, 'per_visit', 'Synthetic payer manual 9.9', '2026-01-15'::date, '2026-01-01'::date, 'Synthetic policy', null)", [w.orgA, w.serviceA]);
    const one = await ended(f, 50, "draw", true);
    await q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 50, 'Synthetic approval', null)", [one.v]);
    const adj = (await q(w.ownerA, "select * from ogevia_api.approve_billing_rounding_adjustment($1,$2,null,null,'Synthetic rounding',null)", [w.orgA, one.v]))[0];
    expect(adj).toMatchObject({ base_minutes: 50, proposed_minutes: 45, adjustment_minutes: -5 });
    expect(await usage(f)).toBe(45);
    const two = await ended(f, 55, "draw", true, await secondCaregiver(f));
    expect((await visitRow(two.v)).b).toBe(55);
    expect(await usage(f)).toBe(100);
    await expectPgError(q(w.ownerA, "select ogevia_api.void_billing_rounding_adjustment($1, 'Synthetic: entered in error', null)", [adj.adjustment_id]), "OGC09", /^Voiding this rounding adjustment would put this authorization 5 min over its monthly limit \(1 hr 45 min billable of 1 hr 40 min authorized\)\. Over-limit time cannot be billed\.$/);
    expect(await usage(f)).toBe(100);
  });
});
