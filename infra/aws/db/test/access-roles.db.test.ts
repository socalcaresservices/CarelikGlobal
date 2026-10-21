// Owner / manager / finance access in the AWS Service Verification database.
// Synthetic world from harness.ts: org A (owner, manager, scheduler,
// caregivers) and org B (manager, caregiver), plus an outsider with no
// membership. Every call runs as the application role through begin_request,
// exactly like the API Lambda.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  asActor,
  createTestDb,
  endedVisit,
  expectPgError,
  freshClient,
  seedWorld,
  signedVisit,
  type Actor,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;
let rated: { client: string; auth: string };
// TEST-ONLY: authorization versions are immutable, so the synthetic rate is
// set with triggers disabled in a separate admin session (like ageVisit).
async function setRate(cents: number) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query("update ogevia.client_authorizations set hourly_rate_cents = $2 where id = $1", [rated.auth, cents]);
  } finally {
    await c.query("reset session_replication_role");
    c.release();
  }
}
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
  // One signed (Billing Ready) visit in org A so billing review has a row.
  rated = await freshClient(db, w, w.caregiverA1, 600);
  // Synthetic $30.00/hour so owner-only amounts have something to hide.
  await setRate(3000);
  await signedVisit(db, w.caregiverA1, w, 30, w.orgA, rated.client);
});
afterAll(async () => db?.drop());

const context = (a: Actor) =>
  asActor(db, a.sub, async (c) => (await c.query("select organization_id, role, permissions from ogevia_api.get_my_context()")).rows);
const billingReview = (a: Actor, org: string) =>
  asActor(db, a.sub, async (c) =>
    (await c.query("select * from ogevia_api.list_billing_review_visits($1, current_date - 40, current_date + 40)", [org])).rows);

describe("effective permissions per role (get_my_context)", () => {
  it("owner: visits, authorizations, billing review and billing.approve in its own agency only", async () => {
    const rows = await context(w.ownerA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: w.orgA, role: "organization_owner" });
    expect(rows[0].permissions).toEqual(expect.arrayContaining(["billing.visits.read", "billing.approve", "visits.manage", "authorizations.update"]));
  });

  it("manager: may approve billing (owner decision 2026-10-03) but never sees dollar amounts", async () => {
    const [m] = await context(w.managerA);
    expect(m.role).toBe("manager");
    expect(m.permissions).toEqual(expect.arrayContaining(["billing.visits.read", "billing.approve"]));
    expect(m.permissions).not.toContain("billing.read");
  });

  it("scheduler and caregiver: no billing permission", async () => {
    for (const a of [w.schedulerA, w.caregiverA1]) {
      const [m] = await context(a);
      expect(m.permissions).not.toContain("billing.visits.read");
      expect(m.permissions).not.toContain("billing.approve");
    }
  });

  it("outsider with no membership: no agency at all", async () => {
    expect(await context(w.outsider)).toEqual([]);
  });

  it("dollar amounts (billing.read) are owner-only; there is no finance role and no submission permission", async () => {
    const { rows } = await db.admin.query("select key from ogevia.permissions where key like 'billing.%' order by key");
    expect(rows.map((r) => r.key)).toEqual(["billing.approve", "billing.read", "billing.rounding.manage", "billing.visits.read"]);
    const holders = await db.admin.query("select role::text from ogevia.role_permissions where permission_key = 'billing.read'");
    expect(holders.rows.map((r) => r.role)).toEqual(["organization_owner"]);
    // Rounding policies (0029) are set by the Administrator only.
    const rounding = await db.admin.query("select role::text from ogevia.role_permissions where permission_key = 'billing.rounding.manage'");
    expect(rounding.rows.map((r) => r.role)).toEqual(["organization_owner"]);
    const roles = await db.admin.query("select unnest(enum_range(null::ogevia.system_role))::text as r");
    expect(roles.rows.map((r) => r.r)).not.toContain("finance");
  });
});

describe("billing review is enforced in the database, not only hidden in the UI", () => {
  it("owner and manager of org A see org A's Billing Ready visit", async () => {
    expect((await billingReview(w.ownerA, w.orgA)).length).toBeGreaterThan(0);
    expect((await billingReview(w.managerA, w.orgA)).length).toBeGreaterThan(0);
  });

  it("scheduler and caregiver of org A get nothing, even when calling the function directly", async () => {
    expect(await billingReview(w.schedulerA, w.orgA)).toEqual([]);
    expect(await billingReview(w.caregiverA1, w.orgA)).toEqual([]);
  });

  it("cross-agency: org B's manager and the outsider get nothing for org A", async () => {
    expect(await billingReview(w.managerB, w.orgA)).toEqual([]);
    expect(await billingReview(w.outsider, w.orgA)).toEqual([]);
  });

  it("billing review exposes no rates or dollar amounts", async () => {
    const [row] = await billingReview(w.ownerA, w.orgA);
    expect(Object.keys(row).filter((k) => /rate|amount|cents|price|revenue|pay/i.test(k))).toEqual([]);
  });
});

// Owner decision 2026-10-03: managers may approve billing; dollar amounts,
// rates and finances stay owner-only. Approval is not submission.
describe("billing approval (0019)", () => {
  const approve = (a: Actor, visit: string, minutes: number, notes: string | null = null, key: string | null = null) =>
    asActor(db, a.sub, async (c) =>
      (await c.query("select ogevia_api.approve_visit_for_billing($1,$2,$3,$4) as id", [visit, minutes, notes, key])).rows[0].id as string);
  const voidIt = (a: Actor, id: string, reason: string, key: string | null = null) =>
    asActor(db, a.sub, async (c) => (await c.query("select ogevia_api.void_billing_approval($1,$2,$3) as id", [id, reason, key])).rows[0].id as string);
  const approvals = (a: Actor, org = w.orgA) =>
    asActor(db, a.sub, async (c) =>
      (await c.query("select * from ogevia_api.list_billing_approvals($1, current_date - 40, current_date + 40)", [org])).rows);
  const billingReady = async (minutes = 30) => (await signedVisit(db, w.caregiverA1, w, minutes, w.orgA, rated.client)).visit;

  it("a manager approves a Billing Ready visit; the approval is audited with minutes only", async () => {
    const visit = await billingReady(30);
    const id = await approve(w.managerA, visit, 30, "Checked against the timesheet");
    const audit = await db.admin.query("select action, actor_user_id, after_state from ogevia.audit_events where entity_id = $1", [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ action: "billing.approved", actor_user_id: w.managerA.userId });
    expect(Object.keys(audit.rows[0].after_state).filter((k) => /rate|amount|cents/.test(k))).toEqual([]);
    // The visit itself is unchanged: approval is a separate record, not a status rewrite.
    const v = await db.admin.query("select status from ogevia.service_visits where id = $1", [visit]);
    expect(v.rows[0].status).toBe("signed");
  });

  it("the manager sees approvals without dollar amounts; the owner sees the snapshotted rate and amount", async () => {
    const visit = await billingReady(30);
    const id = await approve(w.ownerA, visit, 30);
    const m = (await approvals(w.managerA)).find((r) => r.billing_approval_id === id)!;
    expect(m).toMatchObject({ approved_minutes: 30, rate_cents: null, amount_cents: null });
    const o = (await approvals(w.ownerA)).find((r) => r.billing_approval_id === id)!;
    expect(o).toMatchObject({ approved_minutes: 30, rate_cents: 3000, amount_cents: 1500 });
  });

  it("the approved amount does not change when the rate changes later (snapshot)", async () => {
    const visit = await billingReady(30);
    const id = await approve(w.managerA, visit, 30);
    await setRate(9000);
    try {
      const o = (await approvals(w.ownerA)).find((r) => r.billing_approval_id === id)!;
      expect(o).toMatchObject({ rate_cents: 3000, amount_cents: 1500 });
    } finally {
      await setRate(3000);
    }
  });

  it("scheduler, caregiver, another agency's manager and an outsider cannot approve or list", async () => {
    const visit = await billingReady(20);
    await expectPgError(approve(w.schedulerA, visit, 20), "OGA03");
    await expectPgError(approve(w.caregiverA1, visit, 20), "OGA03");
    await expectPgError(approve(w.managerB, visit, 20), "OGN04");
    await expectPgError(approve(w.outsider, visit, 20), "OGN04");
    expect(await approvals(w.schedulerA)).toEqual([]);
    expect(await approvals(w.caregiverA1)).toEqual([]);
    expect(await approvals(w.managerB)).toEqual([]);
    expect(await approvals(w.outsider)).toEqual([]);
  });

  it("refuses more than the billable minutes, a second active approval, and a visit needing review", async () => {
    const visit = await billingReady(20);
    await expectPgError(approve(w.managerA, visit, 21), "OGV22");
    await expectPgError(approve(w.managerA, visit, -1), "OGV22");
    await approve(w.managerA, visit, 20);
    await expectPgError(approve(w.ownerA, visit, 20), "OGC09", /already has an active billing approval/);

    const unconfirmed = await endedVisit(db, w.caregiverA1, w, 15, w.orgA, rated.client);
    const r = await api.confirm(db, w.caregiverA1, unconfirmed, { method: "unable_to_confirm", reason: "Client asleep" });
    expect(r.status).toBe("administrator_review");
    await expectPgError(approve(w.managerA, unconfirmed, 0), "OGC09", /must be resolved first/);
  });

  it("a retried approval with the same key returns the same approval and writes nothing twice", async () => {
    const visit = await billingReady(25);
    const key = "6f1f7a3e-1111-4c4c-8d8d-000000000019";
    const a = await approve(w.managerA, visit, 25, null, key);
    const b = await approve(w.managerA, visit, 25, null, key);
    expect(b).toBe(a);
    const n = await db.admin.query("select count(*)::int as n from ogevia.billing_approvals where visit_id = $1", [visit]);
    expect(n.rows[0].n).toBe(1);
  });

  it("concurrent approvals of one visit: exactly one succeeds", async () => {
    const visit = await billingReady(25);
    const results = await Promise.allSettled([approve(w.managerA, visit, 25), approve(w.ownerA, visit, 25)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const n = await db.admin.query("select count(*)::int as n from ogevia.billing_approvals where visit_id = $1 and voided_at is null", [visit]);
    expect(n.rows[0].n).toBe(1);
  });

  it("an approved visit cannot be corrected until the approval is voided (with a reason); then it can", async () => {
    // Own caregiver and client: the other tests' visits would overlap the correction.
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    const id = await approve(w.managerA, visit, 30);
    const row = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [visit])).rows[0];
    const newOut = new Date(new Date(row.time_out).getTime() - 5 * 60_000);
    await expectPgError(api.correct(db, w.managerA, visit, row.time_in, newOut, "Left early"), "OGC09", /void the billing approval/);
    await expectPgError(voidIt(w.managerA, id, "  "), "OGV22");
    await expectPgError(voidIt(w.schedulerA, id, "Wrong time"), "OGA03");
    await voidIt(w.managerA, id, "Wrong Time Out");
    await expectPgError(voidIt(w.managerA, id, "again"), "OGC09");
    const corrected = await api.correct(db, w.managerA, visit, row.time_in, newOut, "Left early");
    expect(corrected).toBeTruthy();
    const o = (await approvals(w.ownerA)).find((r) => r.billing_approval_id === id)!;
    expect(o.voided_at).not.toBeNull();
    expect(o.void_reason).toBe("Wrong Time Out");
    const audit = await db.admin.query("select action from ogevia.audit_events where entity_id = $1 order by id", [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["billing.approved", "billing.approval_voided"]);
  });

  it("approval rows are append-only: no direct edits or deletes, even by the table owner", async () => {
    const visit = await billingReady(10);
    const id = await approve(w.managerA, visit, 10);
    await expectPgError(db.admin.query("update ogevia.billing_approvals set approved_minutes = 5 where id = $1", [id]), "OGC09");
    await expectPgError(db.admin.query("delete from ogevia.billing_approvals where id = $1", [id]), "OGC09");
  });

  it("there is still no submission, invoice, export, payroll or revenue function (approval is not submission)", async () => {
    const { rows } = await db.admin.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname ~ '(submit|invoice|export|payroll|revenue|margin)'");
    // 0069/0072 added four functions that match "export": they record that a report was requested, completed or failed (an audit ledger) and list that ledger. They send nothing to anyone and never submit,
    // invoice or pay. They are named here on purpose so any other match still fails this test.
    expect(rows.map((r) => r.proname).sort()).toEqual(["complete_report_export", "fail_report_export", "list_report_exports", "request_report_export"]);
  });

  it("the application role cannot write billing state directly (no table privileges)", async () => {
    await expect(
      asActor(db, w.managerA.sub, (c) => c.query("update ogevia.service_visits set status = status where organization_id = $1", [w.orgA])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asActor(db, w.managerA.sub, (c) => c.query("select * from ogevia.billing_approvals")),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
