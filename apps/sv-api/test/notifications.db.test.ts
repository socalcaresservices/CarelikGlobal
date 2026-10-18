// Through the real Lambda handler (SYNTHETIC data only): in-app notifications and their agency setting (0077).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
let shift: string;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
  const f = await freshClient(db, w, w.caregiverA1, 5000, w.orgA, { before: 40, after: 200 });
  shift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status)
     values ($1,$2,$3, now() - interval '1 hour', now() + interval '1 hour', 'scheduled') returning id`, [w.orgA, f.client, f.service])).rows[0].id as string;
});
afterAll(async () => db?.drop());
async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("notifications through the handler", () => {
  it("lists the caller's own, marks them read (repeatable), refuses other agencies and bad input", async () => {
    const list = await call("GET /v1/notifications", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const mine = list.body.notifications.items.find((i: any) => i.issueKey === `shift:uncovered_open:${shift}`);
    expect(mine).toMatchObject({ severity: "critical", state: "unread" });
    expect(list.body.notifications.unread).toBeGreaterThanOrEqual(1);
    expect((await call("GET /v1/notifications", w.managerB, { query: { organizationId: w.orgA } })).status).toBeGreaterThanOrEqual(403);
    expect((await call("GET /v1/notifications", w.managerA, { query: { organizationId: w.orgA, limit: "500" } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST /v1/notifications/read", w.managerA, { body: { organizationId: w.orgA, ids: "x" }, key: randomUUID() })).status).toBeGreaterThanOrEqual(400);
    const key = randomUUID();
    const first = await call("POST /v1/notifications/read", w.managerA, { body: { organizationId: w.orgA, ids: [mine.id] }, key });
    expect(first.body).toEqual({ marked: 1 });
    const again = await call("POST /v1/notifications/read", w.managerA, { body: { organizationId: w.orgA, ids: [mine.id] }, key: randomUUID() });
    expect(again.body).toEqual({ marked: 0 });
    const after = await call("GET /v1/notifications", w.managerA, { query: { organizationId: w.orgA, includeRead: "true" } });
    expect(after.body.notifications.items.find((i: any) => i.id === mine.id).state).toBe("read");
  });

  it("only the owner changes the Urgent setting; the manager reads it", async () => {
    const body = { organizationId: w.orgA, urgentInApp: false, reason: "Fewer interruptions (synthetic)" };
    expect((await call("POST /v1/notification-settings", w.managerA, { body, key: randomUUID() })).status).toBe(403);
    expect((await call("POST /v1/notification-settings", w.ownerA, { body: { ...body, urgentInApp: "no" }, key: randomUUID() })).status).toBe(400);
    const ok = await call("POST /v1/notification-settings", w.ownerA, { body, key: randomUUID() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const got = await call("GET /v1/notification-settings", w.managerA, { query: { organizationId: w.orgA } });
    expect(got.body.settings).toMatchObject({ urgentInApp: false, criticalInApp: true, outboundChannels: "none" });
  });
});
