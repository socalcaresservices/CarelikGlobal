// Requirements 6-10 through the real Lambda handler and a disposable PostgreSQL (owner directive 2026-10-17): the agency's fixed 8 h / 40 h work-hour policy
// (no override through the API), recurring series that save the valid dates and report every rejected one, billing states, and "Check now" permission.
// Open-shift pickup and its confirmation are covered in wave1.db.test.ts. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 100000);
  today = await orgToday(db);
  await db.admin.query("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]);
  recA1 = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

describe("work-hour policy (requirement 6)", () => {
  it("the policy is readable, and no API call can raise, soften or remove it: a 9-hour shift is refused after every attempt", async () => {
    const policy = await call("GET /v1/work-hour-policy", w.managerA, { query: { organizationId: w.orgA } });
    expect(policy.status).toBe(200);
    expect(policy.body.policy).toMatchObject({ applies: true, maxDailyMinutes: 480, maxWeeklyMinutes: 2400 });
    const other = await call("GET /v1/work-hour-policy", w.managerB, { query: { organizationId: w.orgB } });
    expect(other.body.policy).toEqual(expect.objectContaining({ applies: false }));
    expect((await call("GET /v1/work-hour-policy", w.managerB, { query: { organizationId: w.orgA } })).body.policy).toEqual({ applies: false }); // another agency's manager sees nothing

    const f = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 40, after: 200 });
    // try to loosen through the API: an agency default and a per-caregiver row, report mode, maximum values
    for (const caregiverRecordId of [null, recA1]) {
      const set = await call("POST /v1/hour-limits", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId, maxDailyMinutes: 1440, maxWeeklyMinutes: 10080, mode: "report", reason: "Synthetic attempt to loosen" } });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
    }
    const nine = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, date: day(4), startTime: "06:00", endTime: "15:00", caregiverRecordId: recA1 } });
    expect(nine.status, JSON.stringify(nine.body)).toBe(422);
    expect(nine.body.error.code).toBe("not_ready");
    expect(nine.body.error.message).toMatch(/daily hour limit/i);
    const eight = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, date: day(4), startTime: "06:00", endTime: "14:00", caregiverRecordId: recA1 } });
    expect(eight.status, JSON.stringify(eight.body)).toBe(201);
    // the same limit applies to a series, the assignment of an open shift, and rescheduling
    const open = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, date: day(4), startTime: "15:00", endTime: "16:00" } });
    const assign = await call("POST /v1/shifts/{shiftId}/caregiver", w.managerA, { path: { shiftId: open.body.shift.shiftId }, body: { organizationId: w.orgA, caregiverRecordId: recA1, reason: "Synthetic" }, key: randomUUID() });
    expect(assign.status).toBe(422);
    const move = await call("POST /v1/shifts/{shiftId}/reschedule", w.managerA, { path: { shiftId: eight.body.shift.shiftId }, body: { organizationId: w.orgA, date: day(4), startTime: "06:00", endTime: "15:00", reason: "Synthetic" }, key: randomUUID() });
    expect(move.status).toBe(422);
  });
});

describe("recurring series (requirement 7)", () => {
  const body = (fx: { client: string; service: string }, extra: Record<string, unknown> = {}) => ({ organizationId: w.orgA, clientId: fx.client, serviceId: fx.service, caregiverRecordId: null, weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: "09:00", endTime: "11:00", startsOn: day(40), endsOn: day(66), ...extra });
  it("saves the dates that fit and returns every other date with its reason, in camelCase, ordered; the same key replays; a new key is refused as already saved", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 5, after: 200 });
    const key = randomUUID();
    const a = await call("POST /v1/shift-series", w.managerA, { body: body(fx), key });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const s = a.body.series;
    expect(s.created).toBeGreaterThan(0);
    expect(s.skipped).toBe(s.rejected.length);
    expect(s.rejected.length).toBeGreaterThan(12); // no cut-off
    expect(s.rejected[0]).toEqual({ localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), reason: "exceeds_authorization", minutes: 120 });
    const again = await call("POST /v1/shift-series", w.managerA, { body: body(fx), key });
    expect(again.body.series).toEqual(s);
    const dup = await call("POST /v1/shift-series", w.managerA, { body: body(fx), key: randomUUID() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/already saved/);
    const refuse = await call("POST /v1/shift-series", w.managerA, { body: body(fx, { onConflict: "refuse", startsOn: day(80), endsOn: day(86) }), key: randomUUID() });
    expect([201, 409]).toContain(refuse.status);
  });
  it("when nothing fits: seriesId null, created 0, every date listed, nothing saved", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 60, w.orgA, { before: 5, after: 200 });
    const r = await call("POST /v1/shift-series", w.managerA, { body: body(fx, { startsOn: day(100), endsOn: day(106) }), key: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.series).toMatchObject({ seriesId: null, created: 0, skipped: 7 });
    expect(r.body.series.rejected).toHaveLength(7);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_series where client_id = $1", [fx.client])).rows[0].n).toBe(0);
  });
});

describe("billing states (requirement 8)", () => {
  it("the billing review carries the server's state; approve, void and approve again move it Ready for Review -> Approved for Billing -> Voided -> Approved for Billing; the scheduler cannot see any of it", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600);
    const { visit } = await signedVisit(db, w.caregiverA3, w, 30, w.orgA, own.client);
    const q = { organizationId: w.orgA, dateFrom: day(-3), dateTo: day(3) };
    const row = async (a: Actor = w.managerA) => ((await call("GET /v1/billing-review", a, { query: q })).body.visits as any[] | undefined)?.find((v) => v.visitId === visit);
    expect(await row()).toMatchObject({ billingState: "ready_for_review", activeApprovalId: null });
    const approved = await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { organizationId: w.orgA, approvedMinutes: 30 }, key: randomUUID() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(await row()).toMatchObject({ billingState: "approved_for_billing" });
    const voided = await call("POST /v1/billing-approvals/{approvalId}/void", w.managerA, { path: { approvalId: approved.body.billingApprovalId }, body: { organizationId: w.orgA, reason: "Synthetic: wrong minutes" }, key: randomUUID() });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await row()).toMatchObject({ billingState: "voided", lastVoidReason: "Synthetic: wrong minutes" });
    expect((await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { organizationId: w.orgA, approvedMinutes: 30 }, key: randomUUID() })).status).toBe(201);
    expect(await row()).toMatchObject({ billingState: "approved_for_billing" });
    const sch = await call("GET /v1/billing-review", w.schedulerA, { query: q });
    expect(sch.status === 403 || (sch.body.visits ?? []).length === 0).toBe(true);
    expect((await call("GET /v1/billing-review", w.managerB, { query: { ...q, organizationId: w.orgA } })).status).toBeGreaterThanOrEqual(200);
    expect(((await call("GET /v1/billing-review", w.managerB, { query: { ...q, organizationId: w.orgA } })).body.visits ?? []).find((v: any) => v.visitId === visit)).toBeUndefined();
  });
});

describe("compliance 'Check now' (requirement 10)", () => {
  it("needs permission to manage the care team: a scheduler (who can read compliance) is refused, a manager is not", async () => {
    expect((await call("POST /v1/compliance/sweep", w.schedulerA, { body: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("POST /v1/compliance/sweep", w.managerA, { body: { organizationId: w.orgA }, key: null })).status).toBe(200);
    expect((await call("GET /v1/compliance/holds", w.schedulerA, { query: { organizationId: w.orgA } })).status).toBe(200);
  });
});
