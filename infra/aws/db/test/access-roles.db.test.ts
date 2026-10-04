// Owner / manager / finance access in the AWS Service Verification database.
// Synthetic world from harness.ts: org A (owner, manager, scheduler,
// caregivers) and org B (manager, caregiver), plus an outsider with no
// membership. Every call runs as the application role through begin_request,
// exactly like the API Lambda.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asActor,
  createTestDb,
  freshClient,
  seedWorld,
  signedVisit,
  type Actor,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
  // One signed (Billing Ready) visit in org A so billing review has a row.
  const { client } = await freshClient(db, w, w.caregiverA1, 600);
  await signedVisit(db, w.caregiverA1, w, 30, w.orgA, client);
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

  it("manager: CURRENT policy grants billing.approve by default (matches production #46)", async () => {
    const [m] = await context(w.managerA);
    expect(m.role).toBe("manager");
    expect(m.permissions).toEqual(expect.arrayContaining(["billing.visits.read", "billing.approve"]));
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

  it("there is no finance role and no submission/financial-data permission in AWS", async () => {
    const { rows } = await db.admin.query("select key from ogevia.permissions where key like 'billing.%' order by key");
    expect(rows.map((r) => r.key)).toEqual(["billing.approve", "billing.visits.read"]);
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

describe("billing approval in the AWS path", () => {
  it("no API function approves, submits, or exports billing (billing.approve is granted but unused)", async () => {
    const { rows } = await db.admin.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname ~ '(approv|submit|invoice|export|payroll|revenue)'");
    expect(rows).toEqual([]);
    const uses = await db.admin.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('ogevia', 'ogevia_api') and p.prosrc like '%billing.approve%'");
    expect(uses.rows).toEqual([]);
  });

  it("the application role cannot write billing state directly (no table privileges)", async () => {
    await expect(
      asActor(db, w.managerA.sub, (c) => c.query("update ogevia.service_visits set status = status where organization_id = $1", [w.orgA])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
