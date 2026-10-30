// 0035 Daylight-saving local times: a time that does not exist (spring
// forward) or happens twice (fall back) is refused or flagged, never resolved
// silently (owner direction 2026-10-05). Agency time zone America/Los_Angeles.
// The next real transitions are found from today + 9 days, so every test has at least a week of FUTURE lead before the transition (the weekly-series and
// 'change this date only' tests start 7 and 2 days before it, and a shift or series cannot start in the past). Starting at today + 2 made them fail whenever a
// transition fell within the following week (for example on 2026-10-30, with the fall-back on 2026-11-01).
// SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fallBack: string; // next Sunday whose 1:30 AM happens twice
let springForward: string; // next Sunday whose 2:30 AM does not exist
let rec: string;
const TZ = "America/Los_Angeles";
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  const find = async (time: string, issue: string) => (await db.admin.query(
    `select min(d)::date::text d from generate_series(current_date + 9, current_date + 400, interval '1 day') d
     where ogevia.local_time_issue($1, d::date, $2::time) = $3`, [TZ, time, issue])).rows[0].d as string;
  fallBack = await find("01:30", "ambiguous");
  springForward = await find("02:30", "nonexistent");
  rec = (await db.admin.query("select id from ogevia.caregiver_records where organization_id = $1 and caregiver_code = 'CG-A1'", [w.orgA])).rows[0].id;
});
afterAll(async () => db?.drop());

const createShift = (client: string, service: string, date: string, start: string, end: string, caregiver: string | null = null) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, $5::time, $6::time, $7, null)", [w.orgA, client, service, date, start, end, caregiver]).then((r) => r[0]);

describe("detecting local times", () => {
  it("knows which local times do not exist, happen twice, or are clear", async () => {
    expect(fallBack).toBeTruthy();
    expect(springForward).toBeTruthy();
    const r = (await db.admin.query(`select
      ogevia.local_time_issue($1, $2::date, '01:00') a, ogevia.local_time_issue($1, $2::date, '01:59') b, ogevia.local_time_issue($1, $2::date, '02:00') c,
      ogevia.local_time_issue($1, $2::date, '00:59') d, ogevia.local_time_issue($1, $3::date, '02:00') e, ogevia.local_time_issue($1, $3::date, '02:59') f,
      ogevia.local_time_issue($1, $3::date, '03:00') g, ogevia.local_time_issue($1, $3::date, '01:59') h,
      ogevia.local_times_issue($1, $4::date, '23:00', '01:30') i, ogevia.local_times_issue($1, $2::date, '09:00', '17:00') j`,
      [TZ, fallBack, springForward, addDays(fallBack, -1)])).rows[0];
    expect(r).toEqual({ a: "ambiguous", b: "ambiguous", c: null, d: null, e: "nonexistent", f: "nonexistent", g: null, h: null, i: "ambiguous", j: null });
  });
});

describe("one-time shifts and one-date changes", () => {
  it("refuses a start inside the repeated hour, naming the date, the time and the reason; nothing is saved", async () => {
    const c = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 400 });
    await expectPgError(createShift(c.client, c.service, fallBack, "01:30", "03:30"), "OGV22", /1:30 AM on \d\d\/\d\d\/\d{4} happens twice in America\/Los_Angeles/);
    expect(Number((await db.admin.query("select count(*) n from ogevia.shifts where client_id = $1", [c.client])).rows[0].n)).toBe(0);
  });

  it("refuses a time that does not exist, and an overnight end that lands in the repeated hour", async () => {
    const c = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 400 });
    await expectPgError(createShift(c.client, c.service, springForward, "02:30", "04:00"), "OGV22", /2:30 AM on \d\d\/\d\d\/\d{4} does not exist/);
    await expectPgError(createShift(c.client, c.service, addDays(fallBack, -1), "23:00", "01:30"), "OGV22", /1:30 AM on .* happens twice/);
    // Clear times on the same days are accepted, with their real length.
    expect(await createShift(c.client, c.service, springForward, "03:00", "05:00")).toMatchObject({ reserved_minutes: 120 });
    expect(await createShift(c.client, c.service, fallBack, "09:00", "11:00")).toMatchObject({ reserved_minutes: 120 });
    // 12:00 AM to 3:00 AM across the fall-back hour really lasts 4 hours; both ends are clear, so it is accepted as 4 h.
    expect(await createShift(c.client, c.service, fallBack, "00:00", "03:00")).toMatchObject({ reserved_minutes: 240 });
  });

  it("'Change this date only' refuses an unclear time and accepts a clear one", async () => {
    const c = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 400 });
    const s = await createShift(c.client, c.service, addDays(fallBack, -2), "09:00", "11:00");
    const move = (date: string, start: string, end: string) =>
      q(w.managerA, "select * from ogevia_api.reschedule_shift($1, $2, $3::date, $4::time, $5::time, 'Synthetic move', null)", [w.orgA, s.shift_id, date, start, end]).then((r) => r[0]);
    await expectPgError(move(fallBack, "01:15", "02:30"), "OGV22", /happens twice/);
    await expectPgError(move(springForward, "02:15", "03:30"), "OGV22", /does not exist/);
    const before = (await db.admin.query("select starts_at, ends_at from ogevia.shifts where id = $1", [s.shift_id])).rows[0];
    expect(before.ends_at.getTime() - before.starts_at.getTime()).toBe(120 * 60_000);
    expect(await move(fallBack, "02:00", "04:00")).toMatchObject({ reserved_minutes: 120 });
  });
});

describe("weekly series", () => {
  it("flags the repeated-hour Sunday; creation is refused unless the scheduler explicitly skips it; the skip is recorded", async () => {
    const c = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 400 });
    const from = addDays(fallBack, -7);
    const preview = await q(w.managerA, "select local_date::text d, outcome, minutes from ogevia_api.preview_shift_series($1, $2, $3, $4, '{0}'::smallint[], '01:00', '03:00', $5::date, $6::date)",
      [w.orgA, c.client, c.service, rec, from, addDays(fallBack, 7)]);
    expect(preview).toEqual([
      { d: from, outcome: "ok", minutes: 120 },
      { d: fallBack, outcome: "time_occurs_twice", minutes: expect.any(Number) },
      { d: addDays(fallBack, 7), outcome: "ok", minutes: 120 },
    ]);
    const create = (onConflict: string) => q(w.managerA, "select * from ogevia_api.create_shift_series($1, $2, $3, $4, '{0}'::smallint[], '01:00', '03:00', $5::date, $6::date, $7, null)",
      [w.orgA, c.client, c.service, rec, from, addDays(fallBack, 7), onConflict]).then((r) => r[0]);
    await expectPgError(create("refuse"), "OGC09", /time occurs twice/);
    expect(Number((await db.admin.query("select count(*) n from ogevia.shifts where client_id = $1", [c.client])).rows[0].n)).toBe(0);
    const made = await create("skip_flagged");
    expect(made).toMatchObject({ created: 2, skipped: 1 });
    const skipped = (await db.admin.query("select local_date::text d, reason from ogevia.shift_series_skipped_dates where series_id = $1", [made.series_id])).rows;
    expect(skipped).toEqual([{ d: fallBack, reason: "time_occurs_twice" }]);
    // Rollback 0035 refuses while such a skip is recorded (it would not fit the 0034 constraint).
    const c2 = await db.admin.connect();
    try {
      await c2.query("begin");
      await c2.query("set local role ogevia_owner");
      await expectPgError(c2.query(readFileSync(new URL("../rollback/0035_dst_local_times.down.sql", import.meta.url), "utf8")), "P0001", /ROLLBACK REFUSED: skipped series dates/);
    } finally {
      await c2.query("rollback");
      c2.release();
    }
  });

  it("flags the spring-forward Sunday when a time does not exist", async () => {
    const c = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 400 });
    const rows = await q(w.managerA, "select local_date::text d, outcome from ogevia_api.preview_shift_series($1, $2, $3, null, '{0}'::smallint[], '02:30', '04:00', $4::date, $4::date)",
      [w.orgA, c.client, c.service, springForward]);
    expect(rows).toEqual([{ d: springForward, outcome: "time_does_not_exist" }]);
  });
});
