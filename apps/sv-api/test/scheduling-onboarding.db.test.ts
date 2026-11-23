// Scheduling patterns, hour limits, make-up visits and onboarding through the real Lambda handler and a real (local,
// disposable) PostgreSQL. SYNTHETIC data only. Covers wiring, validation, status codes, permissions and the cross-tenant boundary.
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
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 400 });
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const day = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const rec = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1", [a.userId])).rows[0].id as string;
const nextWeekday = async (dow: number, minAhead = 8) => { for (let n = minAhead; n < minAhead + 7; n++) { const d = await day(n); if (new Date(`${d}T12:00:00Z`).getUTCDay() === dow) return d; } throw new Error("no date"); };

describe("repeat patterns over HTTP", () => {
  it("previews and creates every other Monday; a malformed pattern is a clear client error", async () => {
    const first = await nextWeekday(1);
    const query = { organizationId: w.orgA, clientId: fx.client, serviceId: fx.service, weekdays: "1", startTime: "09:00", endTime: "10:00", startsOn: first, endsOn: await day(60) };
    const pattern = JSON.stringify({ every_weeks: 2, anchor: first });
    const preview = await call("GET /v1/shift-series/preview", w.managerA, { query: { ...query, pattern } });
    expect(preview.status).toBe(200);
    const dates = preview.body.occurrences.filter((o: any) => o.outcome === "ok").map((o: any) => o.localDate);
    expect(dates.length).toBeGreaterThanOrEqual(4);
    expect(dates.slice(1).every((d: string, i: number) => (Date.parse(d) - Date.parse(dates[i])) / 864e5 === 14)).toBe(true);
    expect((await call("GET /v1/shift-series/preview", w.managerA, { query: { ...query, pattern: "not json" } })).status).toBe(400);
    expect((await call("GET /v1/shift-series/preview", w.managerA, { query: { ...query, pattern: JSON.stringify({ every_weeks: 9, anchor: first }) } })).status).toBe(422);
    const made = await call("POST /v1/shift-series", w.managerA, { body: { organizationId: w.orgA, clientId: fx.client, serviceId: fx.service, caregiverRecordId: null, weekdays: [1], startTime: "09:00", endTime: "10:00",
      startsOn: first, endsOn: await day(60), onConflict: "refuse", pattern: { every_weeks: 2, anchor: first } } });
    expect(made.status).toBe(201);
    expect(made.body.series.created).toBe(dates.length);
    const listed = await call("GET /v1/shift-series", w.managerA, { query: { organizationId: w.orgA } });
    expect(listed.body.series.find((s: any) => s.seriesId === made.body.series.seriesId).pattern).toEqual({ every_weeks: 2, anchor: first });
  });
});

describe("hour limits, load and make-up over HTTP", () => {
  it("sets a limit with a reason, lists the load, schedules a make-up, and refuses caregivers and other agencies", async () => {
    const cg = await rec(w.caregiverA2);
    const set = (actor: Actor, body: Record<string, unknown>) => call("POST /v1/hour-limits", actor, { body: { organizationId: w.orgA, caregiverRecordId: cg, maxDailyMinutes: 120, maxWeeklyMinutes: null, mode: "report", reason: "Synthetic", ...body } });
    expect((await set(w.caregiverA1, {})).status).toBe(403);
    expect((await set(w.managerB, {})).status).toBe(404);
    expect((await set(w.managerA, { reason: "" })).status).toBe(400);
    expect((await set(w.managerA, { mode: "stop" })).status).toBe(400);
    expect((await set(w.managerA, {})).status).toBe(200);
    expect((await call("GET /v1/hour-limits", w.managerA, { query: { organizationId: w.orgA } })).body.limits).toMatchObject([{ caregiverRecordId: cg, maxDailyMinutes: 120, mode: "report" }]);

    const d = await nextWeekday(3, 30);
    const shift = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: fx.client, serviceId: fx.service, date: d, startTime: "09:00", endTime: "12:00", caregiverRecordId: cg } });
    expect(shift.status).toBe(201);
    const load = await call("GET /v1/caregiver-load", w.managerA, { query: { organizationId: w.orgA, from: d, to: d } });
    expect(load.body.load[0]).toMatchObject({ caregiverRecordId: cg, overDaily: true, overWeekly: false, mode: "report" });
    expect((await call("GET /v1/caregiver-load", w.managerB, { query: { organizationId: w.orgA, from: d, to: d } })).body.load ?? []).toEqual([]);

    const cancel = await call("POST /v1/shifts/{shiftId}/cancel", w.managerA, { path: { shiftId: shift.body.shift.shiftId }, body: { organizationId: w.orgA, reason: "Synthetic: client unwell" } });
    expect(cancel.status).toBe(200);
    const sameDay = await call("POST /v1/shifts/{shiftId}/makeup", w.managerA, { path: { shiftId: shift.body.shift.shiftId }, body: { organizationId: w.orgA, localDate: d, startTime: "13:00", endTime: "14:00", caregiverRecordId: cg } });
    expect(sameDay.status).toBe(201);
    expect(sameDay.body.makeup).toMatchObject({ reservedMinutes: 60, unmadeMinutesAfter: 120 });
    expect((await call("POST /v1/shifts/{shiftId}/makeup", w.managerB, { path: { shiftId: shift.body.shift.shiftId }, body: { organizationId: w.orgA, localDate: d, startTime: "15:00", endTime: "16:00" } })).status).toBe(404);
  });
});

describe("recruiting and onboarding over HTTP", () => {
  it("creates an applicant, shows the pipeline and checklist, gates approval, records an item, and refuses caregivers and other agencies", async () => {
    const made = await call("POST /v1/caregivers", w.managerA, { body: { organizationId: w.orgA, firstName: "Synthetic", lastName: `Applicant ${randomUUID().slice(0, 4)}`, preferredName: null, status: "applicant" } });
    expect(made.status).toBe(201);
    const id = made.body.caregiver.caregiverRecordId as string;
    const overview = await call("GET /v1/onboarding/overview", w.managerA, { query: { organizationId: w.orgA } });
    expect(overview.body.caregivers.find((c: any) => c.caregiverRecordId === id)).toMatchObject({ status: "applicant", onboardingRequired: true, done: 0, total: 1 });
    const checklist = await call("GET /v1/caregivers/{caregiverRecordId}/onboarding", w.managerA, { path: { caregiverRecordId: id }, query: { organizationId: w.orgA } });
    expect(checklist.body.onboarding).toMatchObject({ complete: false, done: 0, total: 1 });
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/onboarding", w.caregiverA1, { path: { caregiverRecordId: id }, query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/onboarding", w.managerB, { path: { caregiverRecordId: id }, query: { organizationId: w.orgA } })).status).toBe(404);

    const approve = await call("POST /v1/caregivers/{caregiverRecordId}/status", w.managerA, { path: { caregiverRecordId: id }, body: { organizationId: w.orgA, status: "ready", reason: "Synthetic approval" } });
    expect(approve.status).toBe(409);
    expect(approve.body.error.message).toMatch(/Use Approve for work/);
    // 0086: the one approval step over HTTP names what is missing
    const direct = await call("POST /v1/caregivers/{caregiverRecordId}/approve", w.managerA, { path: { caregiverRecordId: id }, body: { organizationId: w.orgA } });
    expect(direct.status).toBe(409);
    expect(direct.body.error.message).toMatch(/Cannot approve yet\. Waiting on: Background check, Required training, App sign-in/);

    const item = (actor: Actor, body: Record<string, unknown>) => call("POST /v1/caregivers/{caregiverRecordId}/onboarding/items", actor, { path: { caregiverRecordId: id }, body: { organizationId: w.orgA, ...body } });
    expect((await item(w.managerA, { requirementKey: "background_check", action: "approve" })).status).toBe(400);
    expect((await item(w.caregiverA1, { requirementKey: "background_check", action: "complete" })).status).toBe(403);
    expect((await item(w.managerA, { requirementKey: "background_check", action: "complete", completedOn: today })).status).toBe(404); // 0086: retired as an onboarding item
    const done = await item(w.managerA, { requirementKey: "training", action: "complete", completedOn: today, note: "Done (synthetic)" });
    expect(done.status).toBe(200);
    expect(done.body.onboarding).toMatchObject({ done: 1, total: 1 });
    expect((await item(w.managerA, { requirementKey: "clearance", action: "waive", reason: "Synthetic" })).status).toBe(404);

    const reqs = await call("GET /v1/onboarding/requirements", w.managerA, { query: { organizationId: w.orgA } });
    expect(reqs.body.requirements.map((r: any) => r.requirementKey)).toEqual(["training"]);
    expect((await call("POST /v1/onboarding/requirements", w.managerA, { body: { organizationId: w.orgA, requirementKey: "orientation", label: "Agency orientation", category: "training", required: true, reason: "Synthetic" } })).status).toBe(200);
    expect((await call("GET /v1/caregivers/{caregiverRecordId}/onboarding", w.managerA, { path: { caregiverRecordId: id }, query: { organizationId: w.orgA } })).body.onboarding.total).toBe(2);
  });
});
