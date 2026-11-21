import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createHandler } from "../src/handler";
import { MemoryEvidenceStore } from "../src/evidence";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb, world: World, handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb({ includePendingUx: true });
  world = await seedWorld(db, 600);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() },
    evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

it("stores and returns attachment versions, records review, and denies access outside the agency", async () => {
  const call = async (route: string, opts: Parameters<typeof event>[1]) => {
    const result = await handler(event(route, opts));
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  const org = world.orgA;
  const sub = world.ownerA.sub;
  const create = await call("POST /v1/business-documents", { sub,
    body: { organizationId: org, name: "Synthetic insurance" } });
  expect(create.status).toBe(200);
  const id = create.body.id;
  const fileBase64 = Buffer.from("%PDF-1.4\nSynthetic file").toString("base64");
  const upload = { sub, key: randomUUID(),
    body: { organizationId: org, id, operation: "upload", contentType: "application/pdf", fileBase64 } };
  const stored = await call("POST /v1/business-documents", upload);
  expect(stored.status).toBe(200);
  const fileId = stored.body.id;
  expect((await call("POST /v1/business-documents", upload)).body.id).toBe(fileId);
  const list = await call("GET /v1/business-documents", { sub, query: { organizationId: org } });
  expect(list.body.documents[0].files).toEqual([expect.objectContaining({ id: fileId })]);
  const review = await call("POST /v1/business-documents", { sub, body: {
    organizationId: org, id, name: "Synthetic insurance", updatedAt: list.body.documents[0].updatedAt, review: true,
  } });
  expect(review.status).toBe(200);
  const download = await call("GET /v1/business-documents", { sub, query: { organizationId: org, fileId } });
  expect(download).toMatchObject({ status: 200, body: { fileBase64, contentType: "application/pdf" } });
  const denied = await call("GET /v1/business-documents", { sub: world.managerB.sub, query: { organizationId: org, fileId } });
  expect(denied.status).toBe(404);
  expect(JSON.stringify(denied.body)).not.toContain(fileBase64);
});

it("creates one in-app renewal reminder per deadline and keeps it scoped to authorized staff", async () => {
  const org = world.orgA;
  await db.admin.query(
    "insert into ogevia.business_documents(organization_id,name,due_on) values ($1,'Synthetic renewal',ogevia.organization_local_date($1,now()) + 7)",
    [org],
  );
  const inbox = async (sub: string, organizationId = org) => {
    const result = await handler(event("GET /v1/notifications", { sub, query: { organizationId } }));
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  const scheduled = async () => Number((await db.admin.query(
    "select ogevia_api.system_compliance_sweep_org($1)->>'businessRemindersCreated' as count", [org],
  )).rows[0].count);
  expect((await db.admin.query("select ogevia_api.system_compliance_orgs() as id")).rows).toContainEqual({ id: org });
  expect(await scheduled()).toBeGreaterThan(0);
  expect(await scheduled()).toBe(0);
  const first = await inbox(world.ownerA.sub);
  expect(first.status).toBe(200);
  const reminders = (result: typeof first) => result.body.notifications.items.filter((row: { kind: string }) => row.kind === "business_document");
  expect(reminders(first)).toEqual([expect.objectContaining({ severity: "urgent", reason: "business_document_renewal" })]);
  expect(reminders(await inbox(world.ownerA.sub))).toEqual(reminders(first));
  expect((await inbox(world.managerB.sub)).status).toBe(404);
});

it("uses bundled city data for a first-use ZIP and handles unknown and malformed ZIPs", async () => {
  const lookup = async (suggestZip: string) => {
    const response = await handler(event("GET /v1/location-data", {
      sub: world.ownerA.sub, query: { organizationId: world.orgA, suggestZip },
    }));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  expect(await lookup("02108")).toMatchObject({ status: 200, body: { city: "Boston", candidates: ["Boston"] } });
  expect(await lookup("00000")).toEqual({ status: 200, body: { city: null, candidates: [] } });
  expect((await lookup("1234")).status).toBe(422);
});

it("saves the accepted ZIP city during caregiver creation", async () => {
  const org = world.orgA;
  const sub = world.ownerA.sub;
  const key = randomUUID();
  const create = { sub, key, body: { organizationId: org, firstName: "Synthetic", lastName: "Onboarding", zip: "02108", city: "Boston" } };
  const result = await handler(event("POST /v1/caregivers", create));
  expect(result.statusCode).toBe(201);
  const id = JSON.parse(result.body).caregiver.caregiverRecordId;
  const load = await handler(event("GET /v1/caregivers/{caregiverRecordId}/zip", {
    sub, query: { organizationId: org }, path: { caregiverRecordId: id },
  }));
  expect(JSON.parse(load.body)).toMatchObject({ location: { zip: "02108", city: "Boston" } });
  const replay = await handler(event("POST /v1/caregivers", create));
  expect(JSON.parse(replay.body).caregiver.caregiverRecordId).toBe(id);
});
