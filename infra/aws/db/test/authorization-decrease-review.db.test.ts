// 0071: an authorization decrease sends affected UNAPPROVED Billing Ready visits back to review, with recorded reasons and preserved history; approved visits and every billable
// amount are left alone (owner request 2026-10-17, item 1). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
type Fx = { client: string; service: string; auth: string };
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const stateOf = async (v: string) => (await q("select ogevia.visit_billing_state($1) s", [v])).rows[0].s as string | null;
const approve = (a: Actor, visit: string, minutes: number) => as(a, "select ogevia_api.approve_visit_for_billing($1,$2,null,null) as id", [visit, minutes]).then((r) => r[0].id as string);
const resolve = (a: Actor, visit: string, note = "Payer confirmed the retroactive change does not apply (synthetic)") =>
  as(a, "select ogevia_api.resolve_visit_authorization_review($1,$2,$3) r", [visit, note, randomUUID()]).then((r) => r[0].r as Record<string, any>);
const review = (a: Actor, visit: string) => as(a, "select ogevia_api.get_visit_authorization_review($1) r", [visit]).then((r) => r[0].r as Record<string, any> | null);
const snapshot = async (v: string) => (await q("select status::text s, worked_minutes, verified_minutes, billable_minutes, time_in, time_out, authorization_status::text a from ogevia.service_visits where id = $1", [v])).rows[0];
const impactsFor = async (v: string) => (await q("select impact_kind, minutes, detail from ogevia.authorization_amendment_impacts where visit_id = $1 order by created_at", [v])).rows;
async function amend(f: Fx, minutes: number, period?: { start: string; end: string }) { return api.amend(db, w.ownerA, f.auth, minutes, "Synthetic: payer lowered the month", period); }

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
});
afterAll(async () => db?.drop());

describe("which visits an amendment affects", () => {
  it("only visits that actually exceed the new terms: time order within the agency month, rounding adjustments first; an unaffected visit is not reported", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 1000, w.orgA, { before: 40, after: 200 });
    const a = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service); // 60
    const b = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service); // 120 cumulative
    const c = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service); // 180 cumulative
    await amend(f, 130); // free = 130: a (60) fits, b (120) fits, c crosses (180 > 130) by 50
    expect((await impactsFor(a.visit))).toEqual([]);
    expect((await impactsFor(b.visit))).toEqual([]);
    const imp = await impactsFor(c.visit);
    expect(imp).toHaveLength(1);
    expect(imp[0]).toMatchObject({ impact_kind: "visit_over_cap", minutes: 60 });
    expect(imp[0].detail).toMatchObject({ excess_minutes: 50, billable_minutes: 60, new_monthly_minutes: 130, billing_state: "ready_for_review", approved_visit_unchanged: false });
    expect(await stateOf(a.visit)).toBe("ready_for_review");
    expect(await stateOf(b.visit)).toBe("ready_for_review");
    expect(await stateOf(c.visit)).toBe("needs_correction");
  });
});

describe("an unapproved Billing Ready visit returns to review, and nothing about it changes", () => {
  it("state becomes Needs Correction with the reason; approval is refused; the visit, its minutes and its signature are untouched; the reason and numbers are recorded with who and when", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 1000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA2, w, 90, w.orgA, f.client, f.service);
    const before = await snapshot(v.visit);
    const evidenceBefore = (await q("select count(*)::int n from ogevia.visit_confirmations where visit_id = $1", [v.visit])).rows[0].n;
    expect(await stateOf(v.visit)).toBe("ready_for_review");
    await amend(f, 30);
    expect(await snapshot(v.visit)).toEqual(before); // the visit row is exactly as it was
    expect((await q("select count(*)::int n from ogevia.visit_confirmations where visit_id = $1", [v.visit])).rows[0].n).toBe(evidenceBefore);
    expect(await stateOf(v.visit)).toBe("needs_correction");
    const row = (await as(w.managerA, "select billing_state, review_reasons, eligible_minutes, billable_minutes from ogevia_api.list_billing_review_visits($1, (now() at time zone 'America/Los_Angeles')::date - 2, (now() at time zone 'America/Los_Angeles')::date + 1) where visit_id = $2", [w.orgA, v.visit]))[0];
    expect(row).toMatchObject({ billing_state: "needs_correction", review_reasons: ["authorization_decreased"], billable_minutes: 90, eligible_minutes: 90 }); // the amount is NOT changed
    await expectPgError(approve(w.managerA, v.visit, 90), "OGC09", /authorization was lowered/i);
    expect((await q("select count(*)::int n from ogevia.billing_approvals where visit_id = $1", [v.visit])).rows[0].n).toBe(0);
    const rv = await review(w.managerA, v.visit);
    expect(rv).toMatchObject({ open: true });
    expect(rv!.reviews[0]).toMatchObject({ reason: "authorization_over_cap", billableMinutes: 90, excessMinutes: 60, newMonthlyMinutes: 30, openedByName: expect.any(String), resolvedAt: null });
    const audit = (await q("select actor_user_id, after_state, reason from ogevia.audit_events where entity_id = $1 and action = 'visit.authorization_review_opened'", [v.visit])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: w.ownerA.userId, reason: "Authorization lowered after the visit was confirmed" });
    expect(audit[0].after_state).toMatchObject({ excess_minutes: 60, previous_state: "ready_for_review" });
  });

  it("a person confirms it is still billable with a note: back to Ready for Review, minutes unchanged, approval possible, history kept; resolving twice is refused", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 1000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA2, w, 50, w.orgA, f.client, f.service);
    await amend(f, 20);
    expect(await stateOf(v.visit)).toBe("needs_correction");
    await expectPgError(resolve(w.managerA, v.visit, "short"), "OGV22", /at least 10/);
    await expectPgError(resolve(w.caregiverA2, v.visit), "OGA03");
    await expectPgError(as(w.managerB, "select ogevia_api.resolve_visit_authorization_review($1,'Checked everything carefully',null) r", [v.visit]), "OGN04");
    const out = await resolve(w.managerA, v.visit);
    expect(out).toMatchObject({ resolution: "confirmed_billable" });
    expect(await stateOf(v.visit)).toBe("ready_for_review");
    expect((await snapshot(v.visit)).billable_minutes).toBe(50);
    const rv = await review(w.managerA, v.visit);
    expect(rv).toMatchObject({ open: false });
    expect(rv!.reviews[0]).toMatchObject({ resolution: "confirmed_billable", resolutionNote: "Payer confirmed the retroactive change does not apply (synthetic)", resolvedByName: expect.any(String) });
    await expectPgError(resolve(w.managerA, v.visit), "OGC09", /no open authorization review/);
    expect((await q("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'visit.authorization_review_resolved'", [v.visit])).rows[0].n).toBe(1);
    const id = await approve(w.managerA, v.visit, 50); // a person may now approve it, at the unchanged amount
    expect(await stateOf(v.visit)).toBe("approved_for_billing");
    void id;
    await expect(q("delete from ogevia.visit_authorization_reviews where visit_id = $1", [v.visit])).rejects.toMatchObject({ code: "OGC09" });
    await expect(q("update ogevia.visit_authorization_reviews set excess_minutes = 1 where visit_id = $1", [v.visit])).rejects.toMatchObject({ code: "OGC09" });
  });

  it("a visit with a voided approval (awaiting re-approval) is also an unapproved Billing Ready visit and goes back to review", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 1000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA2, w, 40, w.orgA, f.client, f.service);
    const id = await approve(w.managerA, v.visit, 40);
    await as(w.managerA, "select ogevia_api.void_billing_approval($1,'Approved the wrong minutes (synthetic)',null)", [id]);
    expect(await stateOf(v.visit)).toBe("voided");
    await amend(f, 10);
    expect(await stateOf(v.visit)).toBe("needs_correction");
    await resolve(w.managerA, v.visit);
    expect(await stateOf(v.visit)).toBe("voided"); // back to exactly where it was
  });
});

describe("an APPROVED visit is reported and left exactly as it is", () => {
  it("state, approval, minutes and amount are unchanged; the impact says the approved visit was not changed; no review is opened", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 1000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA2, w, 80, w.orgA, f.client, f.service);
    const approvalId = await approve(w.managerA, v.visit, 80);
    const before = { visit: await snapshot(v.visit), approval: (await q("select * from ogevia.billing_approvals where id = $1", [approvalId])).rows[0] };
    await amend(f, 30);
    expect(await stateOf(v.visit)).toBe("approved_for_billing");
    expect(await snapshot(v.visit)).toEqual(before.visit);
    expect((await q("select * from ogevia.billing_approvals where id = $1", [approvalId])).rows[0]).toEqual(before.approval);
    const imp = await impactsFor(v.visit);
    expect(imp).toHaveLength(1);
    expect(imp[0].detail).toMatchObject({ billing_state: "approved_for_billing", approved_visit_unchanged: true, excess_minutes: 50 });
    expect((await review(w.managerA, v.visit))).toMatchObject({ open: false, reviews: [] });
    const listed = (await as(w.managerA, "select visit_billing_state, review_open, detail from ogevia_api.list_authorization_amendment_impacts($1,false) where visit_id = $2", [w.orgA, v.visit]))[0];
    expect(listed).toMatchObject({ visit_billing_state: "approved_for_billing", review_open: false });
  });

  it("an approval racing the amendment: either the approval is already there and the visit is only reported, or the review is opened first and the approval is refused; never both", async () => {
    for (let round = 0; round < 6; round++) {
      const f = await freshClient(db, w, w.caregiverA2, 1000, w.orgA, { before: 40, after: 200 });
      const v = await signedVisit(db, w.caregiverA2, w, 60, w.orgA, f.client, f.service);
      const res = await Promise.allSettled([approve(w.managerA, v.visit, 60), amend(f, 20)]);
      for (const r of res) if (r.status === "rejected") expect((r.reason as { code?: string }).code, String((r.reason as Error).message)).not.toBe("40P01");
      expect(res[1]!.status).toBe("fulfilled"); // the amendment always succeeds
      const state = await stateOf(v.visit);
      const approvals = (await q("select count(*)::int n from ogevia.billing_approvals where visit_id = $1 and voided_at is null", [v.visit])).rows[0].n;
      const open = (await q("select count(*)::int n from ogevia.visit_authorization_reviews where visit_id = $1 and resolved_at is null", [v.visit])).rows[0].n;
      if (res[0]!.status === "fulfilled") { expect([state, approvals, open]).toEqual(["approved_for_billing", 1, 0]); }
      else { expect((res[0] as PromiseRejectedResult).reason.code).toBe("OGC09"); expect([state, approvals, open]).toEqual(["needs_correction", 0, 1]); }
    }
  });
});

describe("other situations", () => {
  it("a visit already in review is reported but not given a second review; a corrected visit's old review no longer applies", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 1000, w.orgA, { before: 40, after: 200 });
    const nv = await api.start(db, w.caregiverA3, w.orgA, f.client, f.service, null, "Synthetic: extra help");
    await ageVisit(db, nv, 30);
    await api.end(db, w.caregiverA3, nv);
    await api.confirm(db, w.caregiverA3, nv, { method: "unable_to_confirm", reason: "Client asleep (synthetic)" });
    const s = await signedVisit(db, w.caregiverA3, w, 45, w.orgA, f.client, f.service);
    expect(await stateOf(nv)).toBe("needs_correction");
    await amend(f, 10);
    expect((await q("select count(*)::int n from ogevia.visit_authorization_reviews where visit_id = $1", [nv])).rows[0].n).toBe(0);
    expect(await stateOf(s.visit)).toBe("needs_correction");
    // the existing correction flow supersedes the original: its open review no longer applies and the corrected visit is judged on its own
    const corrected = await as(w.managerA, "select ogevia_api.correct_service_visit($1, now() - interval '400 minutes', now() - interval '370 minutes', 'Synthetic: shortened to fit', $2) as id", [s.visit, randomUUID()]);
    expect(await stateOf(s.visit)).toBeNull(); // the original is superseded
    expect(corrected[0].id).toBeTruthy();
    expect((await q("select count(*)::int n from ogevia.visit_authorization_reviews where visit_id = $1", [s.visit])).rows[0].n).toBe(1); // history kept
    await expectPgError(resolve(w.managerA, s.visit), "OGC09");
  });

  it("a shortened period: visits outside it are reported, unapproved ones go to review; an increase opens no review", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 5000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA2, w, 30, w.orgA, f.client, f.service);
    const rows = await amend(f, 5000, { start: day(-40), end: day(-30) }); // the period now ends 30 days ago, before today's visit
    expect(rows.filter((r: any) => r.affected_visit_id).map((r: any) => r.impact_kind)).toEqual(["visit_outside_period"]);
    expect(await stateOf(v.visit)).toBe("needs_correction");
    expect((await review(w.managerA, v.visit))!.reviews[0]).toMatchObject({ reason: "authorization_outside_period" });
    const g = await freshClient(db, w, w.caregiverA2, 100, w.orgA, { before: 40, after: 200 });
    const v2 = await signedVisit(db, w.caregiverA2, w, 30, w.orgA, g.client, g.service);
    await amend(g, 5000);
    expect(await stateOf(v2.visit)).toBe("ready_for_review");
  });

  it("the attention overview counts open reviews; tenants are isolated; a caregiver and another agency see nothing", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 1000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA2, w, 30, w.orgA, f.client, f.service);
    const count = async () => (await as(w.managerA, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]))[0].o.visitReview.authorizationReview as number;
    const base = await count();
    await amend(f, 5);
    expect(await count()).toBe(base + 1);
    await resolve(w.managerA, v.visit);
    expect(await count()).toBe(base);
    expect(await review(w.managerB, v.visit)).toBeNull();
    expect(await review(w.caregiverA1, v.visit)).toBeNull();
  });
});
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
