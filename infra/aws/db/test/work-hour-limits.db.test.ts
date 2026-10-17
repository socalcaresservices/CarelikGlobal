// 0060 Work-hour limits the agency fixes and nobody overrides (owner directive 2026-10-17, requirement 6). SYNTHETIC data only.
// SoCal Care Services: 8 hours a day, 40 hours a week, enforced on the server for every scheduling path, with no manager override.
// Scoped by agency slug: the test world's agency A is given the slug 'socal-care-services'; agency B is not, and must be unaffected.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let recA3: string;
let recB1: string;
let weekStart: string; // a Monday, 2-3 weeks ahead
const q = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const admin = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (n: number) => iso(new Date(Date.parse(`${weekStart}T12:00:00Z`) + n * 864e5)); // n days after the Monday
const shift = (a: Actor, org: string, fx: { client: string; service: string }, date: string, start: string, end: string, caregiver: string | null) =>
  q(a, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,$8)", [org, fx.client, fx.service, date, start, end, caregiver, randomUUID()]).then((r) => r[0]);
const recOf = async (a: Actor) => (await admin("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;
/** A shift written straight to the table (the API only creates same-day shifts), so a shift can cross midnight. The trigger still judges it. */
const direct = (fx: { client: string; service: string }, caregiver: string, date: string, start: string, end: string, endsNextDay = false) =>
  admin(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_record_id, starts_at, ends_at, status)
     values ($1,$2,$3,$4, ($5::date + $6::time) at time zone 'America/Los_Angeles', ($5::date + $8::integer + $7::time) at time zone 'America/Los_Angeles', 'scheduled')`,
    [w.orgA, fx.client, fx.service, caregiver, date, start, end, endsNextDay ? 1 : 0]);
/** A fresh client for a fresh caregiver-week so tests do not share hours. */
const world = async (caregiver: Actor = w.caregiverA1, org = w.orgA) => freshClient(db, w, caregiver, 100000, org, { before: 40, after: 600 });

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 100000);
  today = await orgToday(db);
  await admin("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]); // the policy follows the agency's slug
  recA1 = await recOf(w.caregiverA1); recA2 = await recOf(w.caregiverA2); recA3 = await recOf(w.caregiverA3); recB1 = await recOf(w.caregiverB1);
  const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 14);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  weekStart = iso(d);
});
afterAll(async () => db?.drop());

describe("the policy is data, scoped to the agency, and cannot be edited", () => {
  it("the agency with the slug has 8 h / 40 h at version 1; another agency has none", async () => {
    const a = (await q(w.managerA, "select * from ogevia_api.get_work_hour_policy($1)", [w.orgA]))[0];
    expect(a).toMatchObject({ applies: true, max_daily_minutes: 480, max_weekly_minutes: 2400, version: 1 });
    expect(a.basis).toMatch(/no manager override/);
    const b = (await q(w.managerB, "select * from ogevia_api.get_work_hour_policy($1)", [w.orgB]))[0];
    expect(b).toMatchObject({ applies: false, max_daily_minutes: null, max_weekly_minutes: null });
  });
  it("a non-member cannot read another agency's policy", async () => {
    expect(await q(w.managerB, "select * from ogevia_api.get_work_hour_policy($1)", [w.orgA])).toEqual([]);
  });
  it("the table is append-only: no update, no delete, even for a privileged role; nothing in the API writes it", async () => {
    await expect(admin("update ogevia.agency_work_hour_policies set max_daily_minutes = 960")).rejects.toThrow();
    await expect(admin("delete from ogevia.agency_work_hour_policies")).rejects.toThrow();
    const writers = (await admin(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('ogevia_api', 'ogevia') and p.prokind = 'f'
         and pg_get_functiondef(p.oid) ~* '(insert into|update|delete from)\\s+(ogevia\\.)?agency_work_hour_policies'`)).rows.map((r) => r.proname);
    expect(writers).toEqual([]); // no function anywhere writes it: a change is a reviewed migration
    await expect(asActor(db, w.managerA.sub, (c) => c.query("insert into ogevia.agency_work_hour_policies (organization_slug, version, max_daily_minutes, max_weekly_minutes, basis) values ('x-y', 1, 600, 3000, 'attempt by a manager')"))).rejects.toThrow(/permission denied/i);
  });
});

describe("the daily limit: exactly 8 hours passes, one minute over fails", () => {
  it("8 h in one shift passes; 7 h then 1 h passes; 7 h then 61 minutes is refused", async () => {
    const fx = await world();
    await shift(w.managerA, w.orgA, fx, day(0), "08:00", "16:00", recA1); // exactly 480
    const fx2 = await world(w.caregiverA2);
    await shift(w.managerA, w.orgA, fx2, day(0), "08:00", "15:00", recA2); // 420
    await shift(w.managerA, w.orgA, fx2, day(0), "16:00", "17:00", recA2); // +60 = 480: allowed
    const fx3 = await world(w.caregiverA3);
    await shift(w.managerA, w.orgA, fx3, day(0), "08:00", "15:00", recA3); // 420
    await expectPgError(shift(w.managerA, w.orgA, fx3, day(0), "16:00", "17:01", recA3), "OGR30", /daily hour limit/i); // 481
  });
  it("a single 8 h 01 min shift is refused", async () => {
    const fx = await world();
    await expectPgError(shift(w.managerA, w.orgA, fx, day(1), "08:00", "16:01", recA1), "OGR30", /daily hour limit/i);
  });
});

describe("the weekly limit: exactly 40 hours passes, one minute over fails", () => {
  it("five 8 h days pass; a further 1 minute in the same week is refused; the next Monday is a new week", async () => {
    const fx = await world(w.caregiverA2);
    for (let i = 0; i < 5; i++) await shift(w.managerA, w.orgA, fx, day(7 + i), "08:00", "16:00", recA2); // Mon-Fri = 2400
    await expectPgError(shift(w.managerA, w.orgA, fx, day(12), "08:00", "08:15", recA2), "OGR30", /weekly hour limit/i); // Saturday
    await shift(w.managerA, w.orgA, fx, day(14), "08:00", "16:00", recA2); // next Monday: a new week
  });
});

describe("no manager override", () => {
  it("looser or report-mode limits and removal change nothing for this agency; there is no override parameter", async () => {
    const fx = await world(w.caregiverA3);
    const set = (cg: string | null, d: number | null, wk: number | null, mode: string) => q(w.managerA, "select ogevia_api.set_hour_limit($1,$2,$3,$4,$5,'Synthetic attempt to loosen')", [w.orgA, cg, d, wk, mode]);
    await set(recA3, 1440, 10080, "report"); // the loosest a manager can write
    await set(null, 1440, 10080, "report");
    await expectPgError(shift(w.managerA, w.orgA, fx, day(21), "06:00", "15:01", recA3), "OGR30", /daily hour limit/i); // 9 h 01
    await set(recA3, null, null, "report"); // delete the per-caregiver row
    await set(null, null, null, "report");
    await expectPgError(shift(w.managerA, w.orgA, fx, day(21), "06:00", "15:01", recA3), "OGR30", /daily hour limit/i);
    // no function that creates or moves a shift takes an override of any kind
    const risky = (await admin(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ogevia_api' and p.proname in ('create_shift','reschedule_shift','assign_shift_caregiver','pickup_open_shift','create_shift_series','schedule_makeup_shift')
         and pg_get_function_arguments(p.oid) ~* '(override|force|ignore|acknowledge|bypass)'`)).rows;
    expect(risky).toEqual([]);
  });
  it("a stricter manager-set limit still applies on top of the policy", async () => {
    const fx = await world(w.caregiverA3);
    await q(w.managerA, "select ogevia_api.set_hour_limit($1,$2,240,null,'block','Synthetic stricter limit')", [w.orgA, recA3]);
    await expectPgError(shift(w.managerA, w.orgA, fx, day(28), "08:00", "13:00", recA3), "OGR30", /daily hour limit/i); // 5 h > 4 h
    await q(w.managerA, "select ogevia_api.set_hour_limit($1,$2,null,null,'block','Synthetic removal')", [w.orgA, recA3]);
    // a per-caregiver row with only a daily value does not drop the weekly limit
    await q(w.managerA, "select ogevia_api.set_hour_limit($1,$2,480,null,'block','Synthetic daily only')", [w.orgA, recA3]);
    for (let i = 0; i < 5; i++) await shift(w.managerA, w.orgA, fx, day(35 + i), "08:00", "16:00", recA3);
    await expectPgError(shift(w.managerA, w.orgA, fx, day(40), "08:00", "09:00", recA3), "OGR30", /weekly hour limit/i);
  });
});

describe("another agency is unaffected", () => {
  it("agency B can still schedule 9 hours in a day (the policy is SoCal's only)", async () => {
    const fx = await freshClient(db, w, w.caregiverB1, 100000, w.orgB, { before: 40, after: 600 });
    const r = await shift(w.managerB, w.orgB, fx, day(0), "06:00", "15:00", recB1);
    expect(r.shift_id).toBeTruthy();
  });
});

describe("hours are counted across midnight and the week boundary (shifts written directly: the API only creates same-day shifts)", () => {
  it("a 22:00-06:00 shift counts 2 h on its first day and 6 h on the next, so a next-day shift is judged against the real total", async () => {
    const fx = await world(w.caregiverA1);
    await direct(fx, recA1, day(49), "22:00", "06:00", true); // 8 h: 2 h on day 49, 6 h on day 50
    await shift(w.managerA, w.orgA, fx, day(50), "06:00", "08:00", recA1); // 6 + 2 = 8: allowed
    await expectPgError(shift(w.managerA, w.orgA, fx, day(50), "08:00", "08:15", recA1), "OGR30", /daily hour limit/i); // 8 h 15 on day 50
    await expect(direct(fx, recA1, day(50), "23:00", "03:00", true)).rejects.toMatchObject({ code: "OGR30" }); // 1 h on day 50 would make 9 h
  });
  it("a shift that crosses Sunday midnight counts its Monday part in the next week", async () => {
    const fx = await world(w.caregiverA2);
    for (let i = 0; i < 5; i++) await shift(w.managerA, w.orgA, fx, day(56 + i), "08:00", "16:00", recA2); // Mon-Fri = 2400, the week is full
    await expect(direct(fx, recA2, day(62), "20:00", "04:00", true)).rejects.toMatchObject({ code: "OGR30", message: /weekly hour limit/i }); // 4 h of it falls in this week
    const fx3 = await world(w.caregiverA3);
    for (let i = 0; i < 4; i++) await shift(w.managerA, w.orgA, fx3, day(63 + i), "08:00", "16:00", recA3); // Mon-Thu = 1920
    await direct(fx3, recA3, day(69), "20:00", "04:00", true); // Sun 20:00 - Mon 04:00: 4 h here (2160), 4 h next week
    await expectPgError(shift(w.managerA, w.orgA, fx3, day(70), "08:00", "13:00", recA3), "OGR30", /daily hour limit/i); // Monday already holds 4 h of the spill: 9 h
    await shift(w.managerA, w.orgA, fx3, day(70), "08:00", "12:00", recA3); // 4 + 4 = 8 h on Monday
  });
});

describe("rescheduling does not count the shift's own old time", () => {
  it("moving an 8 h shift by an hour passes; stretching it to 9 h is refused", async () => {
    const fx = await world(w.caregiverA1);
    const s = await shift(w.managerA, w.orgA, fx, day(77), "08:00", "16:00", recA1);
    const move = (date: string, a: string, b: string) => q(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,$4::time,$5::time,'Synthetic move',$6)", [w.orgA, s.shift_id, date, a, b, randomUUID()]);
    await move(day(77), "09:00", "17:00");
    await expectPgError(move(day(77), "09:00", "18:00"), "OGR30", /daily hour limit/i);
  });
});

describe("recurring series: dates over the limit are rejected with their reason, the rest can be saved", () => {
  const preview = (fx: { client: string; service: string }, cg: string, days: number[], start: string, end: string, from: string, to: string) =>
    q(w.managerA, "select *, local_date::text as local_date from ogevia_api.preview_shift_series($1,$2,$3,$4,$5::smallint[],$6::time,$7::time,$8::date,$9::date,null)", [w.orgA, fx.client, fx.service, cg, days, start, end, from, to]);
  it("seven 8 h days in one week: the first five are ok, the last two are over the weekly limit", async () => {
    const fx = await world(w.caregiverA2);
    const rows = await preview(fx, recA2, [1, 2, 3, 4, 5, 6, 0], "08:00", "16:00", day(84), day(90));
    expect(rows.filter((r) => r.outcome === "ok")).toHaveLength(5);
    expect(rows.filter((r) => r.outcome === "over_hour_limit").map((r) => r.local_date)).toEqual([day(89), day(90)]);
    const made = (await q(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,$5::smallint[],$6::time,$7::time,$8::date,$9::date,'skip_flagged',$10,null)",
      [w.orgA, fx.client, fx.service, recA2, [1, 2, 3, 4, 5, 6, 0], "08:00", "16:00", day(84), day(90), randomUUID()]))[0];
    expect(made).toMatchObject({ created: 5, skipped: 2 });
  });
  it("a 9 h series is rejected on every date", async () => {
    const fx = await world(w.caregiverA3);
    const rows = await preview(fx, recA3, [1, 2, 3], "06:00", "15:00", day(98), day(104));
    expect(rows.every((r) => r.outcome === "over_hour_limit")).toBe(true);
  });
});

describe("assigning an open shift or a replacement is held to the limit too", () => {
  it("assign_shift_caregiver refuses a caregiver already at 8 h that day", async () => {
    const fx = await world(w.caregiverA1);
    await shift(w.managerA, w.orgA, fx, day(105), "08:00", "16:00", recA1);
    const open = await shift(w.managerA, w.orgA, fx, day(105), "17:00", "18:00", null);
    await expectPgError(q(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic fill',$4)", [w.orgA, open.shift_id, recA1, randomUUID()]), "OGR30", /daily hour limit/i);
    const s = (await admin("select caregiver_record_id from ogevia.shifts where id = $1", [open.shift_id])).rows[0];
    expect(s.caregiver_record_id).toBeNull();
  });
});

describe("API bypass: writing the shift another way is refused by the database", () => {
  it("a direct insert, a direct time change and a direct caregiver change are all refused under the caregiver lock", async () => {
    const fx = await world(w.caregiverA2);
    const s = await shift(w.managerA, w.orgA, fx, day(112), "08:00", "16:00", recA2);
    await expect(admin(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4, ($5::date + time '17:00') at time zone 'America/Los_Angeles', ($5::date + time '19:00') at time zone 'America/Los_Angeles', 'scheduled')`,
      [w.orgA, fx.client, fx.service, recA2, day(112)])).rejects.toMatchObject({ code: "OGR30" });
    await expect(admin("update ogevia.shifts set ends_at = ends_at + interval '2 hours' where id = $1", [s.shift_id])).rejects.toMatchObject({ code: "OGR30" });
    const open = await shift(w.managerA, w.orgA, fx, day(112), "20:00", "21:00", null);
    await expect(admin("update ogevia.shifts set caregiver_record_id = $2 where id = $1", [open.shift_id, recA2])).rejects.toMatchObject({ code: "OGR30" });
    // an unrelated update of an existing shift is not blocked
    await admin("update ogevia.shifts set updated_at = now() where id = $1", [s.shift_id]);
  });
  it("the application role cannot write shifts directly at all", async () => {
    const fx = await world(w.caregiverA2);
    await expect(asActor(db, w.managerA.sub, (c) => c.query("update ogevia.shifts set ends_at = ends_at + interval '1 hour' where organization_id = $1", [w.orgA]))).rejects.toThrow(/permission denied/i);
    void fx;
  });
});

describe("concurrent scheduling cannot take the same hours twice", () => {
  it("four simultaneous 3 h requests for one caregiver-day: exactly two succeed (6 h), the others are refused", async () => {
    const fx = await world(w.caregiverA3);
    const starts = [["06:00", "09:00"], ["10:00", "13:00"], ["14:00", "17:00"], ["18:00", "21:00"]];
    const res = await Promise.allSettled(starts.map(([a, b], i) => shift(i % 2 ? w.managerA : w.ownerA, w.orgA, fx, day(119), a!, b!, recA3)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of res.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "OGR30" });
    const total = (await admin("select coalesce(sum(extract(epoch from ends_at - starts_at))/60,0) m from ogevia.shifts where caregiver_record_id = $1 and starts_at::date between $2::date - 1 and $2::date + 1", [recA3, day(119)])).rows[0].m;
    expect(Number(total)).toBeLessThanOrEqual(480);
  });
  it("concurrent weekly attempts: 5 days of 8 h plus two more simultaneous 8 h days: at most 40 h in the week", async () => {
    const fx = await world(w.caregiverA1);
    const res = await Promise.allSettled([0, 1, 2, 3, 4, 5, 6].map((i) => shift(i % 2 ? w.managerA : w.ownerA, w.orgA, fx, day(126 + i), "08:00", "16:00", recA1)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const total = (await admin("select coalesce(sum(extract(epoch from ends_at - starts_at))/60,0) m from ogevia.shifts where caregiver_record_id = $1 and starts_at::date between $2::date and $2::date + 6", [recA1, day(126)])).rows[0].m;
    expect(Number(total)).toBe(2400);
  });
});
