// Review decisions, reopening, late confirmation, rounding and correction: the hours equation and the scheduling guard stay consistent at EVERY step, nothing is double
// counted, nothing changes silently, and the audit trail keeps previous and new values (migration 0082 adds the missing ones). SYNTHETIC data only.
//   Authorized = Billable + Rounding + Pending + Reserved + Hours left          (Over limit is per authorization and never offset)
//   guard:       authorized - (authorization_month_usage + authorization_month_reserved) = displayed Hours left
// Policy kept as it is (HOURS_ACCOUNTING.md): closing a review as not billable does NOT release the shift reservation; the hold is shown as "Closed, not billable (held)".
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
  // a 15-minute-unit, round-up policy for this payer and service (set the real way, as the owner)
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
const consumed = async (f: Fx) =>
  Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) + ogevia.authorization_month_reserved($1, $2::date) n", [f.lineage, today])).rows[0].n);
const hhmm = (startMin: number, minutes: number) => {
  const p = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [p(startMin), p(startMin + minutes)] as const;
};
const tryShift = (f: Fx, minutes: number) => {
  const [s, e] = hhmm(8 * 60, minutes);
  return q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,$7)", [w.orgA, f.client, f.service, tomorrow, s, e, randomUUID()]);
};

/** The same figures the screens show, the equation, and the guard, checked at one step. `step` names it in a failure. */
async function inv(f: Fx, step: string, e: Partial<{ billable: number; rounding: number; pending: number; reserved: number; left: number; over: number; closedHeld: number; closedWorked: number; wnb: number }>) {
  const s = await summary(f);
  const got = { billable: s.hours_billable_minutes, rounding: s.hours_rounding_minutes, pending: s.hours_pending_minutes, reserved: s.hours_reserved_minutes, left: s.hours_left_minutes,
    over: s.hours_over_limit_minutes, closedHeld: s.hours_closed_not_billable_held_minutes, closedWorked: s.hours_closed_not_billable_worked_minutes, wnb: s.hours_worked_not_billable_minutes };
  for (const [k, v] of Object.entries(e)) expect((got as any)[k], `${step}: ${k}`).toBe(v);
  expect(got.billable + got.rounding + got.pending + got.reserved + got.left, `${step}: equation`).toBe(f.authorized);
  expect(f.authorized - (await consumed(f)), `${step}: guard = displayed Hours left`).toBe(got.left);
  expect(got.over, `${step}: over limit`).toBe(Math.max(0, -got.left));
  return s;
}
/** The guard agrees with the figure: one quarter hour more than Hours left is refused (and nothing is created). */
async function guardRefusesBeyond(f: Fx, step: string) {
  const s = await summary(f);
  const need = Math.max(15, s.hours_left_minutes + 15);
  if (need > 1440) return;
  const before = Number((await db.admin.query("select count(*) n from ogevia.shifts where client_id = $1", [f.client])).rows[0].n);
  await expectPgError(tryShift(f, need), "OGC09", /available|authorized|left/i);
  expect(Number((await db.admin.query("select count(*) n from ogevia.shifts where client_id = $1", [f.client])).rows[0].n), `${step}: nothing created`).toBe(before);
}
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
async function visit(f: Fx, worked: number, how: { confirm?: "draw" | "unable_to_confirm" | null; scheduled?: boolean } = {}) {
  const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, how.scheduled ? null : "Client asked for extra help (synthetic)");
  await ageVisit(db, v, worked);
  await api.end(db, f.cg, v);
  if (how.confirm === "draw") await api.confirm(db, f.cg, v, { method: "draw", evidence: await api.registerEvidence(db, f.cg, w.orgA, v) });
  if (how.confirm === "unable_to_confirm") await api.confirm(db, f.cg, v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  return v;
}
const close = (v: string, key: string | null = null) => q(w.managerA, "select ogevia_api.decide_visit_review($1, 'close_not_billable', 'Not a valid visit (synthetic)', $2) as id", [v, key]).then((r) => r[0].id as string);
const revoke = (id: string, key: string | null = null) => q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1, 'Synthetic: reopened for another look', $2) as id", [id, key]).then((r) => r[0].id as string);
const reservation = async (shift: string) => (await db.admin.query("select released_at, release_reason, reserved_minutes from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0];
const skipUnlessSameMonth = (ctx: { skip: () => void }) => { if (!sameMonth) ctx.skip(); };

/** The office asks for a late confirmation (request) and, later, the client's response arrives through the public page. Two steps so the order against a close can be chosen. */
async function lateRequest(visit: string) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha(token);
  const codeHash = sha(`${tokenHash}:123456`);
  await q(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'link',$2,'parent',$3,$4,$5,7,null)",
    [visit, "Synthetic Parent", "Called the number on file and confirmed the parent's name", tokenHash, codeHash]);
  return { tokenHash, codeHash };
}
async function lateRespond(r: { tokenHash: string; codeHash: string }) {
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_app");
    const res = (await c.query("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed',$4,null,true,null,null,null,null,$5)",
      [r.tokenHash, r.codeHash, randomUUID(), "Synthetic Parent", randomUUID()])).rows[0];
    await c.query("commit");
    return res.late_confirmation_id as string;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const lateResponse = async (visit: string) => lateRespond(await lateRequest(visit));
const acceptLate = (id: string) => q(w.managerA, "select * from ogevia_api.review_late_visit_confirmation($1,'accepted','Checked against the schedule (synthetic)',null)", [id]).then((r) => r[0]);
const auditRows = async (entityId: string | string[], action?: string) =>
  (await db.admin.query(
    `select * from ogevia.audit_events where entity_id = any($1::uuid[]) ${action ? "and action = $2" : ""} order by id`,
    action ? [Array.isArray(entityId) ? entityId : [entityId], action] : [Array.isArray(entityId) ? entityId : [entityId]])).rows;

describe("close as not billable -> reopen (revoke) -> close again: every step consistent, the reservation never released", () => {
  it("SCHEDULED visit: shift 130, worked 60, no signer. Pending 130 -> close: Reserved 130 (closed, held), Pending 0, left 470 -> reopen: Pending 130 -> close again -> same as the first close; the reservation row is never released", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const shift = await reservedShift(f, 130);
    await inv(f, "shift reserved", { reserved: 130, pending: 0, left: 470 });
    const v = await visit(f, 60, { confirm: "unable_to_confirm" });
    await inv(f, "ended, in review, no signer", { pending: 130, reserved: 0, closedHeld: 0, left: 470, wnb: 0 });
    await guardRefusesBeyond(f, "in review");

    const d1 = await close(v);
    await inv(f, "closed (1)", { pending: 0, reserved: 130, closedHeld: 130, closedWorked: 60, wnb: 60, left: 470 });
    expect(await reservation(shift)).toMatchObject({ released_at: null, release_reason: null, reserved_minutes: 130 });
    await guardRefusesBeyond(f, "closed (1)");

    await revoke(d1);
    await inv(f, "reopened", { pending: 130, reserved: 0, closedHeld: 0, closedWorked: 0, wnb: 0, left: 470 });
    expect(await reservation(shift)).toMatchObject({ released_at: null, reserved_minutes: 130 });
    await guardRefusesBeyond(f, "reopened");

    const d2 = await close(v);
    expect(d2).not.toBe(d1); // a new decision row; the first stays as history
    await inv(f, "closed (2)", { pending: 0, reserved: 130, closedHeld: 130, closedWorked: 60, wnb: 60, left: 470 });
    expect(await reservation(shift)).toMatchObject({ released_at: null, reserved_minutes: 130 });
    expect((await db.admin.query("select id, revoked_at is not null revoked from ogevia.visit_review_decisions where visit_id = $1 order by decided_at, id", [v])).rows.map((r) => r.revoked)).toEqual([true, false]);
    // the actual worked time is preserved in every state
    expect((await db.admin.query("select worked_minutes, status::text s from ogevia.service_visits where id = $1", [v])).rows[0]).toEqual({ worked_minutes: 60, s: "administrator_review" });
    // the remaining 470 are exactly schedulable and the next quarter hour is not
    expect(await tryShift(f, 470).then((r) => r[0])).toMatchObject({ reserved_minutes: 470 });
    await inv(f, "after scheduling the rest", { reserved: 600, left: 0, pending: 0 });
    await guardRefusesBeyond(f, "full");
  });

  it("UNSCHEDULED visit: worked 45, no signer. Pending 45 (left 555) -> close: Pending 0, left 600, worked 45 stays visible -> reopen: Pending 45 -> close again: left 600 (an unscheduled visit holds nothing: the policy)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    await inv(f, "in review", { pending: 45, left: 555 });
    const d1 = await close(v);
    await inv(f, "closed (1)", { pending: 0, reserved: 0, left: 600, closedWorked: 45, wnb: 45 });
    await revoke(d1);
    await inv(f, "reopened", { pending: 45, left: 555, closedWorked: 0, wnb: 0 });
    await guardRefusesBeyond(f, "reopened");
    await close(v);
    await inv(f, "closed (2)", { pending: 0, left: 600, closedWorked: 45, wnb: 45 });
    expect((await db.admin.query("select worked_minutes from ogevia.service_visits where id = $1", [v])).rows[0].worked_minutes).toBe(45);
  });

  it("idempotent retries: the same key returns the same decision/revocation and writes ONE row and ONE audit event each; the figures do not move", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    const k1 = randomUUID(), k2 = randomUUID();
    const d1 = await close(v, k1);
    expect(await close(v, k1)).toBe(d1);
    await inv(f, "closed twice with one key", { pending: 0, left: 600 });
    expect((await auditRows(d1, "visit.review_decided")).length).toBe(1);
    expect(await revoke(d1, k2)).toBe(d1);
    expect(await revoke(d1, k2)).toBe(d1);
    await inv(f, "revoked twice with one key", { pending: 45, left: 555 });
    expect((await auditRows(d1, "visit.review_revoked")).length).toBe(1);
    // without a key the second attempt is refused with the existing errors, and nothing moves
    await expectPgError(revoke(d1), "OGC09", /already revoked/);
    await close(v);
    await expectPgError(close(v), "OGC09", /already has a review decision/);
    await inv(f, "after the refused repeats", { pending: 0, left: 600 });
  });
});

describe("closed as not billable, then a late confirmation arrives", () => {
  it("UNSCHEDULED: close and late confirmation exclude each other at every step (nothing moves when refused); after revoking the close the acceptance makes the 45 minutes Billable once; revoking that returns them to Pending", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    // an open request or an unreviewed response blocks the close
    const req = await lateRequest(v);
    await expectPgError(close(v), "OGC09");
    await inv(f, "close refused while a request is open", { pending: 45, left: 555 });
    const late = await lateRespond(req);
    await expectPgError(close(v), "OGC09");
    await inv(f, "close refused while a response awaits review", { pending: 45, left: 555 });
    // reject it, close the review; a NEW request cannot be made over the close
    await q(w.managerA, "select * from ogevia_api.review_late_visit_confirmation($1,'rejected','Dispute noted; closing instead (synthetic)',null)", [late]);
    const d1 = await close(v);
    await inv(f, "closed", { pending: 0, left: 600, closedWorked: 45 });
    await expectPgError(lateRequest(v), "OGC09", /already has a review decision; revoke it first/);

    await revoke(d1);
    await inv(f, "close revoked", { pending: 45, left: 555 });
    const late2 = await lateResponse(v);
    const acc = await acceptLate(late2);
    expect(acc.accepted_minutes).toBe(45);
    await inv(f, "late confirmation accepted", { billable: 45, pending: 0, left: 555, closedWorked: 0, wnb: 0 }); // once, not 90
    await guardRefusesBeyond(f, "accepted");
    await expectPgError(close(v), "OGC09"); // a decision already stands
    const decision = (await db.admin.query("select id from ogevia.visit_review_decisions where visit_id = $1 and revoked_at is null and decision = 'accept_late_confirmation'", [v])).rows[0].id as string;
    await revoke(decision);
    await inv(f, "acceptance revoked", { billable: 0, pending: 45, left: 555 });
    await close(v);
    await inv(f, "closed again", { pending: 0, left: 600, closedWorked: 45 });
  });

  it("the race state (a response received, then a close recorded as a fixture row): acceptance is refused with the existing message, nothing moves, the close stands", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    const late = await lateResponse(v);
    await inv(f, "response awaiting review", { pending: 45, left: 555 });
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query(`insert into ogevia.visit_review_decisions (organization_id, visit_id, decision, reason, review_reasons, visit_snapshot, decided_by)
                     values ($1,$2,'close_not_billable','Not a valid visit (synthetic)',array['no_client_signature'],'{}'::jsonb,$3)`, [w.orgA, v, w.managerA.userId]);
    } finally { await c.query("reset session_replication_role"); c.release(); }
    await inv(f, "closed", { pending: 0, left: 600, closedWorked: 45 });
    await expectPgError(acceptLate(late), "OGC09", /already has a review decision; revoke it first/);
    await inv(f, "acceptance refused", { pending: 0, left: 600, closedWorked: 45 });
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_late_confirmation_reviews where late_confirmation_id = $1", [late])).rows[0].n).toBe(0);
  });

  it("SCHEDULED (shift 125, worked 45): accepting a late confirmation turns the 125 held into 45 used (not 170); revoking it returns to the 125 hold; nothing is released", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const shift = await reservedShift(f, 125); // not 120: the test helper resizes 120-minute shifts to the worked time
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    const late = await lateResponse(v);
    await inv(f, "in review", { pending: 125, left: 475 });
    await acceptLate(late);
    await inv(f, "accepted", { billable: 45, pending: 0, reserved: 0, left: 555 });
    expect(await reservation(shift)).toMatchObject({ released_at: null, reserved_minutes: 125 });
    const decision = (await db.admin.query("select id from ogevia.visit_review_decisions where visit_id = $1 and revoked_at is null", [v])).rows[0].id as string;
    await revoke(decision);
    await inv(f, "acceptance revoked", { pending: 125, left: 475 });
    const d = await close(v);
    await inv(f, "closed", { pending: 0, reserved: 125, closedHeld: 125, left: 475 });
    await revoke(d);
    await inv(f, "reopened", { pending: 125, left: 475, closedHeld: 0 });
    expect(await reservation(shift)).toMatchObject({ released_at: null, reserved_minutes: 125 });
  });
});

describe("rounding applied, then voided, then applied again", () => {
  it("signed 50 with +10: Rounding 10, left 540; void: Rounding 0, left 550; applying again with a new key: +10 once; a repeat with the same key adds nothing", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await reservedShift(f, 50);
    const v = await visit(f, 50, { confirm: "draw" });
    await inv(f, "signed", { billable: 50, rounding: 0, left: 550 });
    await q(w.managerA, "select ogevia_api.approve_visit_for_billing($1, 50, null, null) as id", [v]);
    const k = randomUUID();
    const a1 = (await q(w.managerA, "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, null, null, null, $3)", [w.orgA, v, k]))[0];
    expect((await q(w.managerA, "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, null, null, null, $3)", [w.orgA, v, k]))[0]).toEqual(a1);
    await inv(f, "rounded", { billable: 50, rounding: 10, left: 540 });
    await guardRefusesBeyond(f, "rounded");
    await q(w.managerA, "select ogevia_api.void_billing_rounding_adjustment($1, 'Synthetic: payer rule misread', null)", [a1.adjustment_id]);
    await inv(f, "rounding voided", { billable: 50, rounding: 0, left: 550 });
    await guardRefusesBeyond(f, "voided");
    const a2 = (await q(w.managerA, "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, null, null, null, $3)", [w.orgA, v, randomUUID()]))[0];
    expect(a2.adjustment_id).not.toBe(a1.adjustment_id);
    await inv(f, "rounded again", { billable: 50, rounding: 10, left: 540 });
    // the voided adjustment is history, not deleted; the visit's worked and billable minutes never moved
    expect((await db.admin.query("select count(*)::int n, count(*) filter (where voided_at is not null)::int voided from ogevia.billing_rounding_adjustments where visit_id = $1", [v])).rows[0]).toEqual({ n: 2, voided: 1 });
    expect((await db.admin.query("select worked_minutes, billable_minutes from ogevia.service_visits where id = $1", [v])).rows[0]).toEqual({ worked_minutes: 50, billable_minutes: 50 });
    await expectPgError(q(w.managerA, "select ogevia_api.void_billing_rounding_adjustment($1, 'Synthetic again', null)", [a1.adjustment_id]), "OGC09", /already voided/);
    await inv(f, "refused repeat", { billable: 50, rounding: 10, left: 540 });
  });
});

describe("correction after approval / after a close", () => {
  it("a signed 50 corrected to 40: Billable 40 once (not 90), left 560, the original kept as history with the new values beside it", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await reservedShift(f, 50);
    const v = await visit(f, 50, { confirm: "draw" });
    await inv(f, "signed", { billable: 50, left: 550 });
    const t = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [v])).rows[0];
    const newOut = new Date(new Date(t.time_in).getTime() + 40 * 60000 + 1000);
    const corrected = await api.correct(db, w.managerA, v, t.time_in, newOut, "Caregiver left ten minutes early (synthetic)");
    await inv(f, "corrected", { billable: 40, left: 560, pending: 0, reserved: 0 });
    const rows = (await db.admin.query("select id, status::text s, billable_minutes b, worked_minutes wk from ogevia.service_visits where id = any($1)", [[v, corrected]])).rows;
    expect(rows.find((r) => r.id === v)).toMatchObject({ s: "corrected", wk: 50 }); // the original is kept
    expect(rows.find((r) => r.id === corrected)).toMatchObject({ s: "signed", b: 40, wk: 40 });
    const au = await auditRows([v, corrected]);
    const ev = au.find((r) => String(r.action).includes("correct"));
    expect(ev, `audit actions: ${au.map((r) => r.action)}`).toBeTruthy();
    expect(JSON.stringify(ev.before_state)).toContain("50"); // previous worked minutes
    expect(JSON.stringify(ev.after_state)).toContain("40"); // new worked minutes
    expect(ev.reason).toBe("Caregiver left ten minutes early (synthetic)");
    expect(ev.actor_user_id).toBe(w.managerA.userId);
  });

  it("an UNSCHEDULED review closed as not billable, then corrected: observed result (see the assertions) - the corrected visit is a new record and the close stays on the original", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    await close(v);
    await inv(f, "closed", { pending: 0, left: 600, closedWorked: 45 });
    const t = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [v])).rows[0];
    const newOut = new Date(new Date(t.time_in).getTime() + 40 * 60000 + 1000);
    const corrected = await api.correct(db, w.managerA, v, t.time_in, newOut, "Time out was entered late (synthetic)");
    // OBSERVED CURRENT BEHAVIOUR (owner question raised in the report): the correction is a NEW record that is back in review (Pending, no decision); the close stays on the
    // superseded original. Nothing becomes billable, nothing is counted twice (the original's 45 are not counted), and the equation holds.
    await inv(f, "corrected after close", { pending: 40, billable: 0, left: 560, closedWorked: 0, closedHeld: 0 });
    const rows = (await db.admin.query("select id, status::text s, billable_minutes b, worked_minutes wk, (select count(*)::int from ogevia.visit_review_decisions d where d.visit_id = sv.id and d.revoked_at is null) active from ogevia.service_visits sv where id = any($1)", [[v, corrected]])).rows;
    expect(rows.find((r) => r.id === v)).toMatchObject({ s: "corrected", wk: 45, active: 1 });
    expect(rows.find((r) => r.id === corrected)).toMatchObject({ s: "administrator_review", b: 0, wk: 40, active: 0 });
    await guardRefusesBeyond(f, "corrected after close");
  });
});

describe("audit trail: actor, timestamp, reason, previous and new values; rows cannot be updated or deleted", () => {
  it("decide / revoke / late review / rounding void / correction each store actor, occurred_at, reason, request id, and before AND after values", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    const d = await close(v);
    await revoke(d);
    const late = await lateResponse(v);
    const acc = await acceptLate(late);
    const decided = (await auditRows(d, "visit.review_decided"))[0];
    expect(decided).toMatchObject({ actor_user_id: w.managerA.userId, reason: "Not a valid visit (synthetic)", entity_type: "visit_review_decisions" });
    expect(decided.occurred_at).toBeInstanceOf(Date);
    expect(decided.request_id).toBeTruthy();
    expect(decided.before_state).toMatchObject({ visit_id: v, status: "administrator_review", billability: "in_review", worked_minutes: 45, billable_minutes: 0 });
    expect(decided.after_state).toMatchObject({ visit_id: v, decision: "close_not_billable", billability: "closed_not_billable", worked_minutes: 45 });
    const revoked = (await auditRows(d, "visit.review_revoked"))[0];
    expect(revoked).toMatchObject({ actor_user_id: w.managerA.userId, reason: "Synthetic: reopened for another look" });
    expect(revoked.before_state).toMatchObject({ decision: "close_not_billable", visit_id: v, billability: "closed_not_billable", worked_minutes: 45 });
    expect(revoked.after_state).toMatchObject({ revoked: true, visit_id: v, billability: "in_review" });
    const reviewed = (await auditRows(acc.review_id, "visit.late_confirmation_reviewed"))[0];
    expect(reviewed.before_state).toMatchObject({ visit_id: v, status: "administrator_review", billability: "in_review", worked_minutes: 45 });
    expect(reviewed.after_state).toMatchObject({ outcome: "accepted", accepted_minutes: 45, billability: "late_confirmation_accepted" });
    expect(reviewed).toMatchObject({ actor_user_id: w.managerA.userId, reason: "Checked against the schedule (synthetic)" });
    // the decision rows themselves keep the visit as it was when decided (snapshot) and who/when/why
    const row = (await db.admin.query("select decided_by, decided_at, reason, visit_snapshot, revoked_by, revoked_at, revoke_reason from ogevia.visit_review_decisions where id = $1", [d])).rows[0];
    expect(row).toMatchObject({ decided_by: w.managerA.userId, reason: "Not a valid visit (synthetic)", revoked_by: w.managerA.userId, revoke_reason: "Synthetic: reopened for another look" });
    expect(row.visit_snapshot).toMatchObject({ status: "administrator_review", workedMinutes: 45, billableMinutes: 0 });
    expect(row.decided_at).toBeInstanceOf(Date);
    expect(row.revoked_at).toBeInstanceOf(Date);
  });

  it("rounding approve and void audit rows carry the minutes before and after, the actor and the reason", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    await reservedShift(f, 50);
    const v = await visit(f, 50, { confirm: "draw" });
    await q(w.managerA, "select ogevia_api.approve_visit_for_billing($1, 50, null, null) as id", [v]);
    const a = (await q(w.managerA, "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, null, null, null, null)", [w.orgA, v]))[0];
    await q(w.managerA, "select ogevia_api.void_billing_rounding_adjustment($1, 'Synthetic: payer rule misread', null)", [a.adjustment_id]);
    const rows = await auditRows(a.adjustment_id);
    const approved = rows.find((r) => r.action === "billing.rounding_adjustment_approved");
    const voided = rows.find((r) => r.action === "billing.rounding_adjustment_voided");
    expect(approved, `actions: ${rows.map((r) => r.action)}`).toBeTruthy();
    expect(JSON.stringify(approved.after_state)).toMatch(/adjustment_minutes/);
    expect(voided).toMatchObject({ actor_user_id: w.managerA.userId, reason: "Synthetic: payer rule misread" });
    expect(voided.before_state).toMatchObject({ adjustment_minutes: 10, proposed_minutes: 60, base_minutes: 50, voided: false });
    expect(voided.after_state).toMatchObject({ voided: true, adjustment_minutes: 0 });
  });

  it("append-only: audit rows, review decisions (history), rounding adjustments and corrections cannot be updated or deleted, even by the owner role of the schema", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    const d = await close(v);
    await revoke(d);
    const audit = (await auditRows(d, "visit.review_decided"))[0];
    await expect(db.admin.query("update ogevia.audit_events set reason = 'tampered' where id = $1", [audit.id])).rejects.toThrow(/append-only|not allowed|cannot|immutable|forbid/i);
    await expect(db.admin.query("update ogevia.audit_events set before_state = null, after_state = null where id = $1", [audit.id])).rejects.toThrow();
    await expect(db.admin.query("delete from ogevia.audit_events where id = $1", [audit.id])).rejects.toThrow();
    expect((await auditRows(d, "visit.review_decided"))[0]).toEqual(audit);
    // review decisions: only the revocation columns may be set, once; nothing else, no delete
    await expect(db.admin.query("update ogevia.visit_review_decisions set decision = 'accept_capped_billable' where id = $1", [d])).rejects.toThrow();
    await expect(db.admin.query("update ogevia.visit_review_decisions set reason = 'tampered' where id = $1", [d])).rejects.toThrow();
    await expect(db.admin.query("update ogevia.visit_review_decisions set revoked_at = null, revoked_by = null, revoke_reason = null where id = $1", [d])).rejects.toThrow();
    await expect(db.admin.query("update ogevia.visit_review_decisions set visit_snapshot = '{}'::jsonb where id = $1", [d])).rejects.toThrow();
    await expect(db.admin.query("delete from ogevia.visit_review_decisions where id = $1", [d])).rejects.toThrow();
    // rounding adjustments and the correction history
    await reservedShift(f, 50, -400);
    const g = await fx(600);
    await reservedShift(g, 50);
    const gv = await visit(g, 50, { confirm: "draw" });
    await q(w.managerA, "select ogevia_api.approve_visit_for_billing($1, 50, null, null) as id", [gv]);
    const a = (await q(w.managerA, "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, null, null, null, null)", [w.orgA, gv]))[0];
    await expect(db.admin.query("update ogevia.billing_rounding_adjustments set adjustment_minutes = 99, proposed_minutes = 149 where id = $1", [a.adjustment_id])).rejects.toThrow();
    await expect(db.admin.query("delete from ogevia.billing_rounding_adjustments where id = $1", [a.adjustment_id])).rejects.toThrow();
    const t = (await db.admin.query("select time_in from ogevia.service_visits where id = $1", [gv])).rows[0];
    await expectPgError(api.correct(db, w.managerA, gv, t.time_in, new Date(new Date(t.time_in).getTime() + 30 * 60000), "Synthetic correction"), "OGC09"); // approved + rounded visit: ordinary correction is refused, nothing silently re-priced
    const corrections = (await db.admin.query("select id from ogevia.visit_corrections limit 1")).rows[0];
    if (corrections) {
      await expect(db.admin.query("update ogevia.visit_corrections set reason = 'tampered' where id = $1", [corrections.id])).rejects.toThrow();
      await expect(db.admin.query("delete from ogevia.visit_corrections where id = $1", [corrections.id])).rejects.toThrow();
    }
    // the application role has no table privileges at all
    await expect(asActor(db, w.managerA.sub, (c) => c.query("update ogevia.audit_events set reason = 'x'"))).rejects.toThrow();
    await expect(asActor(db, w.managerA.sub, (c) => c.query("delete from ogevia.visit_review_decisions"))).rejects.toThrow();
  });
});
