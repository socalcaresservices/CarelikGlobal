// 0110 (pending migration) over HTTP through the real Lambda handler and a real disposable PostgreSQL: offices and a client's responsible office. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
const logs: unknown[] = [];

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1410);
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL("../../../infra/aws/db/pending/migrations/0110_offices.sql", import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => logs.push(l) });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor | null, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { ...(actor ? { sub: actor.sub } : {}), ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("offices routes", () => {
  it("the Administrator creates an office; a manager and a caregiver are refused; the name is required and unique", async () => {
    expect((await call("POST /v1/offices", w.managerA, { body: { organizationId: w.orgA, name: "Manager Office" } })).status).toBe(403);
    expect((await call("POST /v1/offices", w.caregiverA1, { body: { organizationId: w.orgA, name: "Caregiver Office" } })).status).toBe(403);
    expect((await call("POST /v1/offices", w.ownerA, { body: { organizationId: w.orgA } })).status).toBe(400);
    const made = await call("POST /v1/offices", w.ownerA, { body: { organizationId: w.orgA, name: "North Office" } });
    expect(made.status).toBe(200);
    expect(made.body.officeId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call("POST /v1/offices", w.ownerA, { body: { organizationId: w.orgA, name: "north office" } })).status).toBe(409);
  });
  it("a manager lists the offices and assigns a client to one; the client list shows the code and office, and clearing works", async () => {
    const list = await call("GET /v1/offices", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.status).toBe(200);
    const office = list.body.offices.find((o: any) => o.name === "North Office");
    expect(office).toMatchObject({ isActive: true, clientCount: 0 });
    const set = await call("POST /v1/clients/{clientId}/office", w.managerA, { path: { clientId: w.clientA1 }, body: { organizationId: w.orgA, officeId: office.officeId } });
    expect(set).toEqual({ status: 200, body: { status: "set" } });
    const map = await call("GET /v1/client-offices", w.managerA, { query: { organizationId: w.orgA } });
    expect(map.body.clientOffices).toHaveLength(1);
    expect(map.body.clientOffices[0]).toMatchObject({ clientId: w.clientA1, officeId: office.officeId });
    const cleared = await call("POST /v1/clients/{clientId}/office", w.managerA, { path: { clientId: w.clientA1 }, body: { organizationId: w.orgA, officeId: null } });
    expect(cleared).toEqual({ status: 200, body: { status: "cleared" } });
    expect((await call("POST /v1/clients/{clientId}/office", w.schedulerA, { path: { clientId: w.clientA1 }, body: { organizationId: w.orgA, officeId: office.officeId } })).status).toBe(403);
  });
  it("renames and retires an office (reason required); another agency's manager sees nothing and changes nothing", async () => {
    const office = (await call("GET /v1/offices", w.ownerA, { query: { organizationId: w.orgA } })).body.offices[0];
    expect((await call("POST /v1/offices/{officeId}/rename", w.ownerA, { path: { officeId: office.officeId }, body: { organizationId: w.orgA, name: "North County Office" } })).body).toEqual({ status: "renamed" });
    expect((await call("POST /v1/offices/{officeId}/retire", w.ownerA, { path: { officeId: office.officeId }, body: { organizationId: w.orgA } })).status).toBe(400);
    expect((await call("POST /v1/offices/{officeId}/retire", w.managerB, { path: { officeId: office.officeId }, body: { organizationId: w.orgA, reason: "Not mine (synthetic)" } })).status).toBeGreaterThanOrEqual(403);
    expect((await call("GET /v1/offices", w.managerB, { query: { organizationId: w.orgB } })).body.offices).toEqual([]);
    expect((await call("POST /v1/offices/{officeId}/retire", w.ownerA, { path: { officeId: office.officeId }, body: { organizationId: w.orgA, reason: "Closed (synthetic)" } })).body).toEqual({ status: "retired" });
    expect((await call("GET /v1/offices", w.ownerA, { query: { organizationId: w.orgA } })).body.offices[0]).toMatchObject({ isActive: false });
  });
});
