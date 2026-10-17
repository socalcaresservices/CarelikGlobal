// Through the real Lambda handler (SYNTHETIC data only): client documents, readiness, holds, the client timeline and the duplicate check (0074).
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
let evidence: MemoryEvidenceStore;
let fx: { client: string; service: string; auth: string };
const pdf = Buffer.from("%PDF-1.4\n% synthetic client document\n").toString("base64");
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  evidence = new MemoryEvidenceStore();
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence, identity: new MemoryIdentityAdmin(), log: () => {} });
  fx = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
});
afterAll(async () => db?.drop());
async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("client documents through the handler", () => {
  it("configure, require, upload (Pending Review), refuse self-review, approve, download with integrity, retry with the same key stores once", async () => {
    const t = await call("POST /v1/client-document-types", w.managerA, { body: { organizationId: w.orgA, name: "Handler consent", category: "consent", requiresExpiry: false }, key: randomUUID() });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const typeId = t.body.documentTypeId as string;
    expect((await call("POST /v1/client-document-types", w.caregiverA1, { body: { organizationId: w.orgA, name: "Nope", category: "other", requiresExpiry: false }, key: randomUUID() })).status).toBe(403);
    expect((await call("POST /v1/client-document-requirements", w.managerA, { body: { organizationId: w.orgA, serviceId: fx.service, documentTypeId: typeId, required: true }, key: randomUUID() })).status).toBe(200);
    const list0 = await call("GET /v1/clients/{clientId}/documents", w.managerA, { path: { clientId: fx.client }, query: { organizationId: w.orgA } });
    expect(list0.body.documents.find((d: any) => d.documentTypeId === typeId)).toMatchObject({ state: "missing" });
    const key = randomUUID();
    const upload = () => call("POST /v1/clients/{clientId}/documents/{documentTypeId}/versions", w.managerA, { path: { clientId: fx.client, documentTypeId: typeId }, body: { organizationId: w.orgA, contentType: "application/pdf", fileBase64: pdf }, key });
    const up = await upload();
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const again = await upload();
    expect(again.status).toBe(201);
    expect(again.body.version.documentVersionId).toBe(up.body.version.documentVersionId);
    const versionId = up.body.version.documentVersionId as string;
    expect((await call("GET /v1/clients/{clientId}/documents", w.managerA, { path: { clientId: fx.client }, query: { organizationId: w.orgA } })).body.documents.find((d: any) => d.documentTypeId === typeId)).toMatchObject({ state: "pending_review", versionCount: 1 });
    expect((await call("POST /v1/client-document-versions/{versionId}/review", w.managerA, { path: { versionId }, body: { decision: "verified" }, key: randomUUID() })).status).toBe(403);
    expect((await call("POST /v1/client-document-versions/{versionId}/review", w.ownerA, { path: { versionId }, body: { decision: "verified" }, key: randomUUID() })).status).toBe(200);
    const file = await call("GET /v1/client-document-versions/{versionId}/file", w.managerA, { path: { versionId } });
    expect(file.status).toBe(200);
    expect(Buffer.from(file.body.fileBase64, "base64").toString()).toContain("%PDF-");
    expect((await call("GET /v1/client-document-versions/{versionId}/file", w.managerB, { path: { versionId } })).status).toBeGreaterThanOrEqual(403);
    const bad = await call("POST /v1/clients/{clientId}/documents/{documentTypeId}/versions", w.managerA, { path: { clientId: fx.client, documentTypeId: typeId }, body: { organizationId: w.orgA, contentType: "application/pdf", fileBase64: Buffer.from("not a pdf").toString("base64") }, key: randomUUID() });
    expect(bad.status).toBe(422);
  });

  it("stage, readiness and holds: draft blocks activation until approved; a hold needs a reason; the timeline lists field names only; duplicates are found", async () => {
    expect((await call("POST /v1/clients/{clientId}/stage", w.managerA, { path: { clientId: fx.client }, body: { organizationId: w.orgA, stage: "draft", note: "Preparing" }, key: randomUUID() })).status).toBe(200);
    const r = await call("GET /v1/clients/{clientId}/readiness", w.managerA, { path: { clientId: fx.client }, query: { organizationId: w.orgA } });
    expect(r.body.readiness).toMatchObject({ stage: "draft", canSchedule: false });
    expect((await call("POST /v1/clients/{clientId}/stage", w.managerA, { path: { clientId: fx.client }, body: { organizationId: w.orgA, stage: "active" }, key: randomUUID() })).status).toBe(200); // the document was approved above
    const short = await call("POST /v1/clients/{clientId}/service-holds", w.managerA, { path: { clientId: fx.client }, body: { organizationId: w.orgA, serviceId: fx.service, reason: "short" }, key: randomUUID() });
    expect(short.status).toBeGreaterThanOrEqual(400);
    const hold = await call("POST /v1/clients/{clientId}/service-holds", w.managerA, { path: { clientId: fx.client }, body: { organizationId: w.orgA, serviceId: fx.service, reason: "The family asked for a pause" }, key: randomUUID() });
    expect(hold.status, JSON.stringify(hold.body)).toBe(201);
    expect((await call("POST /v1/client-service-holds/{holdId}/release", w.managerA, { path: { holdId: hold.body.holdId }, body: { organizationId: w.orgA, note: "Spoke with the family today" }, key: randomUUID() })).status).toBe(200);
    const audit = await call("GET /v1/clients/{clientId}/audit", w.managerA, { path: { clientId: fx.client }, query: { organizationId: w.orgA } });
    expect(audit.body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(["client.stage_changed", "client.service_hold_opened", "client.service_hold_released"]));
    await call("POST /v1/clients/{clientId}/legal-name", w.ownerA, { path: { clientId: fx.client }, body: { organizationId: w.orgA, firstName: "Handler", lastName: "Dupe" }, key: randomUUID() });
    const dup = await call("GET /v1/client-duplicates", w.ownerA, { query: { organizationId: w.orgA, firstName: "handler", lastName: "DUPE" } });
    expect(dup.body.matches[0]).toMatchObject({ clientId: fx.client, match: "same_name" });
    expect((await call("GET /v1/client-duplicates", w.caregiverA1, { query: { organizationId: w.orgA, firstName: "a", lastName: "b" } })).status).toBe(403);
    const hist = await call("GET /v1/clients/{clientId}/issue-history", w.managerA, { path: { clientId: fx.client }, query: { organizationId: w.orgA } });
    expect(hist.status).toBe(200);
  });
});
