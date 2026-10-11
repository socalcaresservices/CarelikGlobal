// Billing rounding (0029) regression cases required before billing calculations
// are accepted (owner, 2026-10-05): retries, concurrency, correction after an
// adjustment, policy changes after approval, retroactive authorization changes
// and agency isolation. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let svc: string;
const PAYER = "Synthetic Regression Payer";
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 610);
  today = await orgToday(db);
  svc = (await db.admin.query("insert into ogevia.services (organization_id, code, name) values ($1, 'RRG', 'Rounding regression (synthetic)') returning id", [w.orgA])).rows[0].id;
});
afterAll(async () => db?.drop());

async function client(caregiver: Actor, monthlyMinutes: number) {
  const c = (await db.admin.query("insert into ogevia.clients (organization_id) values ($1) returning id", [w.orgA])).rows[0].id;
  await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
    [w.orgA, caregiver.userId, c, svc, today]);
  const a = (await db.admin.query(
    `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
     values ($1, $2, $3, $4, $5, date_trunc('month', $6::date)::date, (date_trunc('month', $6::date) + interval '1 month - 1 day')::date) returning id, lineage_id`,
    [w.orgA, c, svc, PAYER, monthlyMinutes, today])).rows[0];
  return { client: c as string, auth: a.id as string, lineage: a.lineage_id as string };
}
/** A new user with a role in an agency (and a caregiver record for caregivers), so its visits overlap no other test's. */
async function person(org: string, role: string): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic person') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,$3,'active')", [org, userId, role]);
  if (role === "caregiver") {
    await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Person')", [org, userId, "CG-" + sub.slice(0, 6)]);
  }
  return { userId, sub };
}
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const setPolicy = (a: Actor, o: { method?: string; inc?: number | null; basis?: string | null; from?: string; key?: string | null; reason?: string } = {}) =>
  q(a, "select * from ogevia_api.set_billing_rounding_policy($1, $2, $3, $4, $5, $6, 'Synthetic payer manual 7.1', '2026-01-15'::date, $7::date, $8, $9)",
    [w.orgA, PAYER, svc, o.method ?? "up", o.inc === undefined ? 15 : o.inc, o.basis === undefined ? "per_visit" : o.basis,
     o.from ?? "2026-01-01", o.reason ?? "Synthetic regression policy", o.key ?? null]).then((r) => r[0]);
const preview = (a: Actor = w.managerA, from: string = today, to: string = today) =>
  q(a, "select * from ogevia_api.list_billing_rounding_preview($1, $2::date, $3::date)", [w.orgA, from, to]);
const approveVisit = (a: Actor, visit: string, minutes: number) => q(a, "select ogevia_api.approve_visit_for_billing($1, $2, null, null) as id", [visit, minutes]).then((r) => r[0].id as string);
const voidApproval = (a: Actor, id: string) => q(a, "select ogevia_api.void_billing_approval($1, 'Synthetic void', null)", [id]);
const approveAdj = (a: Actor, visit: string, key: string | null = null, notes: string | null = null) =>
  q(a, "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, null, null, $3, $4)", [w.orgA, visit, notes, key]).then((r) => r[0]);
const voidAdj = (a: Actor, id: string, key: string | null = null) => q(a, "select ogevia_api.void_billing_rounding_adjustment($1, 'Synthetic void', $2) as id", [id, key]).then((r) => r[0].id);
const usage = async (lineage: string) => Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [lineage, today])).rows[0].n);
const count = async (sql: string, params: unknown[]) => Number((await db.admin.query(sql, params)).rows[0].n);

beforeAll(async () => {
  await client(w.caregiverA1, 6000); // an authorization naming the payer must exist before a policy
  await setPolicy(w.ownerA, { reason: "Payer bills 15-minute units rounded up (synthetic)" });
});

describe("retries (idempotency)", () => {
  it("retrying an approval with the same key returns the same adjustment and writes one row and one audit event", async () => {
    const c = await client(w.caregiverA1, 6000);
    const { visit } = await signedVisit(db, w.caregiverA1, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const key = "00000000-0000-4000-8000-000000000611";
    const first = await approveAdj(w.managerA, visit, key);
    const again = await approveAdj(w.managerA, visit, key);
    expect(again).toEqual(first);
    expect(await count("select count(*) n from ogevia.billing_rounding_adjustments where visit_id = $1", [visit])).toBe(1);
    expect(await count("select count(*) n from ogevia.audit_events where entity_id = $1 and action = 'billing.rounding_adjustment_approved'", [first.adjustment_id])).toBe(1);
    // The same key with a different request is refused instead of returning the earlier result.
    await expectPgError(approveAdj(w.managerA, visit, key, "different notes"), "OGI09", /already used for a different request/);
    // Void retries return the same result and void once.
    const vkey = "00000000-0000-4000-8000-000000000612";
    expect(await voidAdj(w.managerA, first.adjustment_id, vkey)).toBe(first.adjustment_id);
    expect(await voidAdj(w.managerA, first.adjustment_id, vkey)).toBe(first.adjustment_id);
    expect(await count("select count(*) n from ogevia.audit_events where entity_id = $1 and action = 'billing.rounding_adjustment_voided'", [first.adjustment_id])).toBe(1);
    // Without a key a second void is refused, not repeated.
    await expectPgError(voidAdj(w.managerA, first.adjustment_id), "OGC09", /already voided/);
  });

  it("retrying a policy change with the same key creates one version", async () => {
    const key = "00000000-0000-4000-8000-000000000613";
    const before = await count("select count(*) n from ogevia.billing_rounding_policies where organization_id = $1 and service_id = $2", [w.orgA, svc]);
    const a = await setPolicy(w.ownerA, { key, reason: "Same policy, retried (synthetic)" });
    const b = await setPolicy(w.ownerA, { key, reason: "Same policy, retried (synthetic)" });
    expect(b).toEqual(a);
    expect(await count("select count(*) n from ogevia.billing_rounding_policies where organization_id = $1 and service_id = $2", [w.orgA, svc])).toBe(before + 1);
  });
});

describe("concurrency", () => {
  it("two people approving the same adjustment at once: exactly one succeeds", async () => {
    const c = await client(w.caregiverA2, 6000);
    const { visit } = await signedVisit(db, w.caregiverA2, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const results = await Promise.allSettled([approveAdj(w.managerA, visit), approveAdj(w.ownerA, visit)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(failed.reason?.message)).toMatch(/already covers these visits|duplicate key/);
    expect(await count("select count(*) n from ogevia.billing_rounding_adjustments where visit_id = $1 and voided_at is null", [visit])).toBe(1);
    expect(await usage(c.lineage)).toBe(60);
  });

  it("two round-ups racing for the last authorized minutes never take the month past the cap", async () => {
    const c = await client(w.caregiverA3, 110);
    const v1 = (await signedVisit(db, w.caregiverA3, w, 50, w.orgA, c.client, svc)).visit;
    const v2 = (await signedVisit(db, w.caregiverA3, w, 50, w.orgA, c.client, svc)).visit;
    await approveVisit(w.managerA, v1, 50);
    await approveVisit(w.managerA, v2, 50);
    // 100 used, 10 left: each wants +10; only one can have it.
    await Promise.allSettled([approveAdj(w.managerA, v1), approveAdj(w.ownerA, v2)]);
    expect(await usage(c.lineage)).toBeLessThanOrEqual(110);
    const adjs = (await db.admin.query("select adjustment_minutes, capped_by_authorization from ogevia.billing_rounding_adjustments where covered_visit_ids && $1::uuid[] and voided_at is null order by approved_at", [[v1, v2]])).rows;
    expect(adjs.filter((r) => r.adjustment_minutes > 0)).toHaveLength(1);
  });

  it("two policy changes at once get consecutive version numbers", async () => {
    const before = await count("select max(version) n from ogevia.billing_rounding_policies where organization_id = $1 and service_id = $2", [w.orgA, svc]);
    await Promise.all([setPolicy(w.ownerA, { reason: "Concurrent change A (synthetic)" }), setPolicy(w.ownerA, { reason: "Concurrent change B (synthetic)" })]);
    const versions = (await db.admin.query("select version from ogevia.billing_rounding_policies where organization_id = $1 and service_id = $2 and version > $3 order by version", [w.orgA, svc, before])).rows.map((r) => r.version);
    expect(versions).toEqual([before + 1, before + 2]);
  });
});

describe("correction after an adjustment", () => {
  it("is refused until the adjustment and then the approval are voided; the corrected visit is rounded afresh; history is kept", async () => {
    const cg = await person(w.orgA, "caregiver");
    const c = await client(cg, 6000);
    const { visit } = await signedVisit(db, cg, w, 50, w.orgA, c.client, svc);
    const approval = await approveVisit(w.managerA, visit, 50);
    const adj = await approveAdj(w.managerA, visit);
    const v = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [visit])).rows[0];
    const newOut = new Date(new Date(v.time_out).getTime() - 10 * 60_000);
    await expectPgError(api.correct(db, w.managerA, visit, v.time_in, newOut, "Synthetic: caregiver left 10 minutes early"), "OGC09", /void the billing approval/);
    await expectPgError(voidApproval(w.managerA, approval), "OGC09", /void the rounding adjustment first/);
    await voidAdj(w.managerA, adj.adjustment_id);
    await voidApproval(w.managerA, approval);
    expect(await usage(c.lineage)).toBe(50);
    const corrected = await api.correct(db, w.managerA, visit, v.time_in, newOut, "Synthetic: caregiver left 10 minutes early");
    const row = (await db.admin.query("select status, worked_minutes, billable_minutes from ogevia.service_visits where id = $1", [corrected])).rows[0];
    expect(row.worked_minutes).toBe(40);
    // The original visit no longer appears for rounding; only the corrected row does.
    // A correction takes its service date from its own start time, and the 50-minute test visit starts before Los Angeles
    // midnight when the suite runs in the first 50 minutes of the day. Look up the corrected visit on its own date, and
    // look across both days so the original is checked on its date too.
    const correctedDay = (await db.admin.query("select service_date::text d from ogevia.service_visits where id = $1", [corrected])).rows[0].d as string;
    const p = await preview(w.managerA, correctedDay < today ? correctedDay : today, today);
    expect(p.find((r) => r.visit_id === visit)).toBeUndefined();
    expect(row).toEqual({ status: "signed", worked_minutes: 40, billable_minutes: 40 });
    expect(p.find((r) => r.visit_id === corrected)).toMatchObject({ worked_minutes: 40, state: "awaiting_visit_approval", proposed_minutes: 45 });
    // The voided adjustment and approval stay on record.
    expect((await db.admin.query("select voided_at is not null v, adjustment_minutes from ogevia.billing_rounding_adjustments where id = $1", [adj.adjustment_id])).rows[0]).toEqual({ v: true, adjustment_minutes: 10 });
    expect(await usage(c.lineage)).toBe(40);
    // Re-approval and re-rounding of the corrected visit work normally.
    await approveVisit(w.managerA, corrected, 40);
    expect(await approveAdj(w.managerA, corrected)).toMatchObject({ base_minutes: 40, proposed_minutes: 45, adjustment_minutes: 5 });
    expect(await usage(c.lineage)).toBe(45);
  });
});

describe("policy changes after approval", () => {
  it("a version effective after the service date does not change that date's proposal", async () => {
    const c = await client(w.caregiverA2, 6000);
    const { visit } = await signedVisit(db, w.caregiverA2, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const before = (await preview()).find((r) => r.visit_id === visit);
    const tomorrow = (await db.admin.query("select ($1::date + 1)::text d", [today])).rows[0].d;
    await setPolicy(w.ownerA, { method: "down", from: tomorrow, reason: "Payer rounds down from tomorrow (synthetic)" });
    const after = (await preview()).find((r) => r.visit_id === visit);
    expect(after).toMatchObject({ policy_version: before.policy_version, method: "up", proposed_minutes: 60 });
  });

  it("switching to no rounding leaves an approved adjustment in place, shown as approved under the earlier policy, until a person voids it", async () => {
    const c = await client(w.caregiverA3, 6000);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const adj = await approveAdj(w.managerA, visit);
    await setPolicy(w.ownerA, { method: "none", inc: null, basis: null, from: today, reason: "Payer stopped allowing rounding (synthetic)" });
    expect((await preview()).find((r) => r.visit_id === visit)).toMatchObject({ state: "approved_under_earlier_policy", adjustment_id: adj.adjustment_id, adjusted_minutes: 10 });
    expect(await usage(c.lineage)).toBe(60);
    await voidAdj(w.managerA, adj.adjustment_id);
    expect((await preview()).find((r) => r.visit_id === visit)).toMatchObject({ state: "no_rounding", proposed_minutes: 50 });
    expect(await usage(c.lineage)).toBe(50);
    await setPolicy(w.ownerA, { from: today, reason: "Rounding up again (synthetic)" });
  });

  it("a retroactive authorization decrease never rewrites an approved adjustment; the month shows the overage for a person to resolve", async () => {
    const c = await client(w.caregiverA1, 6000);
    const { visit } = await signedVisit(db, w.caregiverA1, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const adj = await approveAdj(w.managerA, visit);
    await api.amend(db, w.ownerA, c.auth, 55, "Synthetic retroactive decrease");
    const stored = (await db.admin.query("select proposed_minutes, adjustment_minutes, voided_at from ogevia.billing_rounding_adjustments where id = $1", [adj.adjustment_id])).rows[0];
    expect(stored).toEqual({ proposed_minutes: 60, adjustment_minutes: 10, voided_at: null });
    expect(await usage(c.lineage)).toBe(60);
    const cap = Number((await db.admin.query("select monthly_authorized_minutes n from ogevia.client_authorizations where lineage_id = $1 and is_current", [c.lineage])).rows[0].n);
    expect(cap).toBe(55);
    // Approving a NEW round-up under the reduced cap would be capped; the existing one is a person's decision to void.
  });
});

describe("agency isolation", () => {
  it("another agency cannot read, approve, void or set rounding for this agency", async () => {
    const c = await client(w.caregiverA2, 6000);
    const { visit } = await signedVisit(db, w.caregiverA2, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const adj = await approveAdj(w.managerA, visit);
    expect(await preview(w.managerB)).toEqual([]);
    expect(await q(w.managerB, "select * from ogevia_api.list_billing_rounding_policies($1)", [w.orgA])).toEqual([]);
    await expectPgError(approveAdj(w.managerB, visit), "OGN04");
    await expectPgError(voidAdj(w.managerB, adj.adjustment_id), "OGN04");
    const ownerB = await person(w.orgB, "organization_owner");
    await expectPgError(q(ownerB, "select * from ogevia_api.set_billing_rounding_policy($1, $2, $3, 'up', 15, 'per_visit', 'Synthetic ref 1234', '2026-01-01', '2026-01-01', 'r', null)", [w.orgA, PAYER, svc]), "OGN04");
    // The adjustment row is untouched by the refused attempts.
    expect((await db.admin.query("select voided_at from ogevia.billing_rounding_adjustments where id = $1", [adj.adjustment_id])).rows[0].voided_at).toBeNull();
  });

  it("caregivers cannot approve, void or see rounding in their own agency", async () => {
    const c = await client(w.caregiverA3, 6000);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 50, w.orgA, c.client, svc);
    await approveVisit(w.managerA, visit, 50);
    const adj = await approveAdj(w.managerA, visit);
    await expectPgError(voidAdj(w.caregiverA3, adj.adjustment_id), "OGA03");
    expect(await preview(w.caregiverA3)).toEqual([]);
  });
});
