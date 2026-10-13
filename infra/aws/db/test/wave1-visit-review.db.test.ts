// Wave 1 (0050): visits that need a person's review, the attestation record, and the agency's schedule-variance rule.
// Owner decisions 2026-10-13: D-U unscheduled visits go to review for every caregiver (reason required, nothing invented);
// D-S a per-agency, effective-dated, versioned rule with a conservative system default; O-2 a visit held for review keeps its
// normal capped billable minutes and cannot be approved until it is reviewed. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 5000);
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const recordOf = async (a: Actor) =>
  (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [a.userId, w.orgA])).rows[0].id as string;
const outcome = (a: Actor, visit: string) => q(a, "select * from ogevia_api.get_visit_outcome($1)", [visit]).then((r) => r[0]);
const reasons = async (visit: string) => (await db.admin.query("select ogevia.visit_review_reasons($1) as r", [visit])).rows[0].r as string[];
const decide = (a: Actor, visit: string, decision: string, reason = "Synthetic review") =>
  q(a, "select ogevia_api.decide_visit_review($1, $2, $3, null) as id", [visit, decision, reason]).then((r) => r[0].id as string);
const approve = (a: Actor, visit: string, minutes: number) => q(a, "select ogevia_api.approve_visit_for_billing($1, $2, null, null) as id", [visit, minutes]).then((r) => r[0].id as string);

/** A scheduled shift for `a` that a visit started now links to (test setup), `minutes` long. */
async function shiftFor(a: Actor, f: { client: string; service: string }, minutes: number) {
  const rec = await recordOf(a);
  return (
    await db.admin.query<{ id: string }>(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
       values ($1,$2,$3,$4,$5, now() - interval '1 minute', now() - interval '1 minute' + make_interval(mins => $6)) returning id`,
      [w.orgA, f.client, f.service, a.userId, rec, minutes],
    )
  ).rows[0]!.id;
}

/** Start (optionally on a scheduled shift) -> age -> end -> evidence -> confirm. */
async function run(a: Actor, f: { client: string; service: string }, o: { shiftMinutes?: number; worked: number; reason?: string | null; method?: string; attest?: string | null }) {
  if (o.shiftMinutes) await shiftFor(a, f, o.shiftMinutes);
  const visit = await asActor(db, a.sub, async (c) =>
    (await c.query("select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null,$4) as id", [w.orgA, f.client, f.service, o.reason === undefined ? "Synthetic: not on my schedule" : o.reason])).rows[0].id as string);
  await ageVisit(db, visit, o.worked);
  await api.end(db, a, visit);
  const method = o.method ?? "draw";
  const evidence = method === "draw" || method === "assisted_mark" ? await api.registerEvidence(db, a, w.orgA, visit) : null;
  const result = await asActor(db, a.sub, async (c) =>
    (await c.query("select * from ogevia_api.confirm_service_visit($1,'client',$2,$3,null,null,$4,null,$5)",
      [visit, method, evidence, method === "unable_to_confirm" ? "Synthetic: client asleep" : null, o.attest ?? null])).rows[0]);
  return { visit, result };
}

describe("D-U: unscheduled visits (G01)", () => {
  it("refuses to start a visit with no scheduled shift and no reason; nothing is saved", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const before = (await db.admin.query("select count(*)::int n from ogevia.service_visits")).rows[0].n;
    for (const reason of [null, "", "  ", "ab"]) {
      await expectPgError(
        asActor(db, w.caregiverA1.sub, (c) => c.query("select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null,$4)", [w.orgA, f.client, f.service, reason])),
        "OGV22", /reason is required to start a visit without a scheduled shift/);
    }
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits")).rows[0].n).toBe(before);
  });

  it("a signed unscheduled visit goes to review with its reason, keeps its billable minutes, and is not billing ready (O-2)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const { visit, result } = await run(w.caregiverA1, f, { worked: 45, reason: "Client asked me to come (synthetic)" });
    expect(result).toMatchObject({ status: "administrator_review", authorization_status: "within_authorization", worked_minutes: 45, billable_minutes: 45 });
    expect(await reasons(visit)).toEqual(["unscheduled"]);
    const o = await outcome(w.caregiverA1, visit);
    expect(o).toMatchObject({ status: "administrator_review", verified_minutes: 45, billable_minutes: 45, review_reasons: ["unscheduled"], unscheduled_reason: "Client asked me to come (synthetic)" });
    const row = (await db.admin.query("select scheduled_shift_id, unscheduled_reason from ogevia.service_visits where id = $1", [visit])).rows[0];
    expect(row).toEqual({ scheduled_shift_id: null, unscheduled_reason: "Client asked me to come (synthetic)" });
    // Approval waits for a review decision.
    await expectPgError(approve(w.managerA, visit, 45), "OGC09", /must be reviewed first/);
    expect((await q(w.managerA, "select * from ogevia_api.get_visit_review($1)", [visit]))[0]).toMatchObject({
      review_reasons: ["unscheduled"], allowed_decisions: ["accept_capped_billable", "close_not_billable"], can_decide: true });
  });

  it("applies to a flexible caregiver as well (Q-F)", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 6000, w.orgA, { before: 40, after: 40 });
    await db.admin.query("update ogevia.caregiver_records set scheduling_mode = 'flexible' where linked_user_id = $1 and organization_id = $2", [w.caregiverA2.userId, w.orgA]);
    const { visit, result } = await run(w.caregiverA2, f, { worked: 30 });
    expect(result.status).toBe("administrator_review");
    expect(await reasons(visit)).toEqual(["unscheduled"]);
  });

  it("after the review decision, billing approval is allowed up to the capped billable minutes and no further", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const { visit } = await run(w.caregiverA1, f, { worked: 40 });
    await decide(w.managerA, visit, "accept_capped_billable", "Valid visit: client was ill (synthetic)");
    await expectPgError(approve(w.managerA, visit, 41), "OGV22", /between 0 and the billable minutes/);
    await approve(w.managerA, visit, 40);
    expect((await db.admin.query("select approved_minutes from ogevia.billing_approvals where visit_id = $1 and voided_at is null", [visit])).rows[0].approved_minutes).toBe(40);
  });

  it("control: a visit on its scheduled shift, inside the rule, is still signed (billing ready)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const { visit, result } = await run(w.caregiverA1, f, { shiftMinutes: 60, worked: 60 });
    expect(result.status).toBe("signed");
    expect(await reasons(visit)).toBeNull();
    expect((await db.admin.query("select scheduled_shift_id from ogevia.service_visits where id = $1", [visit])).rows[0].scheduled_shift_id).not.toBeNull();
  });

  it("an unscheduled visit with no client signature has both reasons and 0 billable", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const { visit, result } = await run(w.caregiverA1, f, { worked: 20, method: "unable_to_confirm" });
    expect(result).toMatchObject({ status: "administrator_review", billable_minutes: 0 });
    expect(await reasons(visit)).toEqual(["no_client_signature", "unscheduled"]);
  });

  it("an unscheduled visit that also goes over the authorization lists every reason, in a fixed order", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 30, w.orgA, { before: 40, after: 40 });
    const { visit, result } = await run(w.caregiverA1, f, { worked: 50 });
    expect(result).toMatchObject({ status: "administrator_review", authorization_status: "exceeds_authorization", billable_minutes: 30 });
    expect(await reasons(visit)).toEqual(["over_authorization", "unscheduled"]);
  });

  it("a retried start with the same key is one visit and one reason", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 6000, w.orgA, { before: 40, after: 40 });
    const key = randomUUID();
    const go = () => asActor(db, w.caregiverA3.sub, async (c) =>
      (await c.query("select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,$4,'Synthetic: retry') as id", [w.orgA, f.client, f.service, key])).rows[0].id as string);
    const a = await go();
    expect(await go()).toBe(a);
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where id = $1", [a])).rows[0].n).toBe(1);
  });
});

describe("attestation record (G06)", () => {
  it("stores the wording version the API passes, with the confirmation; absent stays NULL", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const a = await run(w.caregiverA1, f, { shiftMinutes: 30, worked: 30, attest: "attest-v1" });
    expect((await outcome(w.caregiverA1, a.visit)).attestation_version).toBe("attest-v1");
    const g = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const b = await run(w.caregiverA1, g, { shiftMinutes: 30, worked: 30, attest: null });
    expect((await outcome(w.caregiverA1, b.visit)).attestation_version).toBeNull();
  });
});

describe("get_visit_outcome (G07)", () => {
  it("equals the confirm result and the stored visit; a stranger and another agency get nothing", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const { visit, result } = await run(w.caregiverA1, f, { shiftMinutes: 60, worked: 60 });
    const o = await outcome(w.caregiverA1, visit);
    expect(o).toMatchObject({ status: result.status, worked_minutes: result.worked_minutes, billable_minutes: result.billable_minutes, verified_minutes: 60, confirmation_method: "draw" });
    expect(await outcome(w.managerA, visit)).toMatchObject({ visit_id: visit });
    expect(await outcome(w.caregiverA2, visit)).toBeUndefined();
    expect(await outcome(w.managerB, visit)).toBeUndefined();
  });
});

describe("D-S: the agency's schedule-variance rule (G02)", () => {
  const rules = (a: Actor) => q(a, "select * from ogevia_api.list_visit_rules($1)", [w.orgA]);
  const setRule = (a: Actor, minutes: number, from: string | null = null, reason: string | null = null, key: string | null = null) =>
    q(a, "select ogevia_api.set_visit_rule($1,$2,$3::date,$4,$5) as v", [w.orgA, minutes, from, reason, key]).then((r) => r[0].v as number);

  it("with no agency value the conservative system default applies (version 0, unverified placeholder) and sends the visit to review", async () => {
    expect((await rules(w.managerA))[0]).toMatchObject({ version: 0, minutes: 15, source: "system_default", in_effect: true });
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const { visit, result } = await run(w.caregiverA1, f, { shiftMinutes: 60, worked: 90 });
    expect(result).toMatchObject({ status: "administrator_review", billable_minutes: 90 });
    expect(await reasons(visit)).toEqual(["schedule_variance"]);
    expect(await outcome(w.managerA, visit)).toMatchObject({ rule_version: 0, rule_minutes: 15, rule_source: "system_default", rule_outcome: "over" });
  });

  it("a difference inside the rule is not sent to review (15 minutes is allowed, 16 is not)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const ok = await run(w.caregiverA1, f, { shiftMinutes: 60, worked: 75 });
    expect(ok.result.status).toBe("signed");
    const g = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const over = await run(w.caregiverA1, g, { shiftMinutes: 60, worked: 76 });
    expect(over.result.status).toBe("administrator_review");
  });

  it("only an administrator changes the rule; a manager, scheduler, caregiver or another agency cannot", async () => {
    for (const a of [w.managerA, w.schedulerA, w.caregiverA1, w.managerB]) {
      await expectPgError(setRule(a, 30), "OGA03", /Only an administrator/);
    }
    // Reading needs visits.read: manager and scheduler can, a caregiver and another agency cannot.
    expect((await rules(w.schedulerA)).length).toBeGreaterThan(0);
    expect(await rules(w.caregiverA1)).toEqual([]);
    expect(await rules(w.managerB)).toEqual([]);
  });

  it("validates minutes (1 to 240) and refuses a date in the past; a no-change save is refused; nothing is saved on refusal", async () => {
    await expectPgError(setRule(w.ownerA, 0), "OGV22", /between 1 and 240/);
    await expectPgError(setRule(w.ownerA, 241), "OGV22", /between 1 and 240/);
    const today = await orgToday(db);
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
    await expectPgError(setRule(w.ownerA, 30, yesterday), "OGV22", /today or later/);
    expect((await db.admin.query("select count(*)::int n from ogevia.agency_visit_rules where organization_id = $1", [w.orgA])).rows[0].n).toBe(0);
  });

  it("a change is a new version with who, when and why; the default stays listed; it applies to later visits only", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const before = await run(w.caregiverA1, f, { shiftMinutes: 60, worked: 90 }); // evaluated under the default (over)
    const version = await setRule(w.ownerA, 45, null, "Agency policy (synthetic)");
    expect(version).toBe(1);
    const list = await rules(w.ownerA);
    expect(list.map((r: any) => r.version)).toEqual([1, 0]);
    expect(list[0]).toMatchObject({ minutes: 45, source: "agency_setting", reason: "Agency policy (synthetic)", in_effect: true });
    expect(list[0].changed_by_name).toBeTruthy();
    expect(list[0].changed_at).toBeTruthy();
    expect(list[1]).toMatchObject({ version: 0, in_effect: false });
    // The earlier visit keeps the version it was evaluated under; a new 90-minute visit on a 60-minute shift is inside 45.
    expect(await outcome(w.managerA, before.visit)).toMatchObject({ rule_version: 0, rule_minutes: 15, rule_outcome: "over" });
    const g = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const after = await run(w.caregiverA1, g, { shiftMinutes: 60, worked: 100 });
    expect(after.result.status).toBe("signed");
    expect(await outcome(w.managerA, after.visit)).toMatchObject({ rule_version: 1, rule_minutes: 45, rule_source: "agency_setting", rule_outcome: "within" });
    // A save that changes nothing is refused.
    await expectPgError(setRule(w.ownerA, 45), "OGC09", /already the rule in effect/);
  });

  it("a rule dated in the future does not apply today", async () => {
    const today = await orgToday(db);
    const later = new Date(Date.parse(`${today}T12:00:00Z`) + 3 * 864e5).toISOString().slice(0, 10);
    await setRule(w.ownerA, 200, later, "Starts later (synthetic)");
    const f = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
    const { visit } = await run(w.caregiverA1, f, { shiftMinutes: 60, worked: 130 });
    expect(await outcome(w.managerA, visit)).toMatchObject({ rule_minutes: 45, rule_outcome: "over" });
    const inEffect = (await rules(w.ownerA)).filter((r: any) => r.in_effect).map((r: any) => r.minutes);
    expect(inEffect).toEqual([45]);
  });

  it("two simultaneous saves become two distinct versions; a retry with the same key is one version", async () => {
    const results = await Promise.allSettled([setRule(w.ownerA, 61), setRule(w.ownerA, 62)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const versions = (await db.admin.query("select version from ogevia.agency_visit_rules where organization_id = $1 order by version", [w.orgA])).rows.map((r) => r.version);
    expect(new Set(versions).size).toBe(versions.length);
    const key = randomUUID();
    const a = await setRule(w.ownerA, 77, null, null, key);
    expect(await setRule(w.ownerA, 77, null, null, key)).toBe(a);
  });

  it("the rule history is append-only and agency-scoped", async () => {
    await expect(db.admin.query("update ogevia.agency_visit_rules set minutes = 1")).rejects.toThrow();
    await expect(db.admin.query("delete from ogevia.agency_visit_rules")).rejects.toThrow();
    await expect(db.admin.query("update ogevia.visit_rule_evaluations set outcome = 'within'")).rejects.toThrow();
  });
});
