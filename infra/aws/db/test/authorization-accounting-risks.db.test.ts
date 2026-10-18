// Verification tests for the risks named in docs/product/SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md
// (F1, F2, F4, F6, F8). Each test states the CORRECT behaviour. A test that fails on current code
// reproduces the defect; it is marked `it.fails` only after the failure was observed and recorded, so
// CI stays green while the defect is open and turns red the moment the defect is fixed (remove `.fails`
// then). Nothing here changes product code. SYNTHETIC data only.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageVisit, api, asActor, createTestDb, freshClient, orgToday, seedWorld, signedVisit,
  type Actor, type TestDb, type World,
} from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const q = async (a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const pub = async (sql: string, params: unknown[]) => {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_app");
    const rows = (await c.query(sql, params)).rows as any[];
    await c.query("commit");
    return rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
};
/**
 * The total the web displays: the sum of its eight categories (apps/web/src/aws/action-needed.ts `actionNeededTotal`,
 * pinned by action-needed.test.ts). Restated here, not imported, so this package does not depend on the web build.
 */
const webTotal = (r: Record<string, unknown>) =>
  ["missing_time_out", "not_confirmed", "needs_review", "late_responses_to_review", "uncovered_shifts", "documents_blocking",
    "documents_to_review", "billing_ready_unapproved"].reduce((sum, k) => sum + Number(r[k] ?? 0), 0);

type Fx = { client: string; service: string; auth: string };
const recordOf = async (a: Actor) =>
  (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [a.userId, w.orgA])).rows[0].id as string;
const lineageOf = async (auth: string) =>
  (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [auth])).rows[0].lineage_id as string;

/** A staff shift (the shape create_shift writes) and its reservation, placed relative to now. */
async function reservedShift(a: Actor | null, f: Fx, startOffsetMin: number, minutes: number) {
  const record = a ? await recordOf(a) : null;
  const shift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(mins => $6 + $7), 'scheduled', a.lineage_id
     from ogevia.client_authorizations a where a.id = $8 returning id`,
    [w.orgA, f.client, f.service, a?.userId ?? null, record, startOffsetMin, minutes, f.auth])).rows[0].id as string;
  await db.admin.query(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, null, $2, $3::date, $4 from ogevia.client_authorizations a where a.id = $5`,
    [w.orgA, shift, await orgToday(db), minutes, f.auth]);
  return shift;
}

const monthStart = async () => `${(await orgToday(db)).slice(0, 7)}-01`;
const summary = async (f: Fx) =>
  (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, await monthStart(), f.client]))[0];
const counted = async (f: Fx) => {
  const lineage = await lineageOf(f.auth);
  const today = await orgToday(db);
  const r = (await db.admin.query(
    "select ogevia.authorization_month_usage($1, $2::date) used, ogevia.authorization_month_reserved($1, $2::date) reserved", [lineage, today])).rows[0];
  return { used: Number(r.used), reserved: Number(r.reserved) };
};

// ---- helpers for the late-confirmation path (same calls the API makes) -------------------------------------------
const newLink = () => {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha(token);
  const code = String(100000 + Math.floor(Math.random() * 900000));
  return { tokenHash, codeHash: sha(`${tokenHash}:${code}`) };
};
async function acceptLateConfirmation(visit: string) {
  const l = newLink();
  await q(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'link',$2,'parent',$3,$4,$5,7,null)",
    [visit, "Synthetic Parent Rivera", "Called the number on file and confirmed the parent's name", l.tokenHash, l.codeHash]);
  const id = randomUUID();
  const res = (await pub("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed',$4,null,true,null,null,null,null,$5)",
    [l.tokenHash, l.codeHash, id, "Synthetic Parent Rivera", randomUUID()]))[0];
  return (await q(w.managerA, "select * from ogevia_api.review_late_visit_confirmation($1,'accepted','Checked against the schedule (synthetic)',null)",
    [res.late_confirmation_id]))[0];
}

// =====================================================================================================================
describe("F1: a minute is counted once, as used OR as reserved", () => {
  it("CONTROL (passes today): a linked visit that is SIGNED releases its shift's reservation, so 45 min counts once", async () => {
    const cg = w.caregiverA1;
    const f = await freshClient(db, w, cg, 600);
    const shift = await reservedShift(cg, f, -5, 120);
    const visit = await api.start(db, cg, w.orgA, f.client, f.service, null, null);
    expect((await db.admin.query("select scheduled_shift_id from ogevia.service_visits where id = $1", [visit])).rows[0].scheduled_shift_id).toBe(shift);
    await ageVisit(db, visit, 45);
    await api.end(db, cg, visit);
    const evidence = await api.registerEvidence(db, cg, w.orgA, visit);
    await api.confirm(db, cg, visit, { evidence });
    expect(await counted(f)).toEqual({ used: 45, reserved: 0 });
    expect(await summary(f)).toMatchObject({ billable_minutes: 45, reserved_minutes: 0, remaining_minutes: 555 });
  });

  // F1 (fixed by migration 0049): before the fix used = 45 AND reserved = 120, so 165 of 600 was counted for 45 min of care.
  it("a linked visit left in administrator_review whose late confirmation was ACCEPTED must not also keep the shift's reservation", async () => {
    const cg = w.caregiverA1;
    const f = await freshClient(db, w, cg, 600);
    const shift = await reservedShift(cg, f, -5, 120);
    const visit = await api.start(db, cg, w.orgA, f.client, f.service, null, null);
    await ageVisit(db, visit, 45);
    await api.end(db, cg, visit);
    await api.confirm(db, cg, visit, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
    // Preconditions that make this the scenario in question.
    expect((await db.admin.query("select status, scheduled_shift_id from ogevia.service_visits where id = $1", [visit])).rows[0])
      .toEqual({ status: "administrator_review", scheduled_shift_id: shift });
    const before = await counted(f);
    expect(before).toEqual({ used: 0, reserved: 120 }); // held while unresolved: by design (0013)

    const accepted = await acceptLateConfirmation(visit);
    expect(accepted).toMatchObject({ accepted_minutes: 45 });

    const after = await counted(f);
    // The visit stays in administrator_review (locked); only the decision changed.
    expect((await db.admin.query("select status from ogevia.service_visits where id = $1", [visit])).rows[0].status).toBe("administrator_review");
    expect(after.used).toBe(45);
    expect(after.used + after.reserved).toBe(45); // CORRECT: the same minutes are not also reserved
    expect(await summary(f)).toMatchObject({ reserved_minutes: 0, billable_minutes: 45, remaining_minutes: 555 });
    // The reservation record itself is neither released nor changed.
    const reservation = async () =>
      (await db.admin.query("select released_at, release_reason, reserved_minutes from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0];
    expect(await reservation()).toEqual({ released_at: null, release_reason: null, reserved_minutes: 120 });

    // Reversible: revoking the decision puts the reservation back in the reserved total and takes the minutes out of used.
    await q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1, 'Decision entered in error (synthetic)', null)", [accepted.decision_id]);
    expect(await counted(f)).toEqual({ used: 0, reserved: 120 });
    expect(await summary(f)).toMatchObject({ reserved_minutes: 120, billable_minutes: 0, remaining_minutes: 480 });
    expect(await reservation()).toEqual({ released_at: null, release_reason: null, reserved_minutes: 120 });
  });

  it("an accepted late confirmation on a visit with NO shift, or a visit not yet decided, changes nothing about other reservations", async () => {
    const cg = w.caregiverA1;
    const f = await freshClient(db, w, cg, 600);
    await reservedShift(cg, f, 600, 90); // a different, future shift for the same lineage
    const visit = await api.start(db, cg, w.orgA, f.client, f.service, null, "Synthetic unscheduled test visit"); // not linked: the future shift is far outside the 60-minute early window
    await ageVisit(db, visit, 30);
    await api.end(db, cg, visit);
    await api.confirm(db, cg, visit, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
    expect((await db.admin.query("select scheduled_shift_id from ogevia.service_visits where id = $1", [visit])).rows[0].scheduled_shift_id).toBeNull();
    // 0081 (deliberate): the 30 worked minutes of this unscheduled visit awaiting a decision are unreserved Pending time and now count in the reserved total (90 + 30);
    // accepting the late confirmation moves them to used, so the total is 30 used + 90 reserved, as before.
    expect(await counted(f)).toEqual({ used: 0, reserved: 120 });
    await acceptLateConfirmation(visit);
    expect(await counted(f)).toEqual({ used: 30, reserved: 90 }); // unrelated reservation still counts
  });
});

// =====================================================================================================================
describe("F2: the Action Needed total has one definition", () => {
  // FIXED by 0077 (was `it.fails`): the server total now includes Ready for Approval for people who may see billing, like the web total.
  it("the server total equals the total the web displays for the same row", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 600);
    await signedVisit(db, w.caregiverA2, w, 30, w.orgA, f.client, f.service); // billing ready, not approved
    const row = (await q(w.ownerA, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]))[0];
    expect(row.billing_ready_unapproved).toBeGreaterThan(0);
    expect(webTotal(row)).toBe(Number(row.total));
  });

  it("CONTROL (passes today): the visit categories are disjoint, so a visit is in at most one of them", async () => {
    const cg = w.caregiverA3;
    const f = await freshClient(db, w, cg, 600);
    const baseline = (await q(w.ownerA, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]))[0];
    const visit = await api.start(db, cg, w.orgA, f.client, f.service, null, "Synthetic unscheduled test visit"); // draft, open
    await ageVisit(db, visit, 20 * 60); // open for 20 h with no schedule: missing clock-out
    const after = (await q(w.ownerA, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]))[0];
    const delta = (k: string) => Number(after[k]) - Number(baseline[k]);
    expect(delta("missing_time_out")).toBe(1);
    expect(["not_confirmed", "needs_review", "late_responses_to_review", "billing_ready_unapproved"].map(delta)).toEqual([0, 0, 0, 0]);
  });
});

// =====================================================================================================================
describe("F4 / D10: only urgent coverage gaps (start within 48 h) count toward Action Needed", () => {
  const openShift = async (f: Fx, hoursAhead: number) => reservedShift(null, f, hoursAhead * 60, 120);
  const uncovered = async () => Number((await q(w.managerA, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]))[0].uncovered_shifts);

  it("CONTROL (passes today): an open shift starting in 24 h is counted", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const before = await uncovered();
    await openShift(f, 24);
    expect(await uncovered()).toBe(before + 1);
  });

  // FIXED by 0077 (was `it.fails`): only shifts starting within 48 hours (or under way) count; later ones are Upcoming staffing.
  it("an open shift starting in 10 days is NOT counted", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const before = await uncovered();
    await openShift(f, 240);
    expect(await uncovered()).toBe(before);
  });
});

// =====================================================================================================================
describe("F6: every reserved minute is visible somewhere on the dashboard", () => {
  const overview = async () =>
    (await q(w.managerA, "select * from ogevia_api.get_utilisation_overview($1, $2::date)", [w.orgA, await monthStart()]))
      .find((r) => r.service_id === w.serviceA);

  // FIXED by 0067 (was `it.fails`): a shift that began 30 min ago with no visit yet lowers "remaining" (reserved) and is now in the scheduled figure (underway).
  it("authorized = billable + scheduled + remaining for a reserved shift that has already started", async () => {
    const o0 = await overview();
    const f = await freshClient(db, w, w.caregiverA1, 600);
    await reservedShift(w.caregiverA1, f, -30, 60);
    const o1 = await overview();
    const delta = (k: string) => Number(o1[k]) - Number(o0[k]);
    expect(delta("authorized_minutes")).toBe(600);
    expect(delta("remaining_minutes")).toBe(540); // reserved 60 is deducted ...
    expect(delta("scheduled_minutes")).toBe(60);  // ... so it must be shown as scheduled
  });
});

// =====================================================================================================================
describe("F8: a retroactive decrease reports the reservations it puts over the cap", () => {
  // FIXED by 0068 (was `it.fails`): the amendment reports and stores the reserved shifts it puts over the new cap.
  it("lowering 600 -> 300 with 480 reserved reports the affected shifts", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    for (const h of [24, 48, 72, 96]) await reservedShift(w.caregiverA1, f, h * 60, 120);
    expect(await summary(f)).toMatchObject({ authorized_minutes: 600, reserved_minutes: 480, remaining_minutes: 120 });
    const rows = await api.amend(db, w.managerA, f.auth, 300);
    expect(await summary(f)).toMatchObject({ authorized_minutes: 300, reserved_minutes: 480, remaining_minutes: -180, over_limit_minutes: 180 }); // signed, never clamped to zero (0057)
    // 4 x 120 min reserved against 300 free: in time order the first two (240) fit, the later two are reported
    const shifts = rows.filter((r) => /reserved_shift/.test(r.impact_kind ?? ""));
    expect(shifts).toHaveLength(2);
    expect(shifts.every((r) => r.impact_kind === "reserved_shift_over_cap" && r.affected_shift_id && r.impact_id && r.impact_minutes === 120)).toBe(true);
  });

  it("CONTROL (passes today): after the decrease no further time can be scheduled", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    for (const h of [24, 48, 72, 96]) await reservedShift(w.caregiverA1, f, h * 60, 120);
    await api.amend(db, w.managerA, f.auth, 300);
    const lineage = await lineageOf(f.auth);
    const c = await counted(f);
    const cap = Number((await db.admin.query("select monthly_authorized_minutes m from ogevia.client_authorizations where lineage_id = $1 and is_current", [lineage])).rows[0].m);
    expect(cap - c.used - c.reserved).toBeLessThan(0); // over-allocated: the next create_shift is refused
  });
});
