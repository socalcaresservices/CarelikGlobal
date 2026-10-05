// 0034 Recurring shifts. Occurrences come from the real calendar (a fifth
// weekday counts); each month's authorization is enforced with the same rule
// as single shifts; nothing is shortened or dropped silently; "this
// occurrence" and "this and future" changes; concurrency. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const rec: Record<string, string> = {};
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 800);
  today = await orgToday(db);
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** First day of the month n months after today's month (UTC arithmetic on calendar dates). */
const monthStart = (n: number) => { const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
const monthEnd = (start: string) => { const d = new Date(`${start}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); };
/** Dates in [from, to] whose weekday (0 = Sunday) is in days, from the real calendar. */
const datesOf = (from: string, to: string, days: number[]) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) if (days.includes(d.getUTCDay())) out.push(iso(d));
  return out;
};
const preview = (a: Actor, client: string, service: string, caregiver: string | null, days: number[], start: string, end: string, from: string, to: string | null) =>
  q(a, "select *, local_date::text as local_date from ogevia_api.preview_shift_series($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, $8::date, $9::date)", [w.orgA, client, service, caregiver, days, start, end, from, to]);
const createSeries = (a: Actor, client: string, service: string, caregiver: string | null, days: number[], start: string, end: string, from: string, to: string | null, onConflict = "refuse", key: string | null = null) =>
  q(a, "select * from ogevia_api.create_shift_series($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, $8::date, $9::date, $10, $11)", [w.orgA, client, service, caregiver, days, start, end, from, to, onConflict, key]).then((r) => r[0]);
const reservedInMonth = async (client: string, month: string) => Number((await db.admin.query(
  `select coalesce(sum(r.reserved_minutes), 0) n from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
   where s.client_id = $1 and r.released_at is null and date_trunc('month', r.service_date) = $2::date`, [client, month])).rows[0].n);
const shiftsOf = async (series: string) => (await db.admin.query(
  "select id, status, caregiver_record_id, starts_at from ogevia.shifts where series_id = $1 order by starts_at", [series])).rows;

describe("occurrences from the real calendar", () => {
  it("counts every matching weekday, including a fifth Monday; Mon/Wed/Fri 2 h in a month = its real number of dates", async () => {
    const m = monthStart(1);
    const fresh = await freshClient(db, w, w.caregiverA1, 1800, w.orgA, { before: 40, after: 150 });
    const rows = await preview(w.managerA, fresh.client, fresh.service, null, [1, 3, 5], "09:00", "11:00", m, monthEnd(m));
    const expected = datesOf(m, monthEnd(m), [1, 3, 5]);
    expect(rows.map((r) => r.local_date)).toEqual(expected);
    expect(rows.every((r) => r.minutes === 120 && r.outcome === "ok")).toBe(true);
    // 13 or 14 occurrences = 26 h or 28 h of a 30 h month: never assumed to be "4 weeks" (24 h).
    expect(expected.length).toBeGreaterThanOrEqual(12);
    expect(rows.length * 120).toBe(expected.length * 120);
  });

  it("a month with five Mondays has five Monday occurrences", async () => {
    let m = monthStart(1);
    for (let i = 1; i < 14 && datesOf(m, monthEnd(m), [1]).length !== 5; i++) m = monthStart(i + 1);
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 420 });
    const rows = await preview(w.managerA, fresh.client, fresh.service, null, [1], "09:00", "10:00", m, monthEnd(m));
    expect(rows.filter((r) => r.outcome === "ok")).toHaveLength(5);
  });

  it("daylight saving (Los Angeles): durations come from real instants", async () => {
    // Spring forward, Sunday 03/14/2027: 1:00–4:00 AM is 2 real hours (2:00–3:00 does not exist).
    const spring = (await db.admin.query("select local_date::text d, minutes from ogevia.series_occurrences('America/Los_Angeles', '{0}', '01:00', '04:00', '2027-03-07', '2027-03-21')")).rows;
    expect(spring).toEqual([{ d: "2027-03-07", minutes: 180 }, { d: "2027-03-14", minutes: 120 }, { d: "2027-03-21", minutes: 180 }]);
    // Fall back, Sunday 11/01/2026: a start inside the repeated hour (1:00 AM) is read as standard time
    // (PostgreSQL's rule, same as single shifts in 0026), so 1:00–3:00 AM reserves 2 h, not 3.
    // Documented limitation: reservations only; worked time comes from the server clock.
    const fall = (await db.admin.query("select local_date::text d, minutes from ogevia.series_occurrences('America/Los_Angeles', '{0}', '01:00', '03:00', '2026-11-01', '2026-11-01')")).rows;
    expect(fall).toEqual([{ d: "2026-11-01", minutes: 120 }]);
  });
});

describe("monthly authorization limit (30 h = 1800 min)", () => {
  it("2 h Mon–Thu: the first 15 occurrences fit (30 h); the 16th and later are flagged with their dates; nothing is saved unless skipping is chosen", async () => {
    let m = monthStart(1);
    for (let i = 1; i < 14 && datesOf(m, monthEnd(m), [1, 2, 3, 4]).length < 16; i++) m = monthStart(i + 1);
    const dates = datesOf(m, monthEnd(m), [1, 2, 3, 4]);
    const fresh = await freshClient(db, w, w.caregiverA1, 1800, w.orgA, { before: 40, after: 420 });
    const rows = await preview(w.managerA, fresh.client, fresh.service, null, [1, 2, 3, 4], "09:00", "11:00", m, monthEnd(m));
    expect(rows.filter((r) => r.outcome === "ok").map((r) => r.local_date)).toEqual(dates.slice(0, 15));
    expect(rows.filter((r) => r.outcome === "exceeds_authorization").map((r) => r.local_date)).toEqual(dates.slice(15));
    expect(rows[15]).toMatchObject({ authorized_minutes: 1800, series_minutes_before: 1800, minutes: 120 });

    const [mm, dd, yyyy] = [dates[15]!.slice(5, 7), dates[15]!.slice(8, 10), dates[15]!.slice(0, 4)];
    await expectPgError(createSeries(w.managerA, fresh.client, fresh.service, null, [1, 2, 3, 4], "09:00", "11:00", m, monthEnd(m)),
      "OGC09", new RegExp(`${mm}/${dd}/${yyyy} \\(exceeds authorization\\).*Nothing was saved`));
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_series where client_id = $1", [fresh.client])).rows[0].n).toBe(0);
    expect(await reservedInMonth(fresh.client, m)).toBe(0);

    const made = await createSeries(w.managerA, fresh.client, fresh.service, null, [1, 2, 3, 4], "09:00", "11:00", m, monthEnd(m), "skip_flagged");
    expect(made).toMatchObject({ created: 15, skipped: dates.length - 15, reserved_minutes: 1800 });
    const skipped = (await db.admin.query("select local_date::text d, reason from ogevia.shift_series_skipped_dates where series_id = $1 order by 1", [made.series_id])).rows;
    expect(skipped).toEqual(dates.slice(15).map((d) => ({ d, reason: "exceeds_authorization" })));
    expect(await reservedInMonth(fresh.client, m)).toBe(1800);
    // The month is full: even a single 15-minute shift is refused (no overrun).
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, '13:00'::time, '13:15'::time, null, null)",
      [w.orgA, fresh.client, fresh.service, dates[0]]), "OGC09", /0 min available/);
  });

  it("dates outside every authorization are flagged, never created", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 20 });
    const from = iso(new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 864e5));
    const to = iso(new Date(Date.parse(`${today}T12:00:00Z`) + 40 * 864e5));
    const rows = await preview(w.managerA, fresh.client, fresh.service, null, [0, 1, 2, 3, 4, 5, 6], "09:00", "10:00", from, to);
    const end = (await db.admin.query("select period_end::text e from ogevia.client_authorizations where client_id = $1", [fresh.client])).rows[0].e;
    expect(rows.filter((r) => r.outcome === "no_authorization").every((r) => r.local_date > end)).toBe(true);
    expect(rows.some((r) => r.outcome === "no_authorization")).toBe(true);
  });

  it("caregiver conflicts are flagged per date", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 150 });
    const m = monthStart(2);
    const first = datesOf(m, monthEnd(m), [2])[0]!;
    await q(w.managerA, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, '09:30'::time, '10:30'::time, $5, null)", [w.orgA, fresh.client, fresh.service, first, rec["CG-A2"]]);
    const rows = await preview(w.managerA, fresh.client, fresh.service, rec["CG-A2"]!, [2], "09:00", "10:00", m, monthEnd(m));
    expect(rows.find((r) => r.local_date === first)?.outcome).toBe("caregiver_conflict");
    expect(rows.filter((r) => r.local_date !== first).every((r) => r.outcome === "ok")).toBe(true);
  });
});

describe("one occurrence vs this and future", () => {
  it("call-out and rescheduling change only that occurrence; 'this and future' moves the rest to a new caregiver without double counting", async () => {
    const m = monthStart(1);
    const fresh = await freshClient(db, w, w.caregiverA1, 960, w.orgA, { before: 40, after: 150 }); // 16 h
    const dates = datesOf(m, monthEnd(m), [1, 4]); // 8–10 occurrences of 1.5 h
    const made = await createSeries(w.managerA, fresh.client, fresh.service, rec["CG-A1"]!, [1, 4], "09:00", "10:30", m, monthEnd(m), "skip_flagged");
    const shifts = await shiftsOf(made.series_id);
    expect(shifts).toHaveLength(Math.min(dates.length, 10));
    const before = await reservedInMonth(fresh.client, m);

    // Call-out on occurrence 1 only.
    await q(w.managerA, "select ogevia_api.record_shift_callout($1, $2, 'Sick (synthetic)', null)", [w.orgA, shifts[0].id]);
    const list = await q(w.managerA, "select * from ogevia_api.list_shifts($1, $2::date, $3::date, $4)", [w.orgA, m, monthEnd(m), fresh.client]);
    expect(list.filter((s) => s.coverage_state === "needs_coverage").map((s) => s.shift_id)).toEqual([shifts[0].id]);
    expect(list.every((s) => s.series_id === made.series_id)).toBe(true);

    // Reschedule occurrence 2 to 13:00–14:00: its reservation moves (90 -> 60 min); no new row.
    const moved = (await q(w.managerA, "select * from ogevia_api.reschedule_shift($1, $2, $3::date, '13:00'::time, '14:00'::time, 'Client appointment (synthetic)', null)",
      [w.orgA, shifts[1].id, dates[1]]))[0];
    expect(moved.reserved_minutes).toBe(60);
    expect(await reservedInMonth(fresh.client, m)).toBe(before - 30);
    expect((await db.admin.query("select count(*)::int n from ogevia.authorization_reservations where shift_id = $1", [shifts[1].id])).rows[0].n).toBe(1);
    await expectPgError(q(w.managerA, "select * from ogevia_api.reschedule_shift($1, $2, $3::date, '13:00'::time, '14:00'::time, '', null)", [w.orgA, shifts[1].id, dates[1]]), "OGV22");

    // This and future from the 4th date: new caregiver; reserved total unchanged even though the month is nearly full.
    const fromDate = dates[3]!;
    const changed = (await q(w.managerA, "select * from ogevia_api.change_shift_series_from($1, $2, $3::date, $4, '{1,4}'::smallint[], '09:00'::time, '10:30'::time, $5::date, 'refuse', 'Caregiver change (synthetic)', null)",
      [w.orgA, made.series_id, fromDate, rec["CG-A3"], monthEnd(m)]))[0];
    expect(changed.cancelled).toBe(changed.created);
    expect(await reservedInMonth(fresh.client, m)).toBe(before - 30);
    const old = await shiftsOf(made.series_id);
    expect(old.filter((s) => s.status === "scheduled").length).toBe(3); // dates 1–3 kept (incl. the called-out and moved ones)
    expect((await shiftsOf(changed.series_id)).every((s) => s.caregiver_record_id === rec["CG-A3"])).toBe(true);
    expect((await db.admin.query("select ends_on::text e from ogevia.shift_series where id = $1", [made.series_id])).rows[0].e)
      .toBe(iso(new Date(Date.parse(`${fromDate}T12:00:00Z`) - 864e5)));

    // Ending the replacement from its start releases all of its reservations.
    const ended = (await q(w.managerA, "select * from ogevia_api.end_shift_series($1, $2, $3::date, 'Services paused (synthetic)', null)", [w.orgA, changed.series_id, fromDate]))[0];
    expect(ended.cancelled).toBe(changed.created);
    expect(await reservedInMonth(fresh.client, m)).toBe(before - 30 - ended.released_minutes);
  });
});

describe("permissions, idempotency and concurrency", () => {
  it("caregivers and other agencies are refused; a retried create returns the same series", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 150 });
    const m = monthStart(1);
    await expectPgError(createSeries(w.caregiverA1, fresh.client, fresh.service, null, [1], "09:00", "10:00", m, monthEnd(m)), "OGA03");
    await expectPgError(q(w.managerB, "select * from ogevia_api.create_shift_series($1, $2, $3, null, '{1}'::smallint[], '09:00'::time, '10:00'::time, $4::date, $5::date, 'refuse', null)",
      [w.orgA, fresh.client, fresh.service, m, monthEnd(m)]), "OGN04");
    const key = "11111111-2222-4333-8444-5555555555aa";
    const a = await createSeries(w.managerA, fresh.client, fresh.service, null, [1], "09:00", "10:00", m, monthEnd(m), "refuse", key);
    const b = await createSeries(w.managerA, fresh.client, fresh.service, null, [1], "09:00", "10:00", m, monthEnd(m), "refuse", key);
    expect(b.series_id).toBe(a.series_id);
    expect((await shiftsOf(a.series_id)).length).toBe(datesOf(m, monthEnd(m), [1]).length);
    await expectPgError(createSeries(w.managerA, fresh.client, fresh.service, null, [7], "09:00", "10:00", m, monthEnd(m)), "OGV22", /Weekdays/);
    await expectPgError(createSeries(w.managerA, fresh.client, fresh.service, null, [1], "09:00", "10:00", "2020-01-06", null), "OGV22", /past/);
  });

  it("two schedulers at once cannot both take the same month's last hours", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 150 }); // 10 h
    const m = monthStart(1);
    const days = datesOf(m, monthEnd(m), [2]).length >= 4 ? [2] : [3];
    // Each wants every Tuesday 2 h (8–10 h): both fit alone, not together.
    const results = await Promise.allSettled([
      createSeries(w.managerA, fresh.client, fresh.service, null, days, "09:00", "11:00", m, monthEnd(m)),
      createSeries(w.ownerA, fresh.client, fresh.service, null, days, "13:00", "15:00", m, monthEnd(m)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await reservedInMonth(fresh.client, m)).toBeLessThanOrEqual(600);
  });
});
