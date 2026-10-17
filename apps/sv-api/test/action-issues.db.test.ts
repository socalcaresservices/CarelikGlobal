// Through the real Lambda handler (SYNTHETIC data only): the issue list, its history and the agency deadlines (0073).
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

describe("action issues and agency deadlines through the handler", () => {
  it("lists with filters and paging, refuses bad filters and a caregiver, and shows history", async () => {
    const all = await call("GET /v1/action-issues", w.managerA, { query: { organizationId: w.orgA } });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const mine = all.body.issues.find((i: any) => i.shiftId === shift);
    expect(mine).toMatchObject({ issueKey: `shift:uncovered_open:${shift}`, severity: "critical", queue: "needs_attention_now" });
    expect(all.body.counts.byQueue.needs_attention_now).toBeGreaterThanOrEqual(1);
    const crit = await call("GET /v1/action-issues", w.managerA, { query: { organizationId: w.orgA, severity: "critical", limit: "1" } });
    expect(crit.body.issues).toHaveLength(1);
    expect((await call("GET /v1/action-issues", w.managerA, { query: { organizationId: w.orgA, severity: "high" } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("GET /v1/action-issues", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/action-issues", w.managerB, { query: { organizationId: w.orgA } })).status).toBeGreaterThanOrEqual(403);
    const hist = await call("GET /v1/action-issues/history", w.managerA, { query: { organizationId: w.orgA, issueKey: mine.issueKey } });
    expect(hist.body.history.events.map((e: any) => e.event)).toEqual(["opened"]);
  });

  it("the owner sets shorter deadlines with a reason; the manager cannot; a longer one is refused; one keyed request", async () => {
    const body = { organizationId: w.orgA, confirmationOverdueHours: 24, reviewOverdueHours: null, documentReviewOverdueHours: null, reason: "Faster follow-up for the pilot (synthetic)" };
    expect((await call("POST /v1/attention-settings", w.managerA, { body, key: randomUUID() })).status).toBe(403);
    expect((await call("POST /v1/attention-settings", w.ownerA, { body: { ...body, confirmationOverdueHours: 72 }, key: randomUUID() })).status).toBe(422);
    const ok = await call("POST /v1/attention-settings", w.ownerA, { body, key: randomUUID() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.settings).toMatchObject({ confirmationOverdueHours: 24 });
    const got = await call("GET /v1/attention-settings", w.managerA, { query: { organizationId: w.orgA } });
    expect(got.body.settings).toMatchObject({ confirmationOverdueHours: 24, defaults: { confirmationOverdueHours: 48 } });
  });
});
