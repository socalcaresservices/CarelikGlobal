// 0053 Scheduling: recurrence patterns (alternating weeks, nth weekday, exceptions, excluded dates), several caregivers for
// one client, caregiver hour limits (report / block, series counted), make-up visits, permissions and tenant isolation.
// SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const rec: Record<string, string> = {};
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 900);
  today = await orgToday(db);
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (n: number) => { const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
const monthEnd = (start: string) => { const d = new Date(`${start}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); };
const datesOf = (from: string, to: string, days: number[]) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) if (days.includes(d.getUTCDay())) out.push(iso(d));
  return out;
};
const preview = (a: Actor, client: string, service: string, caregiver: string | null, days: number[], start: string, end: string, from: string, to: string | null, pattern: unknown = null) =>
  q(a, "select *, local_date::text as local_date from ogevia_api.preview_shift_series($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, $8::date, $9::date, $10::jsonb)",
    [w.orgA, client, service, caregiver, days, start, end, from, to, pattern === null ? null : JSON.stringify(pattern)]);
const create = (a: Actor, client: string, service: string, caregiver: string | null, days: number[], start: string, end: string, from: string, to: string | null, pattern: unknown = null, onConflict = "refuse") =>
  q(a, "select * from ogevia_api.create_shift_series($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, $8::date, $9::date, $10, null, $11::jsonb)",
    [w.orgA, client, service, caregiver, days, start, end, from, to, onConflict, pattern === null ? null : JSON.stringify(pattern)]).then((r) => r[0]);
const ok = (rows: any[]) => rows.filter((r) => r.outcome === "ok").map((r) => r.local_date as string);
const setLimit = (a: Actor, caregiver: string | null, daily: number | null, weekly: number | null, mode: string) =>
  q(a, "select ogevia_api.set_hour_limit($1, $2, $3, $4, $5, 'Synthetic test limit')", [w.orgA, caregiver, daily, weekly, mode]);

describe("recurrence patterns", () => {
  it("every other Monday: dates alternate from the anchor week", async () => {
    const m = monthStart(2);
    const mondays = datesOf(m, monthEnd(m), [1]);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 420 });
    const rows = await preview(w.managerA, fresh.client, fresh.service, null, [1], "09:00", "11:00", m, monthEnd(m), { every_weeks: 2, anchor: mondays[0] });
    expect(ok(rows)).toEqual(mondays.filter((_, i) => i % 2 === 0));
    // the other phase (anchor one week later) is the complementary set: "different schedules for different weeks"
    const rowsB = await preview(w.managerA, fresh.client, fresh.service, null, [1], "09:00", "11:00", m, monthEnd(m), { every_weeks: 2, anchor: mondays[1] });
    expect(ok(rowsB)).toEqual(mondays.filter((_, i) => i % 2 === 1));
  });

  it('"every Saturday except the first Saturday" and "only the 2nd and 4th"', async () => {
    const m = monthStart(2);
    const saturdays = datesOf(m, monthEnd(m), [6]);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 420 });
    const except = await preview(w.managerA, fresh.client, fresh.service, null, [6], "09:00", "11:00", m, monthEnd(m), { except_nth: [1] });
    expect(ok(except)).toEqual(saturdays.filter((d) => Number(d.slice(8)) > 7));
    expect(ok(except)).not.toContain(saturdays[0]);
    const nth = await preview(w.managerA, fresh.client, fresh.service, null, [6], "09:00", "11:00", m, monthEnd(m), { nth: [2, 4] });
    expect(ok(nth)).toEqual(saturdays.filter((d) => [2, 4].includes(Math.ceil(Number(d.slice(8)) / 7))));
  });

  it("excluded dates (holidays) are left out and the pattern is stored, listed and audited", async () => {
    const m = monthStart(3);
    const wednesdays = datesOf(m, monthEnd(m), [3]);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 420 });
    const made = await create(w.managerA, fresh.client, fresh.service, null, [3], "09:00", "11:00", m, monthEnd(m), { exclude_dates: [wednesdays[1]] });
    expect(made.created).toBe(wednesdays.length - 1);
    const listed = (await q(w.managerA, "select * from ogevia_api.list_shift_series($1)", [w.orgA])).find((s) => s.series_id === made.series_id);
    expect(listed.pattern).toEqual({ exclude_dates: [wednesdays[1]] });
    const audit = await db.admin.query("select after_state from ogevia.audit_events where entity_id = $1 and action = 'shift_series.created'", [made.series_id]);
    expect(audit.rows[0].after_state.pattern).toEqual({ exclude_dates: [wednesdays[1]] });
  });

  it("a malformed pattern is refused", async () => {
    const m = monthStart(2);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 420 });
    for (const bad of [{ every_weeks: 9, anchor: m }, { every_weeks: 2 }, { surprise: 1 }, { nth: [0] }, { anchor: "2026-13-45" }, { exclude_dates: ["x"] }]) {
      await expectPgError(preview(w.managerA, fresh.client, fresh.service, null, [1], "09:00", "10:00", m, monthEnd(m), bad), "OGV22", /pattern/i);
    }
  });

  it("two caregivers for one client at overlapping times, and week A / week B, share one authorization with nothing counted twice", async () => {
    const m = monthStart(4);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 420 });
    const mondays = datesOf(m, monthEnd(m), [1]);
    const a = await create(w.managerA, fresh.client, fresh.service, rec["CG-A1"]!, [1, 3], "09:00", "11:00", m, monthEnd(m), { every_weeks: 2, anchor: mondays[0] });
    const b = await create(w.managerA, fresh.client, fresh.service, rec["CG-A2"]!, [2, 4], "09:00", "11:00", m, monthEnd(m), { every_weeks: 2, anchor: mondays[1] });
    // a second caregiver at the very same time as the first is allowed (two caregivers, one client)
    const c = await create(w.managerA, fresh.client, fresh.service, rec["CG-A3"]!, [1], "09:00", "11:00", m, monthEnd(m), { every_weeks: 2, anchor: mondays[0] });
    expect(a.created).toBeGreaterThan(0);
    expect(b.created).toBeGreaterThan(0);
    expect(c.created).toBe(mondays.filter((_, i) => i % 2 === 0).length);
    const reserved = Number((await db.admin.query(
      `select coalesce(sum(r.reserved_minutes),0) n from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
       where s.client_id = $1 and r.released_at is null`, [fresh.client])).rows[0].n);
    expect(reserved).toBe((a.created + b.created + c.created) * 120);
  });
});

describe("caregiver hour limits", () => {
  it("report mode warns but does not block; block mode refuses a single shift and flags series dates, counting the series' own earlier dates", async () => {
    const m = monthStart(5);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 600 });
    const weekdays = datesOf(m, monthEnd(m), [1, 2, 3, 4, 5]);
    const week = weekdays.slice(0, 5);
    await setLimit(w.managerA, rec["CG-A1"]!, 240, 360, "report");
    // report: everything is created
    const r = await preview(w.managerA, fresh.client, fresh.service, rec["CG-A1"]!, [1, 2, 3, 4, 5], "09:00", "11:00", week[0]!, week[4]!);
    expect(ok(r)).toEqual(week);
    await setLimit(w.managerA, rec["CG-A1"]!, 240, 360, "block");
    // block: weekly 360 min = 3 x 2 h; the fourth and fifth day of that week are over the limit
    const b = await preview(w.managerA, fresh.client, fresh.service, rec["CG-A1"]!, [1, 2, 3, 4, 5], "09:00", "11:00", week[0]!, week[4]!);
    expect(ok(b)).toEqual(week.slice(0, 3));
    expect(b.filter((x) => x.outcome === "over_hour_limit").map((x) => x.local_date)).toEqual(week.slice(3));
    // single shift: 5 h in one day is over the 4 h daily limit
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'08:00'::time,'13:00'::time,$5,null)",
      [w.orgA, fresh.client, fresh.service, week[0], rec["CG-A1"]]), "OGR30", /Daily limit exceeded: [\d.]+ of [\d.]+ h/);
    // a caregiver with no limit of their own follows the agency default
    await setLimit(w.managerA, null, 120, null, "block");
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'08:00'::time,'11:00'::time,$5,null)",
      [w.orgA, fresh.client, fresh.service, week[0], rec["CG-A3"]]), "OGR30", /Daily limit exceeded: [\d.]+ of [\d.]+ h/);
    await setLimit(w.managerA, null, null, null, "block"); // removes the default
    await setLimit(w.managerA, rec["CG-A1"]!, null, null, "block");
    expect(await q(w.managerA, "select * from ogevia_api.list_hour_limits($1)", [w.orgA])).toEqual([]);
  });

  it("load is listed per caregiver and week; limits need permission and a reason; tenant isolation holds", async () => {
    const m = monthStart(5);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 600 });
    const d = datesOf(m, monthEnd(m), [1])[1]!;
    await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'12:00'::time,$5,null)", [w.orgA, fresh.client, fresh.service, d, rec["CG-A2"]]);
    await setLimit(w.managerA, rec["CG-A2"]!, 120, null, "report");
    const load = await q(w.managerA, "select * from ogevia_api.list_caregiver_load($1,$2::date,$3::date)", [w.orgA, d, d]);
    expect(load.find((x) => x.caregiver_record_id === rec["CG-A2"])).toMatchObject({ scheduled_minutes: "180", busiest_day_minutes: "180", over_daily: true, over_weekly: false, mode: "report" });
    await setLimit(w.managerA, rec["CG-A2"]!, null, null, "report");
    await expectPgError(setLimit(w.caregiverA1, rec["CG-A2"]!, 60, null, "block"), "OGA03", /permission/i);
    await expectPgError(q(w.managerA, "select ogevia_api.set_hour_limit($1,$2,60,null,'block','')", [w.orgA, rec["CG-A2"]]), "OGV22", /reason/i);
    await expectPgError(q(w.managerB, "select ogevia_api.set_hour_limit($1,$2,60,null,'block','Synthetic')", [w.orgA, rec["CG-A2"]]), "OGN04", /not found/i);
    expect(await q(w.managerB, "select * from ogevia_api.list_caregiver_load($1,$2::date,$3::date)", [w.orgA, d, d])).toEqual([]);
  });
});

describe("make-up visits", () => {
  it("replace lost time in the same month, never more than owed, never counted twice", async () => {
    const m = monthStart(6);
    const fresh = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 700 });
    const [d1, d2] = datesOf(m, monthEnd(m), [2]) as [string, string];
    const original = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,$5,null)", [w.orgA, fresh.client, fresh.service, d1, rec["CG-A1"]]))[0];
    const reserved = async () => Number((await db.admin.query(
      "select coalesce(sum(r.reserved_minutes),0) n from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id where s.client_id = $1 and r.released_at is null", [fresh.client])).rows[0].n);
    expect(await reserved()).toBe(120);
    // a shift that is still on the schedule cannot be made up
    await expectPgError(q(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'09:00'::time,'10:00'::time,null,null)", [w.orgA, original.shift_id, d2]), "OGV22", /cancelled, called-out or short/);
    await q(w.managerA, "select * from ogevia_api.cancel_shift($1,$2,'Synthetic: client unwell',null)", [w.orgA, original.shift_id]);
    expect(await reserved()).toBe(0);
    // other month refused
    await expectPgError(q(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'09:00'::time,'10:00'::time,null,null)",
      [w.orgA, original.shift_id, datesOf(monthStart(7), monthEnd(monthStart(7)), [2])[0]]), "OGV22", /same calendar month/);
    // longer than owed (3 h > 2 h) refused
    await expectPgError(q(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'09:00'::time,'12:00'::time,null,null)", [w.orgA, original.shift_id, d2]), "OGC09", /longer than the time still owed/);
    // 1 h then another 1 h fit exactly; a third does not
    const first = (await q(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'09:00'::time,'10:00'::time,null,null)", [w.orgA, original.shift_id, d2]))[0];
    expect(first).toMatchObject({ reserved_minutes: 60, unmade_minutes_after: 60 });
    const second = (await q(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'13:00'::time,'14:00'::time,null,null)", [w.orgA, original.shift_id, d2]))[0];
    expect(second.unmade_minutes_after).toBe(0);
    await expectPgError(q(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'15:00'::time,'15:15'::time,null,null)", [w.orgA, original.shift_id, d2]), "OGC09", /longer than the time still owed/);
    expect(await reserved()).toBe(120); // exactly the original 2 h, once
    // a make-up cannot be made up; it is labelled in the schedule
    await expectPgError(q(w.managerA, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'16:00'::time,'16:30'::time,null,null)", [w.orgA, first.shift_id, d2]), "OGV22", /cannot itself be made up/);
    const listed = await q(w.managerA, "select shift_id, makeup_for_shift_id from ogevia_api.list_shifts($1,$2::date,$3::date,$4)", [w.orgA, d1, d2, fresh.client]);
    expect(listed.filter((s) => s.makeup_for_shift_id === original.shift_id)).toHaveLength(2);
    // tenant isolation
    await expectPgError(q(w.managerB, "select * from ogevia_api.schedule_makeup_shift($1,$2,$3::date,'09:00'::time,'10:00'::time,null,null)", [w.orgA, original.shift_id, d2]), "OGN04", /not found/i);
  });
});
