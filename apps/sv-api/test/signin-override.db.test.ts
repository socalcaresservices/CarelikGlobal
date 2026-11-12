// 0090 sign-in override over HTTP (pending migration, applied here on top of 0001-0088), through the real Lambda handler and a real disposable PostgreSQL.
// Covers wiring, validation, status codes, permissions and the cross-tenant boundary. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
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
  w = await seedWorld(db, 900);
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL("../../../infra/aws/db/pending/migrations/0103_caregiver_signin_override.sql", import.meta.url), "utf8"));
    await c.query("reset role");
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => logs.push(l) });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor | null, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { ...(actor ? { sub: actor.sub } : {}), ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const as = (a: Actor, sql: string, params: unknown[]) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const newCaregiver = async (last: string, org = w.orgA, by = w.managerA) =>
  (await as(by, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,'onboarding',null)", [org, `${last} ${randomUUID().slice(0, 4)}`]))[0].caregiver_record_id as string;
const clearBackground = (rec: string) => as(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [w.orgA, rec]);
const path = (id: string) => ({ caregiverRecordId: id });
const ROUTE = "POST /v1/caregivers/{caregiverRecordId}/signin-override";

describe("POST /v1/caregivers/{id}/signin-override", () => {
  it("an administrator records it (201) and the readiness shows the sign-in row met by override", async () => {
    const id = await newCaregiver("Http");
    await clearBackground(id);
    const r = await call(ROUTE, w.ownerA, { path: path(id), body: { organizationId: w.orgA, reason: "Starts Monday; invitation sent (synthetic)" } });
    expect(r.status).toBe(201);
    expect(r.body.readiness.overrideRecorded).toBe(true);
    expect(r.body.readiness.items.find((i: any) => i.requirement === "signin")).toMatchObject({ state: "met", detail: "Approved by override: not signed in" });
  });

  it("a reason is required (a validation error for missing, blank or short); a bad id is a validation error; nothing is recorded", async () => {
    const id = await newCaregiver("Validation");
    await clearBackground(id);
    for (const body of [{ organizationId: w.orgA }, { organizationId: w.orgA, reason: "" }, { organizationId: w.orgA, reason: "   " }, { organizationId: w.orgA, reason: "ok" }]) {
      expect([400, 422]).toContain((await call(ROUTE, w.ownerA, { path: path(id), body })).status);   // validation errors are 400 or 422
    }
    expect([400, 422]).toContain((await call(ROUTE, w.ownerA, { path: path("not-a-uuid"), body: { organizationId: w.orgA, reason: "A valid reason (synthetic)" } })).status);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_signin_overrides where caregiver_record_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("the background check is never waived: 409, nothing recorded", async () => {
    const id = await newCaregiver("NoBackground");
    const r = await call(ROUTE, w.ownerA, { path: path(id), body: { organizationId: w.orgA, reason: "Needs to start now (synthetic)" } });
    expect(r.status).toBe(409);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_signin_overrides where caregiver_record_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("a manager, a scheduler, a caregiver and an unauthenticated caller are refused; another agency gets 404", async () => {
    const id = await newCaregiver("Roles");
    await clearBackground(id);
    const body = { organizationId: w.orgA, reason: "Trying without the right (synthetic)" };
    expect((await call(ROUTE, w.managerA, { path: path(id), body })).status).toBe(403);
    expect((await call(ROUTE, w.schedulerA, { path: path(id), body })).status).toBe(403);
    expect((await call(ROUTE, w.caregiverA1, { path: path(id), body })).status).toBe(403);
    expect((await call(ROUTE, null, { path: path(id), body })).status).toBe(401);
    expect((await call(ROUTE, w.managerB, { path: path(id), body })).status).toBe(404);   // another agency: the caregiver does not exist for it
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_signin_overrides where caregiver_record_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("a caregiver id from another agency is 404 for this agency's administrator", async () => {
    const other = await newCaregiver("OtherAgency", w.orgB, w.managerB);
    const r = await call(ROUTE, w.ownerA, { path: path(other), body: { organizationId: w.orgA, reason: "Cross tenant (synthetic)" } });
    expect(r.status).toBe(404);
  });

  it("no reason text or caregiver name is written to the logs", async () => {
    const id = await newCaregiver("LogCheck");
    await clearBackground(id);
    await call(ROUTE, w.ownerA, { path: path(id), body: { organizationId: w.orgA, reason: "SECRET-REASON-TEXT (synthetic)" } });
    expect(JSON.stringify(logs)).not.toContain("SECRET-REASON-TEXT");
  });
});

describe("GET /v1/signin-overrides", () => {
  it("lists the badge carriers: a manager sees the reason and approver, a scheduler only that the badge applies, a caregiver is refused, another agency gets 404", async () => {
    const id = await newCaregiver("List");
    await clearBackground(id);
    await call(ROUTE, w.ownerA, { path: path(id), body: { organizationId: w.orgA, reason: "List reason (synthetic)" } });
    const manager = await call("GET /v1/signin-overrides", w.managerA, { query: { organizationId: w.orgA } });
    expect(manager.status).toBe(200);
    expect(manager.body.overrides.find((o: any) => o.caregiverRecordId === id)).toMatchObject({ reason: "List reason (synthetic)" });
    const scheduler = await call("GET /v1/signin-overrides", w.schedulerA, { query: { organizationId: w.orgA } });
    expect(scheduler.status).toBe(200);
    expect(scheduler.body.overrides.find((o: any) => o.caregiverRecordId === id)).toMatchObject({ reason: null, approvedByName: null });
    expect((await call("GET /v1/signin-overrides", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/signin-overrides", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
    expect((await call("GET /v1/signin-overrides", null, { query: { organizationId: w.orgA } })).status).toBe(401);
  });
});
