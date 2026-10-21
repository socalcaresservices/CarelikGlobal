// The caregiver-compliance routes (0055) through the real Lambda handler and a real (local, disposable) PostgreSQL.
// OWNER-DEFINED rules, not verified legal requirements. SYNTHETIC data only.
// Covers wiring, validation, status codes, permissions, the cross-tenant boundary, and direct-API bypass attempts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let fx: { client: string; service: string; auth: string };
let handler: ReturnType<typeof createHandler>;
let rec1: string;
let rec2: string;

const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const rec = async (a: Actor) => (await q("select id from ogevia.caregiver_records where linked_user_id=$1", [a.userId])).rows[0].id as string;
const day = async (n: number) => (await q("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d as string;

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  rec1 = await rec(w.caregiverA1);
  rec2 = await rec(w.caregiverA2);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function activate() {
  // Use the real API functions through SQL as the owner, the same calls the settings screens make.
  const as = async (a: Actor, sql: string, params: unknown[]) => {
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query("set local role ogevia_app");
      await c.query("select ogevia_api.begin_request($1,$2)", [a.sub, randomUUID()]);
      const r = await c.query(sql, params);
      await c.query("commit");
      return r.rows;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  const cpr = (await as(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  const tb = (await as(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await as(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await as(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await as(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await as(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  for (const r of [rec1, rec2]) {
    await q("delete from ogevia.caregiver_availability_windows where caregiver_record_id=$1", [r]);
    for (let d = 0; d < 7; d++) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, r, d]);
  }
  const s = (await as(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
  await as(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, s.affectedShiftsCount]);
}

describe("compliance routes: wiring, validation and permissions", () => {
  it("reads need a signed-in staff member; a caregiver and another agency are refused; the other agency gets 404", async () => {
    const path = { caregiverRecordId: rec1 };
    expect((await handler(event("GET /v1/caregivers/{caregiverRecordId}/compliance", { sub: null, path, query: { organizationId: w.orgA } }))).statusCode).toBe(401);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/compliance", w.caregiverA2, { path, query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/compliance", w.managerB, { path, query: { organizationId: w.orgA } })).status).toBe(404);
    const ok = await call("GET /v1/caregivers/{caregiverRecordId}/compliance", w.managerA, { path, query: { organizationId: w.orgA } });
    expect(ok.status).toBe(200);
    expect(ok.body.compliance).toMatchObject({ caregiverRecordId: rec1, graceDays: 14, hireDate: null, background: { qualifies: true } });
    expect(ok.body.compliance.deadlineRule).toMatch(/Hire date is day 0/);
    expect((await call("GET /v1/compliance/holds", w.caregiverA2, { query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/compliance/holds", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
  });

  it("hire date: needs an Idempotency-Key, a valid date and a reason; the office may enter a missing one; a recorded one is administrator-only", async () => {
    const path = { caregiverRecordId: rec1 };
    const body = { organizationId: w.orgA, hireDate: await day(-3), reason: "Offer letter signed" };
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerA, { path, body, key: null })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerA, { path, body: { ...body, hireDate: "2026-02-31" } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerA, { path, body: { ...body, hireDate: "not a date" } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerA, { path, body: { ...body, reason: "  " } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.schedulerA, { path, body })).status).toBe(403);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerB, { path, body })).status).toBe(404);
    const key = randomUUID();
    const made = await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerA, { path, body, key });
    expect(made.status).toBe(200);
    expect(made.body.compliance).toMatchObject({ hireDate: await day(-3), dueDate: await day(11), inGrace: true });
    const again = await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerA, { path, body, key });
    expect(again.body).toEqual(made.body); // a retry is the same answer
    const changed = await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.managerA, { path, body: { ...body, hireDate: await day(-1) } });
    expect(changed.status).toBe(403);
    const owner = await call("POST /v1/caregivers/{caregiverRecordId}/hire-date", w.ownerA, { path, body: { ...body, hireDate: await day(-1), reason: "Corrected" } });
    expect(owner.status).toBe(200);
  });

  it("background check: status is tracked by the office; the RESULT is recorded only by an administrator, with an evidence note", async () => {
    const path = { caregiverRecordId: rec2 };
    await q("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [rec2]);
    const st = (b: Record<string, unknown>, a: Actor = w.managerA) => call("POST /v1/caregivers/{caregiverRecordId}/background-check/status", a, { path, body: { organizationId: w.orgA, ...b } });
    expect((await st({ status: "approved" })).status).toBe(400); // approved is a RESULT, not a status
    expect((await st({ status: "completed" }, w.caregiverA1)).status).toBe(403);
    const done = await st({ status: "completed", note: "Agency says the report is back" });
    expect(done.status).toBe(200);
    expect(done.body.compliance.background).toMatchObject({ status: "completed", qualifies: false, state: "completed_not_approved" });
    const ver = (b: Record<string, unknown>, a: Actor = w.ownerA) => call("POST /v1/caregivers/{caregiverRecordId}/background-check/verify", a, { path, body: { organizationId: w.orgA, ...b } });
    expect((await ver({ result: "approved", evidenceNote: "Confirmed in the agency clearance record" }, w.managerA)).status).toBe(403);
    expect((await ver({ result: "completed", evidenceNote: "Confirmed in the agency clearance record" })).status).toBe(400);
    expect((await ver({ result: "approved" })).status).toBe(400);
    expect((await ver({ result: "approved", evidenceNote: "  " })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/background-check/verify", w.ownerA, { path, body: { organizationId: w.orgA, result: "approved", evidenceNote: "Confirmed in the agency clearance record" }, key: null })).status).toBe(400);
    const ok = await ver({ result: "approved", evidenceNote: "Confirmed in the agency clearance record" });
    expect(ok.status).toBe(200);
    expect(ok.body.compliance.background).toMatchObject({ qualifies: true, state: "approved", verifiedByName: "OWNER_A" });
    expect(JSON.stringify(ok.body)).not.toMatch(/passw|secret|token/i);
  });
});

describe("direct API bypass attempts on a caregiver on hold", () => {
  beforeAll(async () => {
    await activate();
    await q("update ogevia.caregiver_records set hire_date = $2::date - 30 where id = $1", [rec1, today]); // the period ended long ago
    await q("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [rec2]);
    await q("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','approved','Synthetic fixture clearance',$3,now())", [rec2, w.orgA, w.ownerA.userId]);
    await q("update ogevia.caregiver_records set hire_date = $2::date - 1 where id = $1", [rec2, today]);
  });

  it("every enforcement route refuses with 422 not_ready and a plain reason; nothing is written", async () => {
    const before = (await q("select (select count(*) from ogevia.shifts) s, (select count(*) from ogevia.caregiver_assignments) a, (select count(*) from ogevia.service_visits) v")).rows[0];
    const shiftBody = { organizationId: w.orgA, clientId: fx.client, serviceId: fx.service, date: await day(5), startTime: "09:00", endTime: "11:00", caregiverRecordId: rec1 };
    const create = await call("POST /v1/shifts", w.managerA, { body: shiftBody });
    expect(create.status).toBe(422);
    expect(create.body.error).toMatchObject({ code: "not_ready" });
    expect(create.body.error.message).toMatch(/CPR missing\.\s+TB missing\./);
    const assignment = await call("POST /v1/assignments", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId: rec1, clientId: fx.client, serviceId: fx.service, effectiveStart: today } });
    expect(assignment.status).toBe(422);
    const start = await call("POST /v1/visits", w.caregiverA1, { body: { organizationId: w.orgA, clientId: fx.client, serviceId: fx.service, unscheduledReason: "Synthetic: not on my schedule" } });
    expect(start.status).toBe(422);
    // an open shift the held caregiver tries to pick up
    const open = await call("POST /v1/shifts", w.managerA, { body: { ...shiftBody, caregiverRecordId: null, date: await day(6) } });
    expect(open.status).toBe(201);
    const shiftId = (await q("select id from ogevia.shifts where caregiver_record_id is null and status='scheduled' limit 1")).rows[0].id as string;
    const pick = await call("POST /v1/shifts/{shiftId}/pickup", w.caregiverA1, { path: { shiftId }, body: { organizationId: w.orgA } });
    expect(pick.status).toBe(422);
    // reassignment of an existing shift onto the held caregiver
    const reassign = await call("POST /v1/shifts/{shiftId}/caregiver", w.managerA, { path: { shiftId }, body: { organizationId: w.orgA, caregiverRecordId: rec1, reason: "Coverage" } });
    expect(reassign.status).toBe(422);
    const after = (await q("select (select count(*) from ogevia.shifts) s, (select count(*) from ogevia.caregiver_assignments) a, (select count(*) from ogevia.service_visits) v")).rows[0];
    expect(Number(after.s)).toBe(Number(before.s) + 1); // only the open shift made above
    expect(after.a).toBe(before.a);
    expect(after.v).toBe(before.v);
    // 0081 (was: "the caregiver who is inside the period and cleared is not affected" -> 201): a caregiver inside the 14 days with approved background clearance but no
    // VERIFIED CPR/TB is refused too; the period only delays the automatic hold, it no longer lets work go ahead
    const ok = await call("POST /v1/shifts", w.managerA, { body: { ...shiftBody, caregiverRecordId: rec2, date: await day(7) } });
    expect(ok.status).toBe(422);
    expect(ok.body.error).toMatchObject({ code: "not_ready" });
    expect(ok.body.error.message).toMatch(/CPR missing\.\s+TB missing\./);
    expect(ok.body.error.message).not.toMatch(/Background check/);
  });

  it("the office sees the hold and the Action Needed numbers after the run; reasons are plain; no signature, name or payer data is returned", async () => {
    expect((await call("POST /v1/compliance/sweep", w.caregiverA2, { body: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("POST /v1/compliance/sweep", w.managerA, { body: { organizationId: w.orgA }, key: null })).status).toBe(200);
    const list = await call("GET /v1/compliance/holds", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.status).toBe(200);
    const mine = list.body.holds.find((h: any) => h.caregiverRecordId === rec1);
    expect(mine.reasons.map((r: any) => r.code)).toEqual(["missing_after_deadline", "missing_after_deadline"]);
    expect(Object.keys(mine)).toEqual(expect.arrayContaining(["holdId", "caregiverCode", "affectedShifts", "affectedAssignments", "inProgressVisits"]));
    const attention = await call("GET /v1/attention", w.managerA, { query: { organizationId: w.orgA } });
    expect(attention.body.summary.complianceHolds.holds).toBeGreaterThanOrEqual(1);
    // a caregiver sees none of it (null, not zero)
    const mineAtt = await call("GET /v1/attention", w.caregiverA2, { query: { organizationId: w.orgA } });
    expect(mineAtt.body.summary?.complianceHolds ?? null).toBeNull();
    const flags = await call("GET /v1/readiness/flags", w.managerA, { query: { organizationId: w.orgA, kind: "compliance" } });
    expect(flags.status).toBe(200);
    const report = await call("GET /v1/readiness", w.managerA, { query: { organizationId: w.orgA } });
    expect(report.body.readiness.compliance).toMatchObject({ enforcementActive: true, graceDays: 14 });
    expect(report.body.readiness.compliance.openHolds).toBeGreaterThanOrEqual(1);
    expect((await call("GET /v1/readiness/flags", w.managerA, { query: { organizationId: w.orgA, kind: "bogus" } })).status).toBe(400);
  });
});
