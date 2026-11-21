// 0109 (pending migration) over HTTP through the real Lambda handler and a real disposable PostgreSQL: cancel a document request,
// retire a document type, clear care-request alerts. SYNTHETIC data only.
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
let rec = "";

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1310);
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL("../../../infra/aws/db/pending/migrations/0109_request_cleanup.sql", import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => logs.push(l) });
  rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [w.caregiverA1.userId, w.orgA])).rows[0].id;
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor | null, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { ...(actor ? { sub: actor.sub } : {}), ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const sql = (a: Actor, q: string, params: unknown[]) => asActor(db, a.sub, async (c) => (await c.query(q, params)).rows as any[]);

describe("request cleanup routes", () => {
  it("cancels a document request (reason required) and then retires its type", async () => {
    const type = (await sql(w.managerA, "select ogevia_api.create_document_type($1,'TB TEST http (synthetic)',false,null) as id", [w.orgA]))[0].id as string;
    const doc = (await sql(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
    const noReason = await call("POST /v1/documents/{documentId}/cancel", w.managerA, { path: { documentId: doc }, body: { organizationId: w.orgA } });
    expect(noReason.status).toBe(400);
    const tooEarly = await call("POST /v1/document-types/{documentTypeId}/retire", w.managerA, { path: { documentTypeId: type }, body: { organizationId: w.orgA, reason: "Duplicate type (synthetic)" } });
    expect(tooEarly.status).toBe(409);
    const ok = await call("POST /v1/documents/{documentId}/cancel", w.managerA, { path: { documentId: doc }, body: { organizationId: w.orgA, reason: "Requested twice (synthetic)" } });
    expect(ok).toEqual({ status: 200, body: { status: "cancelled" } });
    const caregiver = await call("POST /v1/documents/{documentId}/cancel", w.caregiverA2, { path: { documentId: doc }, body: { organizationId: w.orgA, reason: "Not allowed (synthetic)" } });
    expect(caregiver.status).toBe(403);
    const retired = await call("POST /v1/document-types/{documentTypeId}/retire", w.managerA, { path: { documentTypeId: type }, body: { organizationId: w.orgA, reason: "Duplicate type (synthetic)" } });
    expect(retired).toEqual({ status: 200, body: { status: "retired" } });
    expect(JSON.stringify(logs)).not.toContain("Requested twice");
  });
  it("marks the caller's own care-request alerts read; bad ids are refused", async () => {
    const auth = w.authA1;
    const req = (await db.admin.query(
      `insert into ogevia.care_requests (organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key)
       values ($1,$2,$3,$4, now() + interval '3 days', now() + interval '3 days 4 hours', 240, gen_random_uuid()) returning id`, [w.orgA, w.clientA1, w.serviceA, auth])).rows[0].id;
    await db.admin.query("insert into ogevia.care_notifications (organization_id, care_request_id, recipient_type, recipient_user_id, event_key) values ($1,$2,'staff',$3,'care_request_created'),($1,$2,'staff',$3,'client_cancelled')", [w.orgA, req, w.managerA.userId]);
    const before = await call("GET /v1/care-notifications", w.managerA, { query: { organizationId: w.orgA } });
    expect(before.body.notifications).toHaveLength(2);
    const bad = await call("POST /v1/care-notifications/read", w.managerA, { body: { organizationId: w.orgA, ids: ["nope"] } });
    expect(bad.status).toBe(400);
    const marked = await call("POST /v1/care-notifications/read", w.managerA, { body: { organizationId: w.orgA } });
    expect(marked).toEqual({ status: 200, body: { marked: 2 } });
    const after = await call("GET /v1/care-notifications", w.managerA, { query: { organizationId: w.orgA } });
    expect(after.body.notifications).toHaveLength(0);
  });
});
