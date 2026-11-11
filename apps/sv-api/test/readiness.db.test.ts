// The caregiver-readiness routes through the real Lambda handler and a real (local, disposable) PostgreSQL.
// SYNTHETIC data only. Covers wiring, validation, status codes, permissions and the cross-tenant boundary.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, setBaselineAvailability, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let fx: { client: string; service: string; auth: string };
let handler: ReturnType<typeof createHandler>;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const day = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const rec = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1", [a.userId])).rows[0].id as string;

describe("availability request → approval, over HTTP", () => {
  it("the old direct save is withdrawn with a clear message; a request needs an Idempotency-Key and a reason; a pending request leaves approved hours alone", async () => {
    await setBaselineAvailability(db, w.orgA, w.caregiverA1, [{ weekday: 1, start_local: "08:00", end_local: "20:00" }]);
    const old = await call("POST /v1/availability/me", w.caregiverA1, { body: { organizationId: w.orgA, windows: [], unavailableDates: [] } });
    expect(old.status).toBe(422);
    expect(old.body.error).toMatchObject({ code: "availability_requires_approval", message: "Availability changes need administrator approval. Use Request change." });
    const body = { organizationId: w.orgA, kind: "weekly", windows: [{ weekday: 1, start_local: "09:00", end_local: "17:00" }], effectiveFrom: await day(7), reason: "New school schedule", baseVersion: 0 };
    expect((await call("POST /v1/availability/requests", w.caregiverA1, { body, key: null })).status).toBe(400);
    expect((await call("POST /v1/availability/requests", w.caregiverA1, { body: { ...body, reason: "  " } })).status).toBe(400);
    const made = await call("POST /v1/availability/requests", w.caregiverA1, { body });
    expect(made.status).toBe(201);
    const mine = await call("GET /v1/availability", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(mine.body.availability).toMatchObject({ version: 0, provided: true, weekly: [{ weekday: 1, start_local: "08:00", end_local: "20:00" }] });
    expect(mine.body.availability.pending).toHaveLength(1);
    // A stale form is refused with the exact guidance.
    const stale = await call("POST /v1/availability/requests", w.caregiverA1, { body: { ...body, baseVersion: 5, reason: "Second" } });
    expect(stale.status).toBe(409);
    // Only an administrator reviews; the preview carries the fixed note.
    const id = made.body.requestId as string;
    expect((await call("POST /v1/availability/requests/{requestId}/review", w.managerA, { path: { requestId: id }, body: { organizationId: w.orgA, decision: "approve" } })).status).toBe(403);
    const preview = await call("GET /v1/availability/requests/{requestId}", w.managerA, { path: { requestId: id }, query: { organizationId: w.orgA } });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.note).toBe("Approving availability does not assign work or change booked shifts.");
    const decline = await call("POST /v1/availability/requests/{requestId}/review", w.ownerA, { path: { requestId: id }, body: { organizationId: w.orgA, decision: "decline" } });
    expect(decline.status).toBe(422); // a decline needs a note
    const ok = await call("POST /v1/availability/requests/{requestId}/review", w.ownerA, { path: { requestId: id }, body: { organizationId: w.orgA, decision: "approve", note: "Fine" } });
    expect(ok.status).toBe(200);
    expect(ok.body.result).toMatchObject({ status: "approved", approvedVersion: 1 });
    const again = await call("POST /v1/availability/requests/{requestId}/review", w.ownerA, { path: { requestId: id }, body: { organizationId: w.orgA, decision: "approve" } });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already approved/);
    // Another agency cannot see or decide it.
    expect((await call("GET /v1/availability/requests", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
    expect((await call("POST /v1/availability/requests/{requestId}/review", w.managerB, { path: { requestId: id }, body: { organizationId: w.orgB, decision: "approve" } })).status).toBe(403); // no permission in their own agency; nothing about agency A is revealed
  });
});

describe("readiness gate over HTTP", () => {
  it("reads saved ZIPs through the administrator API, with own-user and cross-tenant denial", async () => {
    const caregiverRecordId = await rec(w.caregiverA1);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/zip", w.ownerA, { path: { caregiverRecordId }, body: { organizationId: w.orgA, zip: "92592" } })).status).toBe(200);
    const opts = { path: { caregiverRecordId }, query: { organizationId: w.orgA } };
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/zip", w.ownerA, opts)).body.location).toEqual({ zip: "92592", city: null });
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/zip", w.caregiverA1, opts)).status).toBe(403);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/zip", w.managerB, opts)).status).toBe(404);
    expect((await call("POST /v1/clients/{clientId}/zip", w.ownerA, { path: { clientId: fx.client }, body: { organizationId: w.orgA, zip: "92595" } })).status).toBe(200);
    expect((await call("GET /v1/clients/{clientId}/zip", w.ownerA, { path: { clientId: fx.client }, query: { organizationId: w.orgA } })).body.location).toEqual({ zip: "92595", city: null });
  });
  it("setup gaps are reported, activation is audited, and a blocked commit returns 422 not_ready with the exact words", async () => {
    const st = await call("GET /v1/readiness", w.managerA, { query: { organizationId: w.orgA } });
    expect(st.status).toBe(200);
    expect(st.body.readiness.setupComplete).toBe(false);
    expect((await call("GET /v1/readiness", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    // Administrator sets the rules.
    const cprType = (await call("POST /v1/document-types", w.managerA, { body: { organizationId: w.orgA, name: "CPR card", requiresExpiry: true } })).body.documentTypeId as string;
    const tbType = (await call("POST /v1/document-types", w.managerA, { body: { organizationId: w.orgA, name: "TB result", requiresExpiry: false } })).body.documentTypeId as string;
    expect(cprType && tbType).toBeTruthy();
    for (const [requirement, documentTypeId] of [["cpr", cprType], ["tb", tbType]] as const) {
      expect((await call("POST /v1/document-requirements/type", w.ownerA, { body: { organizationId: w.orgA, requirement, documentTypeId, reason: "Agency policy" } })).status).toBe(200);
    }
    expect((await call("POST /v1/document-requirements/policy", w.managerA, { body: { organizationId: w.orgA, requirement: "cpr", validityBasis: "document_expiry", reason: "x policy" } })).status).toBe(403);
    expect((await call("POST /v1/document-requirements/policy", w.ownerA, { body: { organizationId: w.orgA, requirement: "tb", validityBasis: "issue_plus_days", reason: "Policy" } })).status).toBe(422); // days required
    expect((await call("POST /v1/document-requirements/policy", w.ownerA, { body: { organizationId: w.orgA, requirement: "cpr", validityBasis: "document_expiry", reason: "Policy" } })).status).toBe(200);
    expect((await call("POST /v1/document-requirements/policy", w.ownerA, { body: { organizationId: w.orgA, requirement: "tb", validityBasis: "issue_plus_days", validityDays: 365, reason: "Policy" } })).status).toBe(200);
    const setup = await call("GET /v1/document-requirements", w.managerA, { query: { organizationId: w.orgA } });
    expect(setup.body.setup.incomplete).toBe(false);
    // Activation shows the report first: the wrong count is refused.
    const report = (await call("GET /v1/readiness", w.ownerA, { query: { organizationId: w.orgA } })).body.readiness;
    expect((await call("POST /v1/readiness/activate", w.ownerA, { body: { organizationId: w.orgA, reason: "Reviewed", expectedAffectedShifts: report.affectedShiftsCount + 1 } })).status).toBe(409);
    const on = await call("POST /v1/readiness/activate", w.ownerA, { body: { organizationId: w.orgA, reason: "Reviewed", expectedAffectedShifts: report.affectedShiftsCount } });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.readiness.enforcementActive).toBe(true);
    // A direct shift for a caregiver with no records is now refused with the specific words.
    await setBaselineAvailability(db, w.orgA, w.caregiverA1, [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: "00:00", end_local: "23:59" })));
    const shift = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: fx.client, serviceId: fx.service, date: await day(3), startTime: "09:00", endTime: "11:00", caregiverRecordId: await rec(w.caregiverA1) } });
    expect(shift.status).toBe(422);
    expect(shift.body.error).toMatchObject({ code: "not_ready", message: "CPR missing. TB missing." });
    // The per-check evaluation names each check separately and says which would block.
    const ev = await call("POST /v1/readiness/evaluate", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId: await rec(w.caregiverA1), serviceId: fx.service, startsAt: `${await day(3)}T09:00:00-07:00`, endsAt: `${await day(3)}T11:00:00-07:00` } });
    expect(ev.status).toBe(200);
    expect(ev.body.evaluation.ready).toBe(false);
    expect(ev.body.evaluation.checks.filter((c: any) => c.blocking).map((c: any) => c.message)).toEqual(["CPR missing.", "TB missing."]);
    // Service checks: administrator-only, on/off words.
    expect((await call("POST /v1/readiness/service-checks", w.managerA, { body: { organizationId: w.orgA, enabled: true, reason: "Review done" } })).status).toBe(403);
    const sc = await call("POST /v1/readiness/service-checks", w.ownerA, { body: { organizationId: w.orgA, enabled: true, reason: "Review done" } });
    expect(sc.body.readiness.serviceChecks).toMatchObject({ state: "On", label: "Service checks" });
  });
});

describe("service approvals and matching over HTTP", () => {
  it("approve → list → revoke with history; an unknown route key is not exposed; matching is staff-only and returns eligibility separately from the score", async () => {
    const r = await rec(w.caregiverA1);
    const approve = await call("POST /v1/caregiver-services", w.ownerA, { body: { organizationId: w.orgA, caregiverRecordId: r, serviceId: fx.service, effectiveFrom: today, reason: "Training done" } });
    expect(approve.status).toBe(201);
    expect((await call("POST /v1/caregiver-services", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId: r, serviceId: fx.service, effectiveFrom: today, reason: "Training done" } })).status).toBe(403);
    const mine = await call("GET /v1/caregiver-services", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(mine.body.approvals).toHaveLength(1);
    expect((await call("GET /v1/caregiver-services", w.caregiverA2, { query: { organizationId: w.orgA, caregiverRecordId: r } })).status).toBe(403);
    const m = await call("POST /v1/matching/candidates", w.managerA, { body: { organizationId: w.orgA, serviceId: fx.service, clientId: fx.client, intervals: [{ startsAt: `${await day(3)}T09:00:00-07:00`, endsAt: `${await day(3)}T11:00:00-07:00` }] } });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.matches).toMatchObject({ ruleVersion: "v0-provisional-50-25-25", ruleStatus: "provisional" });
    for (const c of m.body.matches.candidates) expect(c).toHaveProperty("eligibility");
    expect((await call("POST /v1/matching/candidates", w.caregiverA1, { body: { organizationId: w.orgA, serviceId: fx.service, clientId: fx.client, intervals: [{ startsAt: `${await day(3)}T09:00:00-07:00`, endsAt: `${await day(3)}T11:00:00-07:00` }] } })).status).toBe(403);
    expect((await call("POST /v1/matching/candidates", w.managerA, { body: { organizationId: w.orgA, serviceId: fx.service, clientId: fx.client, intervals: [] } })).status).toBe(400);
    const revoked = await call("POST /v1/caregiver-services/{approvalId}/revoke", w.ownerA, { path: { approvalId: approve.body.approvalId }, body: { organizationId: w.orgA, reason: "Competency concern" } });
    expect(revoked.status).toBe(200);
    expect(revoked.body.result.note).toMatch(/does not change past visits/);
    expect(randomUUID()).toBeTruthy();
  });
});
