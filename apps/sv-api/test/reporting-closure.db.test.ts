// Through the real Lambda handler (SYNTHETIC data only): agency performance, the audit report, and the billing-review and audit exports (0076).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
  const f = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
  await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service);
});
afterAll(async () => db?.drop());
async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const month = () => `${today.slice(0, 7)}-01`;
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

describe("performance and audit through the handler", () => {
  it("performance: counts and utilization for a manager, never a missed-visits figure; a caregiver is refused", async () => {
    const r = await call("GET /v1/reports/agency-performance", w.managerA, { query: { organizationId: w.orgA, monthStart: month() } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.performance.counts).toMatchObject({ shifts: expect.any(Number), cancelled: expect.any(Number) });
    expect(r.body.performance.missedVisits).toBeNull();
    expect((await call("GET /v1/reports/agency-performance", w.caregiverA1, { query: { organizationId: w.orgA, monthStart: month() } })).status).toBe(403);
    expect((await call("GET /v1/reports/agency-performance", w.managerA, { query: { organizationId: w.orgA } })).status).toBe(400);
  });

  it("audit report: owner only, a date range is required, and values never appear", async () => {
    const q = { organizationId: w.orgA, dateFrom: day(-1), dateTo: day(1) };
    const ok = await call("GET /v1/reports/audit", w.ownerA, { query: q });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.report.total).toBeGreaterThan(0);
    expect((await call("GET /v1/reports/audit", w.managerA, { query: q })).status).toBe(403);
    expect((await call("GET /v1/reports/audit", w.ownerA, { query: { organizationId: w.orgA } })).status).toBe(400);
    expect((await call("GET /v1/reports/audit", w.ownerA, { query: { ...q, actionPrefix: "x'; drop" } })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("the two new exports", () => {
  it("billing review: the server generates the CSV, records request then generation, and says approval is not submission or payment", async () => {
    const r = await call("POST /v1/exports", w.managerA, { body: { organizationId: w.orgA, report: "billing_review", params: { monthStart: month() } }, key: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.filename).toBe(`billing-review-${today.slice(0, 7)}.csv`);
    expect(r.body.csv).toContain("Billing state");
    expect(r.body.csv).toContain("Approval is not submission or payment");
    expect(r.body.rowCount).toBeGreaterThan(0);
    const ledger = await db.admin.query("select e.event from ogevia.report_export_events e join ogevia.report_exports x on x.id = e.export_id where x.id = $1 order by e.id", [r.body.exportId]);
    expect(ledger.rows.map((x: any) => x.event)).toEqual(["requested", "generated"]);
    expect((await call("POST /v1/exports", w.schedulerA, { body: { organizationId: w.orgA, report: "billing_review", params: { monthStart: month() } }, key: randomUUID() })).status).toBe(403);
  });

  it("audit report: owner only; needs a range; the file lists field names only; a manager is refused and nothing is recorded as generated", async () => {
    const body = { organizationId: w.orgA, report: "audit_report", params: { dateFrom: day(-1), dateTo: day(1) } };
    expect((await call("POST /v1/exports", w.ownerA, { body: { ...body, params: {} }, key: randomUUID() })).status).toBe(400);
    const ok = await call("POST /v1/exports", w.ownerA, { body, key: randomUUID() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.csv.split("\r\n")[0]).toContain("Fields changed (names only)");
    expect(ok.body.csv).toContain("Field names only, never values.");
    expect(ok.body.filename).toBe(`audit-report-${day(-1)}-to-${day(1)}.csv`);
    const before = (await db.admin.query("select count(*)::int n from ogevia.report_export_events where event = 'generated'")).rows[0].n;
    const refused = await call("POST /v1/exports", w.managerA, { body, key: randomUUID() });
    expect(refused.status).toBe(403); // the manager holds reports.export but not organization.update: the audit function refuses and the export is recorded as failed
    const after = (await db.admin.query("select count(*)::int n from ogevia.report_export_events where event = 'generated'")).rows[0].n;
    expect(after).toBe(before);
    const failed = (await db.admin.query("select count(*)::int n from ogevia.report_export_events where event = 'failed'")).rows[0].n;
    expect(failed).toBeGreaterThanOrEqual(1);
  });
});
