// Wave 1 through the real Lambda handler and a disposable PostgreSQL: unscheduled-visit reason, attestation, visit outcome,
// the agency's schedule-variance rule, and open-shift pick-up (G01, G02, G06, G07, G09). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, createHelperShift, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event, syntheticPng } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("unscheduled visit and attestation (G01, G06, G07)", () => {
  it("refuses a start with no schedule and no reason; with a reason it starts, and the confirmed visit goes to review with its reasons", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 40 });
    const body = { organizationId: w.orgA, clientId: f.client, serviceId: f.service };
    const refused = await call("POST /v1/visits", w.caregiverA1, { body });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.message).toMatch(/reason is required/);

    const started = await call("POST /v1/visits", w.caregiverA1, { body: { ...body, unscheduledReason: "Synthetic: client asked for extra help" } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const visitId = started.body.visitId as string;
    await ageVisit(db, visitId, 60);
    expect((await call("POST /v1/visits/{visitId}/end", w.caregiverA1, { path: { visitId } })).status).toBe(200);

    const key = randomUUID();
    const confirm = () => call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, {
      path: { visitId }, key,
      body: { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng(60, 30, 1).toString("base64"), attested: true },
    });
    const r = await confirm();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ visitId, status: "administrator_review", workedMinutes: 60, billableMinutes: 60 });
    expect(r.body.result.outcome).toMatchObject({ reviewReasons: ["unscheduled"], unscheduledReason: "Synthetic: client asked for extra help", attestationVersion: "attest-v1", billableMinutes: 60 });

    // A retry with the same key returns the same answer, with the same outcome fields, and changes nothing.
    const again = await confirm();
    expect(again.status).toBe(200);
    expect(again.body.result.outcome).toMatchObject({ reviewReasons: ["unscheduled"], attestationVersion: "attest-v1" });
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_confirmations where visit_id = $1", [visitId])).rows[0].n).toBe(1);

    // The manager's review screen shows the reason and the rule that was applied.
    const review = await call("GET /v1/visits/{visitId}/review", w.managerA, { path: { visitId }, query: { organizationId: w.orgA } });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.visit).toMatchObject({ unscheduledReason: "Synthetic: client asked for extra help", ruleSource: "system_default", ruleMinutes: 15, attestationVersion: "attest-v1" });
  });

  it("an older app that sends no attestation still confirms; the version is recorded as not recorded; a scheduled visit inside the rule stays signed", async () => {
    const f = await freshClient(db, w, w.caregiverA2, 600, w.orgA, { before: 40, after: 40 });
    await createHelperShift(db, w.orgA, w.caregiverA2.userId, f.client, f.service);
    const started = await call("POST /v1/visits", w.caregiverA2, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const visitId = started.body.visitId as string;
    await ageVisit(db, visitId, 120);
    await call("POST /v1/visits/{visitId}/end", w.caregiverA2, { path: { visitId } });
    const r = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA2, {
      path: { visitId }, key: randomUUID(),
      body: { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng(60, 30, 2).toString("base64") },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ status: "signed" });
    expect(r.body.result.outcome).toMatchObject({ reviewReasons: [], attestationVersion: null });
  });
});

describe("agency visit rule (G02)", () => {
  it("shows the default; only the Administrator changes it; the change is a new version with who, when and why", async () => {
    const before = await call("GET /v1/visit-rules", w.managerA, { query: { organizationId: w.orgA } });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.rules[0]).toMatchObject({ version: 0, minutes: 15, source: "system_default" });

    const body = { organizationId: w.orgA, minutes: 30, reason: "Synthetic: our payer tolerates 30 minutes" };
    expect((await call("POST /v1/visit-rules", w.managerA, { body, key: randomUUID() })).status).toBe(403);
    const key = randomUUID();
    const set = await call("POST /v1/visit-rules", w.ownerA, { body, key });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect(set.body.version).toBe(1);
    // Same key again: still one new version.
    expect((await call("POST /v1/visit-rules", w.ownerA, { body, key })).status).toBe(201);
    const after = await call("GET /v1/visit-rules", w.managerA, { query: { organizationId: w.orgA } });
    expect(after.body.rules.map((r: any) => r.minutes)).toEqual([30, 15]);
    // A caregiver sees nothing: the list is empty, not an error that confirms the setting exists.
    expect((await call("GET /v1/visit-rules", w.caregiverA1, { query: { organizationId: w.orgA } })).body.rules).toEqual([]);
    expect((await call("POST /v1/visit-rules", w.ownerA, { body: { organizationId: w.orgA, minutes: "30" }, key: randomUUID() })).status).toBe(400);
  });
});

describe("open shifts (G09)", () => {
  it("lists open shifts for an assigned caregiver, picks one up once, and a second caregiver is told it was filled", async () => {
    const today = await orgToday(db);
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
    await db.admin.query(
      "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
      [w.orgA, w.caregiverA2.userId, f.client, f.service, today]);
    const d = new Date(Date.parse(`${today}T12:00:00Z`) + 3 * 864e5).toISOString().slice(0, 10);
    const created = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, date: d, startTime: "09:00", endTime: "11:00" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const shiftId = created.body.shift?.shiftId ?? created.body.shiftId;

    const listed = await call("GET /v1/open-shifts", w.caregiverA2, { query: { organizationId: w.orgA } });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.shifts.find((s: any) => s.shiftId === shiftId)).toBeTruthy();

    // 0063: asking does not assign; the administrator confirms.
    const asked = await call("POST /v1/shifts/{shiftId}/pickup", w.caregiverA2, { path: { shiftId }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toEqual({ pickupState: "requested" });
    expect((await db.admin.query("select caregiver_user_id from ogevia.shifts where id = $1", [shiftId])).rows[0].caregiver_user_id).toBeNull();
    const askedToo = await call("POST /v1/shifts/{shiftId}/pickup", w.caregiverA1, { path: { shiftId }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(askedToo.status).toBe(200); // two caregivers may ask; the office chooses

    const asCaregiver = await call("GET /v1/shift-pickups", w.caregiverA2, { query: { organizationId: w.orgA } });
    expect(asCaregiver.body.requests).toEqual([]); // the queue is the office's
    const queue = await call("GET /v1/shift-pickups", w.managerA, { query: { organizationId: w.orgA } });
    expect(queue.status).toBe(200);
    const mine = queue.body.requests.find((r: any) => r.shiftId === shiftId && r.caregiverCode === "CG-A2");
    expect(mine).toBeTruthy();
    expect(mine.blockers).toEqual([]);
    const refused = await call("POST /v1/shift-pickups/{requestId}/confirm", w.caregiverA2, { path: { requestId: mine.requestId }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(refused.status).toBe(403);
    const won = await call("POST /v1/shift-pickups/{requestId}/confirm", w.managerA, { path: { requestId: mine.requestId }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(won.status, JSON.stringify(won.body)).toBe(200);
    expect(won.body).toEqual({ coverageState: "covered" });
    const theirs = queue.body.requests.find((r: any) => r.shiftId === shiftId && r.caregiverCode === "CG-A1");
    const late = await call("POST /v1/shift-pickups/{requestId}/confirm", w.managerA, { path: { requestId: theirs.requestId }, body: { organizationId: w.orgA }, key: randomUUID() });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.body.error.message).toMatch(/closed|just filled|already/);
    expect((await db.admin.query("select caregiver_user_id from ogevia.shifts where id = $1", [shiftId])).rows[0].caregiver_user_id).toBe(w.caregiverA2.userId);
    const declined = await call("POST /v1/shift-pickups/{requestId}/decline", w.managerA, { path: { requestId: theirs.requestId }, body: { organizationId: w.orgA, reason: "Synthetic" }, key: randomUUID() });
    expect(declined.status).toBeGreaterThanOrEqual(400); // already closed when the shift was filled
  });
});
