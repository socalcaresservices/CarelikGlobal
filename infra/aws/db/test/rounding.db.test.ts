// 0029 Billing rounding policies and approved rounding adjustments. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let svc: string;
const PAYER = "Synthetic Rounding Payer";
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  svc = (await db.admin.query("insert into ogevia.services (organization_id, code, name) values ($1, 'RND', 'Rounding service (synthetic)') returning id", [w.orgA])).rows[0].id;
});
afterAll(async () => db?.drop());

/** A client with an authorization from PAYER for the rounding service, assigned to the caregiver. */
async function client(caregiver: Actor, monthlyMinutes: number) {
  const c = (await db.admin.query("insert into ogevia.clients (organization_id) values ($1) returning id", [w.orgA])).rows[0].id;
  await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
    [w.orgA, caregiver.userId, c, svc, today]);
  const a = (await db.admin.query(
    `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
     values ($1, $2, $3, $4, $5, $6::date - 40, $6::date + 40) returning id, lineage_id`, [w.orgA, c, svc, PAYER, monthlyMinutes, today])).rows[0];
  return { client: c, auth: a.id as string, lineage: a.lineage_id as string };
}
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const setPolicy = (a: Actor, o: Partial<{ payer: string; method: string; inc: number | null; basis: string | null; ref: string | null; refDate: string | null; from: string; reason: string }> = {}) =>
  q(a, "select * from ogevia_api.set_billing_rounding_policy($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, null)",
    [w.orgA, o.payer ?? PAYER, svc, o.method ?? "up", o.inc === undefined ? 15 : o.inc, o.basis === undefined ? "per_visit" : o.basis,
     o.ref === undefined ? "Synthetic payer billing manual, section 4.2" : o.ref, o.refDate === undefined ? "2026-01-15" : o.refDate,
     o.from ?? "2026-01-01", o.reason ?? "Synthetic policy for tests"]).then((r) => r[0]);
const preview = (a: Actor = w.managerA) => q(a, "select * from ogevia_api.list_billing_rounding_preview($1, $2::date, $2::date)", [w.orgA, today]);
const approveVisit = (a: Actor, visit: string, minutes: number) => q(a, "select ogevia_api.approve_visit_for_billing($1, $2, null, null) as id", [visit, minutes]).then((r) => r[0].id as string);
const approveAdj = (a: Actor, o: { visit?: string; lineage?: string; date?: string }) =>
  q(a, "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, $3, $4::date, null, null)", [w.orgA, o.visit ?? null, o.lineage ?? null, o.date ?? null]).then((r) => r[0]);
const voidAdj = (a: Actor, id: string) => q(a, "select ogevia_api.void_billing_rounding_adjustment($1, 'Synthetic void', null)", [id]);
const visitRow = async (id: string) => (await db.admin.query("select time_in, time_out, worked_minutes, billable_minutes, status from ogevia.service_visits where id = $1", [id])).rows[0];

describe("rounding arithmetic", () => {
  it("rounds up, down and to the nearest increment (a half increment rounds up)", async () => {
    const r = (await db.admin.query(`select ogevia.round_minutes(50, 'up', 15) a, ogevia.round_minutes(50, 'down', 15) b, ogevia.round_minutes(52, 'nearest', 15) c,
      ogevia.round_minutes(53, 'nearest', 15) d, ogevia.round_minutes(60, 'up', 15) e, ogevia.round_minutes(8, 'nearest', 15) f, ogevia.round_minutes(50, 'none', null) g`)).rows[0];
    expect(r).toEqual({ a: 60, b: 45, c: 45, d: 60, e: 60, f: 15, g: 50 });
  });
});

describe("rounding policies", () => {
  it("default is no rounding: a Billing Ready visit shows its actual minutes and no adjustment", async () => {
    const c = await client(w.caregiverA1, 6000);
    const { visit } = await signedVisit(db, w.caregiverA1, w, 50, w.orgA, c.client, svc);
    const row = (await preview()).find((r) => r.visit_id === visit);
    expect(row).toMatchObject({ method: "none", state: "no_rounding", worked_minutes: 50, billable_minutes: 50, proposed_minutes: 50, adjustment_minutes: 0, proposed_units: null });
  });

  it("only the Administrator sets a policy, and only after recording the payer rule; the payer must be one on the authorizations", async () => {
    await expectPgError(setPolicy(w.managerA), "OGA03", /Only the Administrator/);
    await expectPgError(setPolicy(w.ownerA, { ref: null }), "OGV22", /Record the payer rule/);
    await expectPgError(setPolicy(w.ownerA, { refDate: null }), "OGV22", /Record the payer rule/);
    await expectPgError(setPolicy(w.ownerA, { basis: null }), "OGV22", /per visit or to the daily total/);
    await expectPgError(setPolicy(w.ownerA, { inc: 0 }), "OGV22", /increment/);
    await expectPgError(setPolicy(w.ownerA, { payer: "Not A Payer Here" }), "OGV22", /No authorization in this agency names that payer/);
    await expectPgError(q(w.managerB, "select * from ogevia_api.set_billing_rounding_policy($1, $2, $3, 'up', 15, 'per_visit', 'x ref 12345', '2026-01-01', '2026-01-01', 'r', null)", [w.orgA, PAYER, svc]), "OGN04");
    // "No rounding" needs no payer rule.
    expect(await setPolicy(w.ownerA, { method: "none", inc: null, basis: null, ref: null, refDate: null, reason: "Explicitly no rounding" })).toMatchObject({ version: 1 });
  });
});

describe("per-visit rounding", () => {
  let visit: string;
  let c: Awaited<ReturnType<typeof client>>;
  let adjustment: string;
  it("a policy version records method, increment, basis, payer rule and effective date; history is kept", async () => {
    const p = await setPolicy(w.ownerA, { reason: "Payer bills in 15-minute units, rounded up (synthetic)" });
    expect(p.version).toBe(2);
    const list = await q(w.managerA, "select * from ogevia_api.list_billing_rounding_policies($1)", [w.orgA]);
    expect(list.map((r) => r.version)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({ method: "up", increment_minutes: 15, basis: "per_visit", payer: PAYER, payer_rule_reference: "Synthetic payer billing manual, section 4.2", in_effect_today: true });
    expect(list[1].in_effect_today).toBe(false);
    await expectPgError(db.admin.query("update ogevia.billing_rounding_policies set increment_minutes = 30"), "OGC09");
    // The table itself refuses a rounding policy without an increment, a basis or a payer rule (not only the function).
    for (const bad of ["null, 'per_visit', 'Synthetic rule ref', '2026-01-01'", "15, null, 'Synthetic rule ref', '2026-01-01'", "15, 'per_visit', null, '2026-01-01'", "15, 'per_visit', 'Synthetic rule ref', null"]) {
      await expectPgError(db.admin.query(`insert into ogevia.billing_rounding_policies (organization_id, payer_key, payer_label, service_id, version, method,
        increment_minutes, basis, payer_rule_reference, payer_rule_date, effective_from, reason, created_by)
        values ($1, 'x', 'x', $2, 99, 'up', ${bad}, '2026-01-01', 'r', $3)`, [w.orgA, svc, w.ownerA.userId]), "23514");
    }
    await expectPgError(db.admin.query("delete from ogevia.billing_rounding_policies"), "OGC09");
  });

  it("shows actual, approved, adjustment and proposed units separately; nothing is billed until a person approves", async () => {
    c = await client(w.caregiverA2, 6000);
    ({ visit } = await signedVisit(db, w.caregiverA2, w, 50, w.orgA, c.client, svc));
    const before = await visitRow(visit);
    expect((await preview()).find((r) => r.visit_id === visit)).toMatchObject({ state: "awaiting_visit_approval", worked_minutes: 50, proposed_minutes: 60, adjustment_minutes: 10 });
    await expectPgError(approveAdj(w.managerA, { visit }), "OGC09", /Approve the visit minutes first/);
    await approveVisit(w.managerA, visit, 50);
    const row = (await preview()).find((r) => r.visit_id === visit);
    expect(row).toMatchObject({ state: "ready_to_approve", approved_minutes: 50, proposed_minutes: 60, adjustment_minutes: 10, proposed_units: "4.00", policy_version: 2, capped_by_authorization: false });
    const a = await approveAdj(w.managerA, { visit });
    adjustment = a.adjustment_id;
    expect(a).toMatchObject({ base_minutes: 50, proposed_minutes: 60, adjustment_minutes: 10, proposed_units: "4.00", capped_by_authorization: false });
    // Original records are untouched: clock times, worked (payroll) minutes, confirmed billable minutes and the visit approval.
    expect(await visitRow(visit)).toEqual(before);
    const appr = (await db.admin.query("select approved_minutes, billable_minutes_at_approval from ogevia.billing_approvals where visit_id = $1 and voided_at is null", [visit])).rows[0];
    expect(appr).toEqual({ approved_minutes: 50, billable_minutes_at_approval: 50 });
    // The authorization counts the billed adjustment.
    const used = (await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [c.lineage, today])).rows[0].n;
    expect(Number(used)).toBe(60);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'billing.rounding_adjustment_approved'", [adjustment])).rows[0].n).toBe(1);
    await expectPgError(approveAdj(w.managerA, { visit }), "OGC09", /already covers these visits/);
  });

  it("a visit approval under an adjustment cannot be voided until the adjustment is voided", async () => {
    const appr = (await db.admin.query("select id from ogevia.billing_approvals where visit_id = $1 and voided_at is null", [visit])).rows[0].id;
    await expectPgError(q(w.managerA, "select ogevia_api.void_billing_approval($1, 'Synthetic', null)", [appr]), "OGC09", /void the rounding adjustment first/);
  });

  it("a later policy change never recalculates an approved adjustment; it is shown as approved under the earlier policy", async () => {
    await setPolicy(w.ownerA, { method: "down", reason: "Payer changed to rounding down (synthetic)" });
    const row = (await preview()).find((r) => r.visit_id === visit);
    expect(row).toMatchObject({ state: "approved_under_earlier_policy", adjustment_id: adjustment, adjusted_proposed_minutes: 60, adjusted_minutes: 10, adjusted_policy_version: 2, policy_version: 3 });
    const stored = (await db.admin.query("select proposed_minutes, adjustment_minutes from ogevia.billing_rounding_adjustments where id = $1", [adjustment])).rows[0];
    expect(stored).toEqual({ proposed_minutes: 60, adjustment_minutes: 10 });
    await expectPgError(db.admin.query("update ogevia.billing_rounding_adjustments set adjustment_minutes = 5 where id = $1", [adjustment]), "OGC09", /append-only/);
    await voidAdj(w.managerA, adjustment);
    expect((await preview()).find((r) => r.visit_id === visit)).toMatchObject({ state: "ready_to_approve", proposed_minutes: 45, adjustment_minutes: -5 });
  });

  it("other agencies and caregivers cannot approve or see rounding", async () => {
    await expectPgError(approveAdj(w.managerB, { visit }), "OGN04");
    await expectPgError(approveAdj(w.caregiverA2, { visit }), "OGA03");
    expect(await preview(w.caregiverA2)).toEqual([]);
  });
});

describe("authorization cap", () => {
  it("never rounds past the authorized minutes: a round-up that would exceed falls to the largest increment that fits, flagged", async () => {
    await setPolicy(w.ownerA, { method: "up", reason: "Back to rounding up (synthetic)" });
    const c = await client(w.caregiverA3, 55);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const a = await approveAdj(w.managerA, { visit });
    expect(a).toMatchObject({ base_minutes: 50, proposed_minutes: 45, adjustment_minutes: -5, capped_by_authorization: true });
    const used = Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [c.lineage, today])).rows[0].n);
    expect(used).toBeLessThanOrEqual(55);
  });
});

describe("daily-total rounding", () => {
  it("rounds the day's total once; never both a per-visit and a daily adjustment; a new visit approval into a rounded day is refused", async () => {
    const c = await client(w.caregiverA1, 6000);
    const v1 = (await signedVisit(db, w.caregiverA1, w, 50, w.orgA, c.client, svc)).visit;
    await approveVisit(w.managerA, v1, 50);
    // Per-visit policy still in effect: round this visit on its own first.
    const perVisit = await approveAdj(w.managerA, { visit: v1 });
    await setPolicy(w.ownerA, { method: "nearest", basis: "daily_total", reason: "Payer rounds the daily total to the nearest 15 minutes (synthetic)" });
    const v2 = (await signedVisit(db, w.caregiverA1, w, 20, w.orgA, c.client, svc)).visit;
    await approveVisit(w.managerA, v2, 20);
    const day = (await preview()).find((r) => r.unit_kind === "day" && r.authorization_lineage_id === c.lineage);
    expect(day).toMatchObject({ visit_count: 2, worked_minutes: 70, approved_minutes: 70, basis: "daily_total", state: "approved_under_earlier_policy" });
    await expectPgError(approveAdj(w.managerA, { lineage: c.lineage, date: today }), "OGC09", /already covers these visits/);
    await voidAdj(w.managerA, perVisit.adjustment_id);
    const d = await approveAdj(w.managerA, { lineage: c.lineage, date: today });
    expect(d).toMatchObject({ base_minutes: 70, proposed_minutes: 75, adjustment_minutes: 5, proposed_units: "5.00" });
    await expectPgError(approveAdj(w.managerA, { visit: v1 }), "OGC09", /Only Billing Ready visits can be rounded, under the policy basis/);
    // A third visit that day cannot be approved into the rounded day until the daily adjustment is voided.
    const v3 = (await signedVisit(db, w.caregiverA1, w, 10, w.orgA, c.client, svc)).visit;
    await expectPgError(approveVisit(w.managerA, v3, 10), "OGC09", /already has an approved daily rounding adjustment/);
    await voidAdj(w.managerA, d.adjustment_id);
    await approveVisit(w.managerA, v3, 10);
    expect(await approveAdj(w.managerA, { lineage: c.lineage, date: today })).toMatchObject({ base_minutes: 80, proposed_minutes: 75, adjustment_minutes: -5 });
  });

  it("rollback 0029 refuses while policies or adjustments exist", async () => {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query("set local role ogevia_owner");
      await expectPgError(client.query(readFileSync(new URL("../rollback/0029_billing_rounding.down.sql", import.meta.url), "utf8")),
        "P0001", /ROLLBACK REFUSED: billing rounding policies or adjustments exist/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
