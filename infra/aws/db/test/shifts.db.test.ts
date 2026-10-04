// 0026 Staff-scheduled shifts, call-outs and replacements. SYNTHETIC data only.
// Every call runs as the application role through begin_request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let fresh: { client: string; service: string; auth: string };
const rec: Record<string, string> = {};
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  // A generous monthly allowance (period 40 days either side of today) so the
  // ordinary tests never run out; the limit itself is tested on its own client.
  fresh = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 });
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
// A date in the same month as `today` when possible, so all shifts share one authorization month.
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
let next = 1;
const slotDay = () => day(next++);
const create = (a: Actor, date: string, start: string, end: string, caregiver: string | null = null, key: string | null = null, client = fresh.client) =>
  q(a, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, $5::time, $6::time, $7, $8)",
    [w.orgA, client, fresh.service, date, start, end, caregiver, key]).then((r) => r[0]);
const list = (a: Actor, from = day(-1), to = day(30)) =>
  q(a, "select * from ogevia_api.list_shifts($1, $2::date, $3::date, null)", [w.orgA, from, to]);
const row = async (id: string) => (await list(w.managerA)).find((r) => r.shift_id === id);
const reservedTotal = async () => Number((await db.admin.query(
  "select coalesce(sum(reserved_minutes), 0) as n from ogevia.authorization_reservations r join ogevia.client_authorizations a on a.lineage_id = r.authorization_lineage_id where a.id = $1 and r.released_at is null", [fresh.auth])).rows[0].n);

describe("staff-scheduled shifts", () => {
  it("manager schedules a shift in agency time: minutes reserved against the authorization, covered, audited", async () => {
    const before = await reservedTotal();
    const s = await create(w.managerA, slotDay(), "09:00", "12:00", rec["CG-A1"]);
    expect(s.reserved_minutes).toBe(180);
    expect(await reservedTotal()).toBe(before + 180);
    const r = await row(s.shift_id);
    expect(r).toMatchObject({ coverage_state: "covered", caregiver_record_id: rec["CG-A1"], reserved_minutes: 180, from_care_request: false, has_visit: false });
    expect(new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()).toBe(3 * 3600e3);
    // Starts at 09:00 in the agency's time zone, not the database's.
    const local = (await db.admin.query("select to_char($1::timestamptz at time zone o.timezone, 'HH24:MI') as t from ogevia.organizations o where o.id = $2", [s.starts_at, w.orgA])).rows[0].t;
    expect(local).toBe("09:00");
    expect((await db.admin.query("select count(*)::int as n from ogevia.audit_events where entity_id = $1 and action = 'shift.created'", [s.shift_id])).rows[0].n).toBe(1);
  });

  it("an overnight shift ends the next day; a repeated request with the same key creates one shift", async () => {
    const key = crypto.randomUUID();
    const d = slotDay();
    const a = await create(w.managerA, d, "22:00", "02:00", null, key);
    const b = await create(w.managerA, d, "22:00", "02:00", null, key);
    expect(b.shift_id).toBe(a.shift_id);
    expect(a.reserved_minutes).toBe(240);
    expect((await row(a.shift_id)).coverage_state).toBe("needs_coverage");
  });

  it("refuses more time than the authorization has left this month, under concurrency too", async () => {
    // 300 minutes a month: two simultaneous 3-hour shifts each fit alone, not together.
    const small = await freshClient(db, w, w.caregiverA1, 300, w.orgA, { before: 40, after: 40 });
    const d = day(1);
    const make = () => q(w.managerA, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, '08:00', '11:00', null, null)",
      [w.orgA, small.client, small.service, d]).then((r) => r[0]);
    const results = await Promise.allSettled([make(), make()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("OGC09");
    expect(rejected.reason.message).toMatch(/Not enough authorized time remains this month for this shift \(120 minutes left\)/);
    // Exactly the remaining 120 minutes still fit.
    expect(await q(w.managerA, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, '12:00', '14:00', null, null)",
      [w.orgA, small.client, small.service, d]).then((r) => r[0].remaining_minutes)).toBe("0");
  });

  it("refuses overlapping shifts for one caregiver, onboarding caregivers, past shifts, other agencies and roles without shifts.manage", async () => {
    const d = slotDay();
    await create(w.managerA, d, "06:00", "07:00", rec["CG-A2"]);
    await expectPgError(create(w.managerA, d, "06:30", "07:30", rec["CG-A2"]), "OGC09", /already has a shift/);
    const [onb] = await q(w.managerA, "select * from ogevia_api.create_caregiver($1, 'Synthetic', 'Onboarding Shift', null, 'onboarding')", [w.orgA]);
    await expectPgError(create(w.managerA, d, "06:00", "07:00", onb.caregiver_record_id), "OGV22", /Ready to work or Active/);
    await expectPgError(create(w.managerA, day(-2), "06:00", "07:00"), "OGV22", /already over/);
    await expectPgError(create(w.managerA, d, "06:00", "06:05"), "OGV22", /15 minutes/);
    await expectPgError(create(w.caregiverA1, d, "06:00", "07:00"), "OGA03");
    await expectPgError(create(w.managerB, d, "06:00", "07:00"), "OGN04");
    expect(await create(w.schedulerA, d, "05:00", "05:30")).toMatchObject({ reserved_minutes: 30 });
    expect(await list(w.managerB)).toEqual([]);
    expect(await list(w.caregiverA1)).toEqual([]);
  });
});

describe("call-outs and replacements", () => {
  it("staff record a call-out, the shift needs coverage, a replacement covers it, history keeps both", async () => {
    const s = await create(w.managerA, slotDay(), "13:00", "15:00", rec["CG-A1"]);
    await expectPgError(q(w.managerA, "select ogevia_api.record_shift_callout($1, $2, 'x')", [w.orgA, s.shift_id]), "OGV22");
    expect((await q(w.managerA, "select ogevia_api.record_shift_callout($1, $2, $3) as s", [w.orgA, s.shift_id, "Sick (synthetic)"]))[0].s).toBe("needs_coverage");
    expect(await row(s.shift_id)).toMatchObject({ coverage_state: "needs_coverage", last_callout_reason: "Sick (synthetic)", reserved_minutes: 120 });
    await expectPgError(q(w.managerA, "select ogevia_api.record_shift_callout($1, $2, 'Again (synthetic)')", [w.orgA, s.shift_id]), "OGC09", /already recorded/);
    await expectPgError(q(w.managerA, "select ogevia_api.assign_shift_caregiver($1, $2, $3)", [w.orgA, s.shift_id, rec["CG-A1"]]), "OGC09", /called out/);
    expect((await q(w.managerA, "select ogevia_api.assign_shift_caregiver($1, $2, $3) as s", [w.orgA, s.shift_id, rec["CG-A3"]]))[0].s).toBe("covered");
    expect(await row(s.shift_id)).toMatchObject({ coverage_state: "covered", caregiver_record_id: rec["CG-A3"] });
    const history = await q(w.managerA, "select * from ogevia_api.list_shift_coverage($1, $2)", [w.orgA, s.shift_id]);
    expect(history.map((h) => h.event_type)).toEqual(["called_out", "reassigned"]);
    expect(history[0]).toMatchObject({ reason: "Sick (synthetic)", recorded_by: "staff" });
    expect(await q(w.managerB, "select * from ogevia_api.list_shift_coverage($1, $2)", [w.orgA, s.shift_id])).toEqual([]);
  });

  it("changing the caregiver of a covered shift needs a reason; the replacement must be free", async () => {
    const d = slotDay();
    const s = await create(w.managerA, d, "16:00", "17:00", rec["CG-A1"]);
    await create(w.managerA, d, "16:30", "18:00", rec["CG-A2"]);
    await expectPgError(q(w.managerA, "select ogevia_api.assign_shift_caregiver($1, $2, $3)", [w.orgA, s.shift_id, rec["CG-A3"]]), "OGV22", /reason/);
    await expectPgError(q(w.managerA, "select ogevia_api.assign_shift_caregiver($1, $2, $3, 'Swap (synthetic)')", [w.orgA, s.shift_id, rec["CG-A2"]]), "OGC09", /already has a shift/);
    expect((await q(w.managerA, "select ogevia_api.assign_shift_caregiver($1, $2, $3, 'Swap (synthetic)') as s", [w.orgA, s.shift_id, rec["CG-A3"]]))[0].s).toBe("covered");
  });

  it("a caregiver calls out of their own upcoming shift; nobody else's; the office sees it", async () => {
    const s = await create(w.managerA, slotDay(), "10:00", "11:00", rec["CG-A1"]);
    const mine = await q(w.caregiverA1, "select * from ogevia_api.list_my_shifts($1)", [w.orgA]);
    expect(mine.find((m) => m.shift_id === s.shift_id)).toMatchObject({ coverage_state: "covered", can_call_out: true });
    expect(Object.keys(mine[0]).sort()).toEqual(["can_call_out", "client_code", "coverage_state", "ends_at", "service_name", "shift_id", "starts_at"]);
    await expectPgError(q(w.caregiverA2, "select ogevia_api.call_out_my_shift($1, $2, 'Not mine (synthetic)')", [w.orgA, s.shift_id]), "OGN04");
    expect((await q(w.caregiverA1, "select ogevia_api.call_out_my_shift($1, $2, $3) as s", [w.orgA, s.shift_id, "Car broke down (synthetic)"]))[0].s).toBe("needs_coverage");
    expect((await q(w.caregiverA1, "select * from ogevia_api.list_my_shifts($1)", [w.orgA])).find((m) => m.shift_id === s.shift_id))
      .toMatchObject({ coverage_state: "called_out", can_call_out: false });
    const history = await q(w.managerA, "select * from ogevia_api.list_shift_coverage($1, $2)", [w.orgA, s.shift_id]);
    expect(history[0]).toMatchObject({ event_type: "called_out", recorded_by: "caregiver" });
  });

  it("cancelling releases the reserved time; a cancelled shift cannot be changed", async () => {
    const before = await reservedTotal();
    const s = await create(w.managerA, slotDay(), "18:00", "19:30");
    expect(await reservedTotal()).toBe(before + 90);
    await expectPgError(q(w.managerA, "select ogevia_api.cancel_shift($1, $2, '')", [w.orgA, s.shift_id]), "OGV22");
    expect((await q(w.managerA, "select ogevia_api.cancel_shift($1, $2, 'Client away (synthetic)') as n", [w.orgA, s.shift_id]))[0].n).toBe(90);
    expect(await reservedTotal()).toBe(before);
    expect((await row(s.shift_id)).coverage_state).toBe("cancelled");
    await expectPgError(q(w.managerA, "select ogevia_api.assign_shift_caregiver($1, $2, $3)", [w.orgA, s.shift_id, rec["CG-A3"]]), "OGC09", /no longer scheduled/);
    await expectPgError(q(w.caregiverA1, "select ogevia_api.cancel_shift($1, $2, 'Nope (synthetic)')", [w.orgA, s.shift_id]), "OGA03");
  });

  it("a caregiver with no standing assignment starts a visit from their staff-scheduled shift; it links, and the shift can no longer be changed", async () => {
    const { rows: [t] } = await db.admin.query(
      "select to_char(date_trunc('minute', now() at time zone o.timezone), 'HH24:MI') as start, to_char(date_trunc('minute', now() at time zone o.timezone) + interval '1 hour', 'HH24:MI') as end_ from ogevia.organizations o where o.id = $1", [w.orgA]);
    const s = await create(w.managerA, today, t.start, t.end_, rec["CG-A2"]);
    expect((await db.admin.query("select count(*)::int as n from ogevia.caregiver_assignments where caregiver_user_id = $1 and client_id = $2", [w.caregiverA2.userId, fresh.client])).rows[0].n).toBe(0);
    const visitId = await api.start(db, w.caregiverA2, w.orgA, fresh.client, fresh.service);
    expect((await db.admin.query("select scheduled_shift_id from ogevia.service_visits where id = $1", [visitId])).rows[0].scheduled_shift_id).toBe(s.shift_id);
    expect((await row(s.shift_id)).has_visit).toBe(true);
    await expectPgError(q(w.managerA, "select ogevia_api.record_shift_callout($1, $2, 'Too late (synthetic)')", [w.orgA, s.shift_id]), "OGC09", /visit has already started/);
    await expectPgError(q(w.managerA, "select ogevia_api.cancel_shift($1, $2, 'Too late (synthetic)')", [w.orgA, s.shift_id]), "OGC09", /visit is linked/);
  });
});
