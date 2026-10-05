// 0031 Visit review decisions. A visit that needs review gets an explicit,
// audited decision; nothing becomes billable by being opened or reviewed, a
// no-signature visit can never be accepted as billable, and the visit record
// itself never changes. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const review = (a: Actor, visit: string) => q(a, "select * from ogevia_api.get_visit_review($1)", [visit]).then((r) => r[0]);
const decide = (a: Actor, visit: string, decision: string, reason: string | null = "Synthetic review", key: string | null = null) =>
  q(a, "select ogevia_api.decide_visit_review($1, $2, $3, $4) as id", [visit, decision, reason, key]).then((r) => r[0].id as string);
const revoke = (a: Actor, id: string, reason = "Synthetic revoke") => q(a, "select ogevia_api.revoke_visit_review_decision($1, $2, null) as id", [id, reason]);
const approve = (a: Actor, visit: string, minutes: number) => q(a, "select ogevia_api.approve_visit_for_billing($1, $2, null, null) as id", [visit, minutes]).then((r) => r[0].id as string);
const attention = async () => (await q(w.managerA, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]))[0];
const billingRow = async (visit: string) =>
  (await q(w.managerA, "select * from ogevia_api.list_billing_review_visits($1, (now() at time zone 'America/Los_Angeles')::date - 2, (now() at time zone 'America/Los_Angeles')::date + 1)", [w.orgA]))
    .find((r) => r.visit_id === visit);
const visitRow = async (visit: string) =>
  (await db.admin.query("select status, time_in, time_out, worked_minutes, verified_minutes, billable_minutes, authorization_status, locked_at from ogevia.service_visits where id = $1", [visit])).rows[0];

async function noSignerVisit(minutes = 20) {
  const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 40 });
  const v = await api.start(db, w.caregiverA1, w.orgA, fresh.client, fresh.service);
  await ageVisit(db, v, minutes);
  await api.end(db, w.caregiverA1, v);
  const r = await api.confirm(db, w.caregiverA1, v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  expect(r.status).toBe("administrator_review");
  return v;
}

describe("no-signer visit", () => {
  it("shows why it is in review and the no-signer reason; opening it changes nothing", async () => {
    const v = await noSignerVisit();
    const before = await attention();
    const r = await review(w.managerA, v);
    expect(r).toMatchObject({
      visit_status: "administrator_review", confirmation_method: "unable_to_confirm",
      confirmation_reason: "Client asleep; parent not home (synthetic)", billable_minutes: 0,
      review_reasons: ["no_client_signature"], decision: null, can_decide: true, allowed_decisions: ["close_not_billable"],
    });
    expect(r.client_code).toBeTruthy();
    expect(r.caregiver_name).toBeTruthy();
    expect(await attention()).toEqual(before);
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_review_decisions where visit_id = $1", [v])).rows[0].n).toBe(0);
  });

  it("cannot be accepted as billable; closing it as not billable is audited and leaves the record and billable minutes unchanged", async () => {
    const v = await noSignerVisit();
    const before = await visitRow(v);
    const att = await attention();
    await expectPgError(decide(w.managerA, v, "accept_capped_billable"), "OGC09", /only when the client signed or marked/);
    await expectPgError(decide(w.managerA, v, "close_not_billable", "  "), "OGV22", /reason/);
    const id = await decide(w.managerA, v, "close_not_billable", "Parent could not be reached; not billable (synthetic)");
    expect(await visitRow(v)).toEqual(before);
    expect((await attention()).needs_review).toBe(att.needs_review - 1);
    expect(await billingRow(v)).toMatchObject({ review_state: "reviewed_not_billable", billable_minutes: 0, review_decision: "close_not_billable" });
    await expectPgError(approve(w.managerA, v, 0), "OGC09", /must be reviewed first/);
    const audit = (await db.admin.query("select action, reason from ogevia.audit_events where entity_id = $1", [id])).rows;
    expect(audit).toEqual([{ action: "visit.review_decided", reason: "Parent could not be reached; not billable (synthetic)" }]);
    await expectPgError(decide(w.managerA, v, "close_not_billable"), "OGC09", /already has a review decision/);
    // Revoking (for example, a signature arrived) returns it to Needs attention; history is kept.
    await revoke(w.managerA, id);
    expect((await attention()).needs_review).toBe(att.needs_review);
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_review_decisions where visit_id = $1", [v])).rows[0].n).toBe(1);
    await expectPgError(revoke(w.managerA, id), "OGC09", /already revoked/);
  });
});

describe("over-authorization visit with a signature", () => {
  it("accepting the capped minutes makes only those minutes eligible for the separate human approval", async () => {
    const small = await freshClient(db, w, w.caregiverA2, 30, w.orgA, { before: 40, after: 40 });
    const { visit: v, result } = await signedVisit(db, w.caregiverA2, w, 50, w.orgA, small.client, small.service);
    expect(result.status).toBe("administrator_review");
    const before = await visitRow(v);
    expect(before).toMatchObject({ worked_minutes: 50, billable_minutes: 30, authorization_status: "exceeds_authorization" });
    expect(await review(w.managerA, v)).toMatchObject({ review_reasons: ["over_authorization"], allowed_decisions: ["accept_capped_billable", "close_not_billable"] });
    await expectPgError(approve(w.managerA, v, 30), "OGC09", /reviewed first/);
    const key = randomUUID();
    const id = await decide(w.managerA, v, "accept_capped_billable", "Signed; the 20 minutes over the authorization are not billable (synthetic)", key);
    expect(await decide(w.managerA, v, "accept_capped_billable", "Signed; the 20 minutes over the authorization are not billable (synthetic)", key)).toBe(id);
    expect(await billingRow(v)).toMatchObject({ review_state: "reviewed_eligible", billable_minutes: 30 });
    await expectPgError(approve(w.managerA, v, 31), "OGV22", /between 0 and the billable minutes \(30\)/);
    const approval = await approve(w.managerA, v, 30);
    expect(await visitRow(v)).toEqual(before);
    await expectPgError(revoke(w.managerA, id), "OGC09", /void the approval first/);
    await q(w.managerA, "select ogevia_api.void_billing_approval($1, 'Synthetic void', null)", [approval]);
    await revoke(w.managerA, id);
    await expectPgError(approve(w.managerA, v, 30), "OGC09", /reviewed first/);
  });
});

describe("permissions and agency isolation", () => {
  it("caregivers and other agencies cannot read or decide; a scheduler without visits.manage cannot decide", async () => {
    const v = await noSignerVisit();
    expect(await review(w.caregiverA2, v)).toBeUndefined();
    expect(await review(w.managerB, v)).toBeUndefined();
    await expectPgError(decide(w.caregiverA1, v, "close_not_billable"), "OGA03");
    await expectPgError(decide(w.managerB, v, "close_not_billable"), "OGN04");
    // A scheduler can read visits (visits.read) but holds no visits.manage: no review actions.
    expect(await review(w.schedulerA, v)).toMatchObject({ can_decide: false, allowed_decisions: [] });
    await expectPgError(decide(w.schedulerA, v, "close_not_billable"), "OGA03");
  });

  it("a decision row cannot be edited or deleted", async () => {
    const v = await noSignerVisit();
    const id = await decide(w.managerA, v, "close_not_billable");
    await expect(db.admin.query("update ogevia.visit_review_decisions set reason = 'changed' where id = $1", [id])).rejects.toThrow(/cannot be changed/);
    await expect(db.admin.query("delete from ogevia.visit_review_decisions where id = $1", [id])).rejects.toThrow(/cannot be deleted/);
  });

  it("a signed (clean) visit has no review decisions available", async () => {
    const fresh = await freshClient(db, w, w.caregiverA3, 6000, w.orgA, { before: 40, after: 40 });
    const { visit: v } = await signedVisit(db, w.caregiverA3, w, 10, w.orgA, fresh.client, fresh.service);
    expect(await review(w.managerA, v)).toMatchObject({ visit_status: "signed", review_reasons: [], allowed_decisions: [] });
    await expectPgError(decide(w.managerA, v, "close_not_billable"), "OGC09", /needs review/);
  });
});
