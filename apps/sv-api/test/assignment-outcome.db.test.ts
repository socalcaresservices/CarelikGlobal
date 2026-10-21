// 0078 through the real Lambda handler and a disposable PostgreSQL: the server's single assignment outcome, and the submit-time recheck.
// A caregiver the screen showed as Allowed is refused when the assignment is submitted after the situation changed. SYNTHETIC data only.
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
let recA1: string;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 100000);
  today = await orgToday(db);
  recA1 = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
  for (const d of [0, 1, 2, 3, 4, 5, 6]) await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, recA1, d]);
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

describe("assignment outcome and submit-time recheck over HTTP", () => {
  it("POST /v1/readiness/evaluate returns one outcome and summary; a caregiver with no score, ZIP or experience data is not blocked and can be assigned", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 40, after: 200 });
    const ev = await call("POST /v1/readiness/evaluate", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId: recA1, serviceId: f.service, clientId: f.client, date: day(5), startTime: "09:00", endTime: "11:00" } });
    expect(ev.status, JSON.stringify(ev.body)).toBe(200);
    // Before the agency activates document rules the missing CPR/TB set-up is a Warning (report-only), never a block; the missing score data adds nothing.
    expect(ev.body.evaluation).toMatchObject({ outcome: "warning", ready: true });
    expect(ev.body.evaluation.summary).toMatch(/^Warning: /);
    // Nothing about a score, distance or experience is a readiness row.
    expect(ev.body.evaluation.checks.map((c: any) => c.check).sort()).not.toEqual(expect.arrayContaining(["score", "distance", "experience"]));
    const made = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, date: day(5), startTime: "09:00", endTime: "11:00", caregiverRecordId: recA1 } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
  });

  it("the screen said the caregiver could be assigned (ready, not blocked); the caregiver's limit is then lowered; the same submission to the API is refused with the numbers", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 40, after: 200 });
    const screenBody = { organizationId: w.orgA, caregiverRecordId: recA1, serviceId: f.service, clientId: f.client, date: day(7), startTime: "09:00", endTime: "12:00" };
    const before = await call("POST /v1/readiness/evaluate", w.managerA, { body: screenBody });
    expect(before.body.evaluation).toMatchObject({ outcome: "warning", ready: true });
    // Between the check and the submit, the limit becomes 2 h a day.
    const set = await call("POST /v1/hour-limits", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId: recA1, maxDailyMinutes: 120, maxWeeklyMinutes: null, mode: "block", reason: "Synthetic change after the screen" } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const submit = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, date: day(7), startTime: "09:00", endTime: "12:00", caregiverRecordId: recA1 } });
    expect(submit.status).toBe(422);
    expect(submit.body.error).toMatchObject({ code: "not_ready", message: "Daily limit exceeded: 3 of 2 h" });
    const after = await call("POST /v1/readiness/evaluate", w.managerA, { body: screenBody });
    expect(after.body.evaluation).toMatchObject({ outcome: "blocked", summary: "Blocked: Daily limit exceeded: 3 of 2 h" });
    // Assigning an open shift is rechecked the same way.
    const open = await call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, date: day(7), startTime: "13:00", endTime: "16:00" } });
    const assign = await call("POST /v1/shifts/{shiftId}/caregiver", w.managerA, { path: { shiftId: open.body.shift.shiftId }, body: { organizationId: w.orgA, caregiverRecordId: recA1, reason: "Synthetic" }, key: randomUUID() });
    expect(assign.status).toBe(422);
    expect(assign.body.error.message).toBe("Daily limit exceeded: 3 of 2 h");
  });
});
