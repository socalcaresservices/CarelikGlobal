// The attention-overview, appearance and missing-rate routes (0056) through the real Lambda handler and a real (local, disposable) PostgreSQL.
// SYNTHETIC data only. Covers wiring, validation, status codes, permissions and the cross-tenant boundary.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
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
  await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("GET /v1/attention/overview", () => {
  it("is staff-only, validates the window, and returns the four purposes", async () => {
    const q = (extra: Record<string, string> = {}) => ({ query: { organizationId: w.orgA, ...extra } });
    expect((await handler(event("GET /v1/attention/overview", { sub: null, ...q() }))).statusCode).toBe(401);
    expect((await call("GET /v1/attention/overview", w.caregiverA1, q())).status).toBe(403);
    expect((await call("GET /v1/attention/overview", w.managerB, q())).status).toBe(404);
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "0" }))).status).toBe(400);
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "500" }))).status).toBe(400);
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "abc" }))).status).toBe(400);
    const ok = await call("GET /v1/attention/overview", w.managerA, q());
    expect(ok.status).toBe(200);
    expect(ok.body.overview).toMatchObject({ urgentWindowHours: 48 });
    expect(Object.keys(ok.body.overview)).toEqual(expect.arrayContaining(["urgent", "upcoming", "documents", "visitReview"]));
    expect((await call("GET /v1/attention/overview", w.managerA, q({ urgentHours: "24" }))).body.overview.urgentWindowHours).toBe(24);
  });
});

describe("appearance over HTTP", () => {
  it("saves agency defaults (administrator only) and personal choices (that person only), each persisted and isolated by agency", async () => {
    const get = (a: Actor, org = w.orgA) => call("GET /v1/appearance", a, { query: { organizationId: org } });
    expect((await get(w.caregiverA1)).body.appearance.effective).toMatchObject({ background: "light", accent: "teal", density: "comfortable", textSize: "standard", chartType: "bar" });
    const body = { organizationId: w.orgA, background: "cream", accent: "indigo", density: "compact", textSize: "standard", chartType: "donut" };
    expect((await call("POST /v1/appearance/organization", w.managerA, { body })).status).toBe(403);
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body, key: null })).status).toBe(200); // this route does not consume an idempotency key (it sets, it does not create)
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body: { ...body, background: "neon" } })).status).toBe(400);
    expect((await call("POST /v1/appearance/organization", w.ownerA, { body: { ...body, chartType: "pie" } })).status).toBe(400);
    expect((await get(w.caregiverA2)).body.appearance.effective).toMatchObject({ background: "cream", accent: "indigo", density: "compact", chartType: "donut" });
    const mine = await call("POST /v1/appearance/me", w.caregiverA1, { body: { organizationId: w.orgA, background: "dark", accent: null, density: null, textSize: "large", chartType: null } });
    expect(mine.status).toBe(200);
    expect(mine.body.appearance.effective).toMatchObject({ background: "dark", accent: "indigo", density: "compact", textSize: "large", chartType: "donut" });
    expect((await get(w.caregiverA2)).body.appearance.effective.background).toBe("cream"); // unaffected
    expect((await get(w.managerA)).body.appearance.mine.background).toBeNull();
    // another agency: its own defaults, no access to this agency's, and a person cannot save a choice into an agency they are not in
    expect((await get(w.managerB, w.orgB)).body.appearance.effective.background).toBe("light");
    expect((await get(w.managerB, w.orgA)).status).toBe(404);
    expect((await call("POST /v1/appearance/me", w.managerB, { body: { organizationId: w.orgA, background: "dark" } })).status).toBe(404);
    // a refresh (new request) returns what was saved
    expect((await get(w.caregiverA1)).body.appearance.mine).toEqual({ background: "dark", accent: null, density: null, textSize: "large", chartType: null });
  });
});

describe("GET /v1/authorizations/missing-rate", () => {
  it("lists authorizations without a rate for the administrator only", async () => {
    const monthStart = `${today.slice(0, 7)}-01`;
    const q = { query: { organizationId: w.orgA, monthStart } };
    const owner = await call("GET /v1/authorizations/missing-rate", w.ownerA, q);
    expect(owner.status).toBe(200);
    expect(owner.body.authorizations.length).toBeGreaterThan(0);
    expect(owner.body.authorizations[0]).toMatchObject({ clientId: expect.any(String), serviceCode: "RSP" });
    expect(JSON.stringify(owner.body)).not.toMatch(/hourlyRate|rateCents/);
    expect((await call("GET /v1/authorizations/missing-rate", w.managerA, q)).body.authorizations).toEqual([]);
    expect((await call("GET /v1/authorizations/missing-rate", w.managerA, { query: { organizationId: w.orgA, monthStart: "nope" } })).status).toBe(400);
    expect((await call("GET /v1/authorizations/missing-rate", w.managerB, q)).body.authorizations).toEqual([]);
  });
});
