// 0126 through the real handler: the four service-address routes. SYNTHETIC data only.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, freshClient, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createHandler } from "../src/handler";
import { MemoryEvidenceStore } from "../src/evidence";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb, w: World, handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  vi.stubEnv("OGEVIA_QR_ENCRYPTION_KEY", "d".repeat(64));
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  const dir = new URL("../../../infra/aws/db/pending/migrations/", import.meta.url);
  const c = await db.admin.connect();
  try { for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL(f, dir), "utf8")); await c.query("reset role"); await c.query("commit"); } }
  finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
}, 240_000);
afterAll(async () => { vi.unstubAllEnvs(); await db?.drop(); });

const call = async (route: string, sub: string, o: { path?: Record<string, string>; query?: Record<string, string>; body?: Record<string, unknown> } = {}) => {
  const r = await handler(event(route, { sub, ...(o.path ? { path: o.path } : {}), ...(o.query ? { query: o.query } : {}), ...(o.body ? { body: o.body } : {}) }));
  return { status: r.statusCode, body: JSON.parse(r.body || "{}") as any };
};
const add = async (client: string, street: string) => (await call("POST /v1/clients/{clientId}/service-locations", w.ownerA.sub, { path: { clientId: client }, body: { organizationId: w.orgA, kind: "home", name: "Client home", street, city: "Synthetictown", zip: "90001" } })).body.locationId as string;
const list = (client: string, sub = w.ownerA.sub, org = w.orgA) => call("GET /v1/clients/{clientId}/service-addresses", sub, { path: { clientId: client }, query: { organizationId: org } });
const state = (loc: string, body: Record<string, unknown>, sub = w.ownerA.sub) => call("POST /v1/service-locations/{serviceLocationId}/state", sub, { path: { serviceLocationId: loc }, body: { organizationId: w.orgA, ...body } });
const remove = (loc: string, body: Record<string, unknown>, sub = w.ownerA.sub) => call("POST /v1/service-locations/{serviceLocationId}/delete", sub, { path: { serviceLocationId: loc }, body: { organizationId: w.orgA, ...body } });

describe("service address routes", () => {
  it("list, switch, mark inactive, delete and history work end to end, with camelCase fields and the street for staff only", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await add(f.client, "10 Parent One Rd"); const b = await add(f.client, "20 Parent Two Ave");
    const l1 = await list(f.client);
    expect(l1.status, JSON.stringify(l1.body)).toBe(200);
    expect(l1.body.addresses.map((x: any) => [x.locationId, x.addressState, x.isCurrent])).toEqual([[a, "current", true], [b, "alternate", false]]);
    expect(l1.body.addresses[0]).toMatchObject({ street: "10 Parent One Rd", canDelete: true });
    expect((await state(b, { state: "active" })).status).toBe(200);
    expect((await list(f.client)).body.addresses.find((x: any) => x.isCurrent).locationId).toBe(b);
    expect((await state(a, { state: "historical" })).status).toBe(400);                           // a reason is required
    expect((await state(a, { state: "bogus", reason: "x" })).status).toBe(400);
    expect((await state(a, { state: "historical", reason: "Moved out" })).status).toBe(200);
    const h = await call("GET /v1/clients/{clientId}/service-addresses/history", w.ownerA.sub, { path: { clientId: f.client }, query: { organizationId: w.orgA } });
    expect(h.status).toBe(200);
    expect(h.body.history.map((e: any) => e.action)).toEqual(expect.arrayContaining(["created", "activated", "made_alternate", "made_historical"]));
    const wrong = await add(f.client, "999 Wrong Street");
    expect((await remove(wrong, {})).status).toBe(400);                                           // a reason is required
    expect((await remove(wrong, { reason: "Typed the wrong street" })).status).toBe(200);
    expect((await list(f.client)).body.addresses.map((x: any) => x.locationId)).not.toContain(wrong);
    expect(JSON.stringify((await call("GET /v1/clients/{clientId}/service-addresses/history", w.ownerA.sub, { path: { clientId: f.client }, query: { organizationId: w.orgA } })).body)).not.toContain("Wrong Street");
  });

  it("a caregiver is refused; another agency cannot see or change an address; malformed ids and missing bodies are 400 before the database", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const a = await add(f.client, "10 Parent One Rd"); const b = await add(f.client, "20 Parent Two Ave");
    expect((await list(f.client, w.caregiverA1.sub)).status).toBe(404);
    expect((await state(b, { state: "active" }, w.caregiverA1.sub)).status).toBe(403);
    expect((await remove(b, { reason: "x" }, w.caregiverA1.sub)).status).toBe(403);
    expect((await list(f.client, w.managerB.sub, w.orgA)).status).toBe(404);
    expect((await state(b, { state: "active" }, w.managerB.sub)).status).toBe(403);
    expect((await remove(b, { reason: "Wrong agency" }, w.managerB.sub)).status).toBe(403);
    expect((await call("POST /v1/service-locations/{serviceLocationId}/state", w.ownerA.sub, { path: { serviceLocationId: "nope" }, body: { organizationId: w.orgA, state: "active" } })).status).toBe(400);
    expect((await call("POST /v1/service-locations/{serviceLocationId}/delete", w.ownerA.sub, { path: { serviceLocationId: b } })).status).toBe(400);
    expect((await list(f.client)).body.addresses.map((x: any) => x.locationId).sort()).toEqual([a, b].sort());
  });
});
