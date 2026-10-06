// Approved-visit correction safety (0019 billing approval guard) and the Ready
// for Approval count (0036 get_attention_summary). SYNTHETIC data only.
//
// Workflow under test: void the approval with a reason -> correct the visit ->
// approve the corrected visit. A correction of an approved visit is refused;
// the superseded original can never regain an active approval; history stays.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
});
afterAll(async () => db?.drop());

const q = (a: Actor, sql: string, p: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, p)).rows as any[]);
const approve = (a: Actor, v: string, m: number, key: string | null = null) =>
  q(a, "select ogevia_api.approve_visit_for_billing($1,$2,null,$3) as id", [v, m, key]).then((r) => r[0].id as string);
const voidIt = (a: Actor, id: string, reason: string, key: string | null = null) =>
  q(a, "select ogevia_api.void_billing_approval($1,$2,$3) as id", [id, reason, key]);
const visitRow = async (v: string) =>
  (await db.admin.query("select time_in, time_out, status, billable_minutes from ogevia.service_visits where id=$1", [v])).rows[0];
const activeApprovalsByLineage = async (org: string) =>
  (await db.admin.query(
    `select coalesce(v.original_visit_id, v.id) root, count(*)::int n
       from ogevia.billing_approvals b join ogevia.service_visits v on v.id = b.visit_id
      where b.voided_at is null and b.organization_id = $1 group by 1`, [org])).rows;
const shorter = (row: { time_out: string }) => new Date(new Date(row.time_out).getTime() - 5 * 60_000);

describe("correcting an approved visit", () => {
  it("refused while approved; void with a reason, correct, re-approve; the original cannot regain an approval; history stays", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    const a1 = await approve(w.managerA, visit, 30);
    const t = await visitRow(visit);
    const newOut = shorter(t);
    await expectPgError(api.correct(db, w.managerA, visit, t.time_in, newOut, "Left early"), "OGC09", /void the billing approval/);
    expect((await visitRow(visit)).status).toBe("signed"); // the refused attempt changed nothing

    await expectPgError(voidIt(w.managerA, a1, "  "), "OGV22"); // a reason is required
    await voidIt(w.managerA, a1, "Wrong Time Out");
    const corrected = await api.correct(db, w.managerA, visit, t.time_in, newOut, "Left early");
    expect((await visitRow(visit)).status).toBe("corrected");

    // The superseded original can never be approved again, so the voided approval cannot be revived or double-counted.
    await expectPgError(approve(w.managerA, visit, 25), "OGC09");
    // The corrected visit is capped at its own billable minutes and gets exactly one active approval.
    const cb = (await visitRow(corrected)).billable_minutes;
    await expectPgError(approve(w.managerA, corrected, cb + 1), "OGV22");
    const a2 = await approve(w.managerA, corrected, cb);
    await expectPgError(approve(w.managerA, corrected, cb), "OGC09");
    expect((await activeApprovalsByLineage(w.orgA)).find((r) => r.root === visit)?.n).toBe(1);

    // History: both approvals exist (the first voided with its reason) and the audit trail is complete.
    const all = (await db.admin.query("select id, visit_id, voided_at is not null as v, void_reason from ogevia.billing_approvals where id = any($1)", [[a1, a2]])).rows;
    expect(all.find((r) => r.id === a1)).toMatchObject({ visit_id: visit, v: true, void_reason: "Wrong Time Out" });
    expect(all.find((r) => r.id === a2)).toMatchObject({ visit_id: corrected, v: false });
    const audit = await db.admin.query("select action from ogevia.audit_events where entity_id = any($1) order by id", [[a1, a2]]);
    expect(audit.rows.map((r) => r.action)).toEqual(["billing.approved", "billing.approval_voided", "billing.approved"]);
    // The stale approval cannot be voided twice or edited, even by the table owner.
    await expectPgError(voidIt(w.managerA, a1, "again"), "OGC09");
    await expectPgError(db.admin.query("update ogevia.billing_approvals set approved_minutes = 1 where id = $1", [a1]), "OGC09");
    // The approvals list shows only the corrected visit as actively approved.
    const list = await q(w.managerA, "select * from ogevia_api.list_billing_approvals($1, current_date - 40, current_date + 40)", [w.orgA]);
    expect(list.filter((r) => r.visit_id === visit && !r.voided_at)).toHaveLength(0);
    expect(list.filter((r) => r.visit_id === corrected && !r.voided_at)).toHaveLength(1);
  });

  it("retry: the same idempotency key replays an approval; the same key cannot approve different minutes; a retried void audits once", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    const key = randomUUID();
    const a = await approve(w.managerA, visit, 30, key);
    expect(await approve(w.managerA, visit, 30, key)).toBe(a);
    await expectPgError(approve(w.managerA, visit, 20, key), "OGI09");
    expect((await db.admin.query("select count(*)::int n from ogevia.billing_approvals where visit_id = $1", [visit])).rows[0].n).toBe(1);
    const voidKey = randomUUID();
    await voidIt(w.managerA, a, "Retry test", voidKey);
    await voidIt(w.managerA, a, "Retry test", voidKey);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'billing.approval_voided'", [a])).rows[0].n).toBe(1);
  });

  it("race: a concurrent approve and correct never leave an active approval on a corrected visit", async () => {
    for (let i = 0; i < 20; i++) {
      const own = await freshClient(db, w, w.caregiverA3, 600);
      const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
      const t = await visitRow(visit);
      const settled = await Promise.allSettled([approve(w.managerA, visit, 25), api.correct(db, w.managerA, visit, t.time_in, shorter(t), "Race")]);
      const bad = await db.admin.query(
        "select count(*)::int n from ogevia.billing_approvals b join ogevia.service_visits v on v.id = b.visit_id where b.voided_at is null and v.status = 'corrected'");
      expect(bad.rows[0].n).toBe(0);
      expect(settled.filter((x) => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("Ready for Approval count (Action needed)", () => {
  const ready = async () => (await q(w.managerA, "select billing_ready_unapproved from ogevia_api.get_attention_summary($1)", [w.orgA]))[0].billing_ready_unapproved as number;

  it("counts Billing Ready visits without an active approval; approving removes one, voiding restores it; it is hidden without billing review permission", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const before = await ready();
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    expect(await ready()).toBe(before + 1);
    const id = await approve(w.managerA, visit, 30);
    expect(await ready()).toBe(before); // an approved visit is excluded
    await voidIt(w.managerA, id, "Approved the wrong visit");
    expect(await ready()).toBe(before + 1); // not approved again, so actionable again
    // A scheduler may not review billing: the category is withheld (null), not counted as 0.
    const s = await q(w.schedulerA, "select billing_ready_unapproved from ogevia_api.get_attention_summary($1)", [w.orgA]);
    if (s.length > 0) expect(s[0].billing_ready_unapproved).toBeNull();
  });
});
