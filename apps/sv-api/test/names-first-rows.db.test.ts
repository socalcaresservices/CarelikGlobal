// Names-first administrator rows (F01/I07, SYNTHETIC data): the issue list and shifts-to-reconcile carry client and caregiver NAMES beside the codes, only for a caller
// who may already see those names. The duplicate flag is a boolean; names are never sent to a role that cannot see them elsewhere.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
let clientA: string;
let clientB: string;
let clientTwin: string;
let endedShift: string;
let openShift: string;
async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 740);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
  const fa = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
  const fb = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
  const ft = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
  [clientA, clientB, clientTwin] = [fa.client, fb.client, ft.client];
  const name = async (id: string, first: string, last: string) =>
    expect((await call("POST /v1/clients/{clientId}/legal-name", w.ownerA, { path: { clientId: id }, body: { organizationId: w.orgA, firstName: first, lastName: last }, key: randomUUID() })).status).toBe(200);
  await name(clientA, "Robin", "Unique");
  await name(clientB, "Dana", "Sample");
  await name(clientTwin, "dana", "SAMPLE");
  await db.admin.query("update ogevia.caregiver_records set first_name = 'Alex', last_name = 'Lee', preferred_name = null where organization_id = $1 and linked_user_id = $2", [w.orgA, w.caregiverA1.userId]);
  // An ended shift that still holds a reservation (a reconcile row) with Alex Lee on it, and an upcoming shift nobody covers (an issue row).
  endedShift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status, authorization_lineage_id, caregiver_record_id)
     select $1,$2,$3, now() - interval '300 minutes', now() - interval '240 minutes', 'scheduled', a.lineage_id, (select id from ogevia.caregiver_records where organization_id = $1 and linked_user_id = $5)
     from ogevia.client_authorizations a where a.id = $4 returning id`, [w.orgA, fa.client, fa.service, fa.auth, w.caregiverA1.userId])).rows[0].id as string;
  await db.admin.query(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, null, $2, $3::date, 60 from ogevia.client_authorizations a where a.id = $4`, [w.orgA, endedShift, await orgToday(db), fa.auth]);
  openShift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status) values ($1,$2,$3, now() + interval '2 hours', now() + interval '4 hours', 'scheduled') returning id`,
    [w.orgA, clientB, fb.service])).rows[0].id as string;
});
afterAll(async () => db?.drop());

describe("names-first rows", () => {
  it("the issue list gives a manager the client name beside the code, flags the shared name, and keeps the code", async () => {
    const r = await call("GET /v1/action-issues", w.managerA, { query: { organizationId: w.orgA } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = r.body.issues.find((i: any) => i.shiftId === openShift);
    expect(row).toMatchObject({ clientName: "Dana Sample", duplicateName: true, clientId: clientB });
    expect(typeof row.clientCode).toBe("string");
    expect(r.body.counts).toBeTruthy(); // the counts and paging are passed through untouched
  });

  it("a role with no client-name permission gets the same rows with no names (codes only)", async () => {
    const r = await call("GET /v1/action-issues", w.schedulerA, { query: { organizationId: w.orgA } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = r.body.issues.find((i: any) => i.shiftId === openShift);
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty("clientName");
    expect(row).not.toHaveProperty("duplicateName");
    expect(JSON.stringify(r.body)).not.toMatch(/Dana|Sample|Robin|Unique/);
  });

  it("shifts to reconcile: client and caregiver names for a manager (caregiver unique, client unique), codes kept; a caregiver is refused and another agency sees nothing", async () => {
    const r = await call("GET /v1/shifts-to-reconcile", w.managerA, { query: { organizationId: w.orgA } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = r.body.shifts.find((s: any) => s.shiftId === endedShift);
    expect(row).toMatchObject({ clientName: "Robin Unique", duplicateName: false, caregiverName: "Alex Lee", caregiverDuplicateName: false });
    expect(typeof row.clientCode).toBe("string");
    expect(typeof row.caregiverCode).toBe("string");
    expect((await call("GET /v1/shifts-to-reconcile", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/action-issues", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    const other = await call("GET /v1/shifts-to-reconcile", w.managerB, { query: { organizationId: w.orgA } });
    expect(other.status).toBeGreaterThanOrEqual(403);
    expect(JSON.stringify(other.body)).not.toMatch(/Robin|Alex Lee/);
  });
});

describe("names on the other administrator lists (route layer, no SQL)", () => {
  it("the attention overview and the monthly chain report carry client names beside the codes for a manager; a scheduler (no client-name permission) gets none", async () => {
    const o = await call("GET /v1/attention/overview", w.managerA, { query: { organizationId: w.orgA } });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    const named = JSON.stringify(o.body.overview);
    expect(named).toMatch(/"clientName":"Dana Sample"/);
    expect(named).toMatch(/"duplicateName":true/);
    const month = `${(await orgToday(db)).slice(0, 7)}-01`;
    const chain = await call("GET /v1/reports/monthly-chain", w.managerA, { query: { organizationId: w.orgA, monthStart: month, clientId: clientA } });
    expect(chain.status, JSON.stringify(chain.body)).toBe(200);
    expect(chain.body.rows.length).toBeGreaterThan(0);
    expect(chain.body.rows[0]).toMatchObject({ clientName: "Robin Unique", duplicateName: false });
    expect(typeof chain.body.rows[0].clientCode).toBe("string");
    const s = await call("GET /v1/attention/overview", w.schedulerA, { query: { organizationId: w.orgA } });
    expect(s.status).toBe(200);
    expect(JSON.stringify(s.body)).not.toMatch(/Dana|Sample|Robin|Unique/);
    const other = await call("GET /v1/reports/monthly-chain", w.managerB, { query: { organizationId: w.orgA, monthStart: month, clientId: clientA } });
    expect(JSON.stringify(other.body)).not.toMatch(/Robin|Unique/);
  });
});
