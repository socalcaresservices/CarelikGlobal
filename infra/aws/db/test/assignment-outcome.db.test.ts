// 0078 One server-side assignment outcome (Allowed / Warning / Blocked), "Service not approved", hour-limit messages with actual and allowed hours.
// SYNTHETIC data only. Dates are computed from the agency-local "today" and the shifts are typed in agency-local time (no clock-of-day dependence).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let recA3: string;
let cpr: string;
let tb: string;
let fx: { client: string; service: string; auth: string };
const sha = "c".repeat(64);

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const recOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;
const evaluate = (rec: string, day: string, start: string, end: string, client: string | null = fx.client, ctx = "shift") =>
  call(w.managerA, "select ogevia_api.evaluate_assignment_readiness_local($1,$2,$3,$4::date,$5::time,$6::time,$7,null,$8) as r", [w.orgA, rec, fx.service, day, start, end, ctx, client]).then((r) => r[0].r);
const createShift = (day: string, start: string, end: string, rec: string | null) =>
  call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,$8)", [w.orgA, fx.client, fx.service, day, start, end, rec, randomUUID()]);
const serviceChecks = (on: boolean) => call(w.ownerA, "select ogevia_api.set_service_checks($1,$2,'Synthetic review complete') as s", [w.orgA, on]);
const approveService = (rec: string) => call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,'Observed visit completed')", [w.orgA, rec, fx.service, today]);
const setLimit = (rec: string, daily: number | null, weekly: number | null) => call(w.managerA, "select ogevia_api.set_hour_limit($1,$2,$3,$4,'block','Synthetic limit')", [w.orgA, rec, daily, weekly]);
const baseline = async (rec: string, windows: { weekday: number; start_local: string; end_local: string }[]) => {
  await db.admin.query("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [rec]);
  for (const x of windows) await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,$4,$5)", [w.orgA, rec, x.weekday, x.start_local, x.end_local]);
};
const allWeek = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: "00:00", end_local: "23:59" }));
const clearShifts = async () => {
  await db.admin.query("delete from ogevia.authorization_reservations where shift_id is not null; delete from ogevia.shift_coverage_events;");
  await db.admin.query("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};
async function makeDocsCurrent(rec: string, owner: Actor) {
  for (const [type, expires] of [[cpr, await add(400)], [tb, null]] as const) {
    const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
    const version = randomUUID();
    const row = (await call(owner, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
      doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(-5), expires]))[0];
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
  }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  recA1 = await recOf(w.caregiverA1); recA2 = await recOf(w.caregiverA2); recA3 = await recOf(w.caregiverA3);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  await makeDocsCurrent(recA1, w.ownerA);
  await makeDocsCurrent(recA2, w.ownerA);
  await baseline(recA1, allWeek);
  await baseline(recA2, []);
  await baseline(recA3, allWeek);
  const st = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
  await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, st.affectedShiftsCount]);
});
afterAll(async () => db?.drop());

describe("one outcome from the same rows", () => {
  it("Service checks Off: a missing service approval is a Warning named 'Service not approved', and the shift can still be created", async () => {
    const day = await add(4);
    const ev = await evaluate(recA1, day, "09:00", "11:00");
    expect(ev).toMatchObject({ outcome: "warning", summary: "Warning: Service not approved", ready: true, wouldBlockAfterActivation: true });
    expect(ev.checks.find((c: any) => c.check === "service")).toMatchObject({ status: "blocked", enforced: false, blocking: false, message: "Service not approved" });
    expect(await createShift(day, "09:00", "11:00", recA1)).toHaveLength(1);
    await clearShifts();
  });
  it("Service checks On: the same missing approval is Blocked, with the same words in the summary and in the refusal", async () => {
    await serviceChecks(true);
    const day = await add(4);
    const ev = await evaluate(recA1, day, "09:00", "11:00");
    expect(ev).toMatchObject({ outcome: "blocked", summary: "Blocked: Service not approved", ready: false });
    await expectPgError(createShift(day, "09:00", "11:00", recA1), "OGR30", /^Service not approved$/);
  });
  it("Allowed once the approval exists: the summary is just 'Allowed' and nothing blocks", async () => {
    await approveService(recA1);
    const ev = await evaluate(recA1, await add(4), "09:00", "11:00");
    expect(ev).toMatchObject({ outcome: "allowed", summary: "Allowed", ready: true, wouldBlockAfterActivation: false });
    expect(ev.checks.some((c: any) => c.blocking || c.status === "blocked")).toBe(false);
  });
  it("Blocked wins over a Warning, and the summary names the blocking reason, not the warning", async () => {
    await serviceChecks(false); // service is now only a warning for A3 (no approval) ...
    const ev = await evaluate(recA3, await add(4), "09:00", "11:00");
    expect(ev.checks.find((c: any) => c.check === "service")).toMatchObject({ status: "blocked", blocking: false });
    expect(ev.outcome).toBe("blocked"); // ... but A3 has no CPR/TB, which is mandatory
    expect(ev.summary).toMatch(/^Blocked: CPR missing\./);
    expect(ev.summary).not.toMatch(/Service not approved/);
    await serviceChecks(true);
  });
  it("A recorded availability override keeps the outcome Allowed (an override is not a warning); without it the outcome is Blocked", async () => {
    await approveService(recA2);
    const day = await add(6);
    const before = await evaluate(recA2, day, "09:00", "11:00");
    expect(before).toMatchObject({ outcome: "blocked", summary: "Blocked: Availability not provided." });
    await call(w.ownerA, "select ogevia_api.authorize_availability_override($1,$2,($3::date + $4::time) at time zone 'America/Los_Angeles',($3::date + $5::time) at time zone 'America/Los_Angeles','Agency asked for this caregiver',$6) as id",
      [w.orgA, recA2, day, "09:00", "11:00", fx.client].map((x) => x));
    const after = await evaluate(recA2, day, "09:00", "11:00");
    expect(after).toMatchObject({ outcome: "allowed", summary: "Allowed", ready: true });
    expect(after.checks.find((c: any) => c.check === "availability")).toMatchObject({ status: "overridden" });
  });
  it("missing matching score, ZIP/distance and optional experience never change the outcome: that caregiver is Allowed and can be assigned by hand", async () => {
    // A1 has no ZIP, no experience records and no scoring data at all (the Matches score is incomplete), yet the outcome is Allowed.
    const day = await add(5);
    const m = (await call(w.managerA, "select ogevia_api.match_caregivers($1,$2,$3,$4::jsonb,null,null) as r", [w.orgA, fx.service, fx.client,
      JSON.stringify([{ starts_at: `${day}T09:00:00-07:00`, ends_at: `${day}T11:00:00-07:00` }])]))[0].r;
    expect(m.candidates.find((c: any) => c.caregiverCode === "CG-A1").score.complete).toBe(false);
    expect((await evaluate(recA1, day, "09:00", "11:00")).outcome).toBe("allowed");
    expect(await createShift(day, "09:00", "11:00", recA1)).toHaveLength(1);
    await clearShifts();
  });
});

describe("hour-limit messages carry the actual and the allowed hours", () => {
  it("daily: 8 h booked + 2.5 h more against a 9 h limit reads 'Daily limit exceeded: 10.5 of 9 h' in the outcome, the refusal and the backstop", async () => {
    await clearShifts();
    await setLimit(recA1, 540, null);
    const day = await add(8);
    await createShift(day, "06:00", "14:00", recA1);
    const ev = await evaluate(recA1, day, "14:00", "16:30");
    expect(ev).toMatchObject({ outcome: "blocked", summary: "Blocked: Daily limit exceeded: 10.5 of 9 h", ready: false });
    expect(ev.checks.find((c: any) => c.check === "hours")).toMatchObject({ code: "daily_hour_limit", message: "Daily limit exceeded: 10.5 of 9 h", blocking: true });
    await expectPgError(createShift(day, "14:00", "16:30", recA1), "OGR30", /^Daily limit exceeded: 10\.5 of 9 h$/);
    // the table trigger gives the same words when a shift is written another way
    await expectPgError(db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4, ($5::date + time '14:00') at time zone 'America/Los_Angeles', ($5::date + time '16:30') at time zone 'America/Los_Angeles', 'scheduled')`,
      [w.orgA, fx.client, fx.service, recA1, day]), "OGR30", /^Daily limit exceeded: 10\.5 of 9 h$/);
    expect((await evaluate(recA1, day, "14:00", "15:00")).outcome).toBe("allowed"); // exactly 9 h is within the limit
  });
  it("weekly: 9 h booked + 1.25 h more against a 10 h limit reads 'Weekly limit exceeded: 10.25 of 10 h'; whole numbers drop the decimals", async () => {
    await clearShifts();
    await setLimit(recA1, null, 600);
    const monday = (await db.admin.query<{ d: string }>("select to_char(date_trunc('week', $1::date + 21), 'YYYY-MM-DD') d", [today])).rows[0]!.d;
    const at = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [monday, n])).rows[0]!.d;
    await createShift(await at(0), "09:00", "13:30", recA1);
    await createShift(await at(1), "09:00", "13:30", recA1);
    const ev = await evaluate(recA1, await at(2), "09:00", "10:15");
    expect(ev).toMatchObject({ outcome: "blocked", summary: "Blocked: Weekly limit exceeded: 10.25 of 10 h" });
    await expectPgError(createShift(await at(2), "09:00", "10:15", recA1), "OGR30", /^Weekly limit exceeded: 10\.25 of 10 h$/);
    expect((await evaluate(recA1, await at(2), "09:00", "10:00")).outcome).toBe("allowed");
    await setLimit(recA1, null, null);
    await clearShifts();
  });
});

describe("submit-time recheck: the screen's earlier answer never grants the assignment", () => {
  it("the checks said Allowed; before the assignment is submitted the caregiver is double-booked, so the same submission is refused (assign)", async () => {
    await clearShifts();
    const day = await add(10);
    expect((await evaluate(recA1, day, "09:00", "11:00")).outcome).toBe("allowed");
    const open = (await createShift(day, "09:00", "11:00", null))[0];
    const second = (await createShift(day, "13:00", "15:00", null))[0];
    expect((await evaluate(recA1, day, "09:00", "11:00", fx.client)).outcome).toBe("allowed");
    // meanwhile somebody else books A1 into the same time
    await db.admin.query("update ogevia.shifts set caregiver_record_id = $1 where id = $2", [recA1, second.shift_id]);
    await db.admin.query("update ogevia.shifts set starts_at = starts_at - interval '3 hours', ends_at = ends_at - interval '3 hours' where id = $1", [second.shift_id]);
    await expectPgError(call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic fill',$4)", [w.orgA, open.shift_id, recA1, randomUUID()]), "OGC09", /already has a shift|Already booked/i);
    const stillOpen = (await db.admin.query("select caregiver_record_id from ogevia.shifts where id = $1", [open.shift_id])).rows[0];
    expect(stillOpen.caregiver_record_id).toBeNull();
    await clearShifts();
  });
  it("the checks said Allowed; before assignment a compliance document lapses, so assigning is refused with the document words", async () => {
    await clearShifts();
    const day = await add(11);
    expect((await evaluate(recA1, day, "09:00", "11:00")).outcome).toBe("allowed");
    await db.admin.query("update ogevia.staff_documents set closed_at = now() where caregiver_record_id = $1 and closed_at is null", [recA1]);
    await expectPgError(createShift(day, "09:00", "11:00", recA1), "OGR30", /CPR missing\./);
    expect((await evaluate(recA1, day, "09:00", "11:00")).outcome).toBe("blocked");
    await makeDocsCurrent(recA1, w.ownerA);
  });
});
