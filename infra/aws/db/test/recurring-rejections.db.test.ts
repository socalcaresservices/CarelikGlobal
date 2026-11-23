// 0061 Recurring shifts: valid occurrences are saved, EVERY rejected date is returned with its reason, authorization reservations are exact, and a
// retry cannot create the series twice (owner directive 2026-10-17, requirement 7). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
const q = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const admin = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (n: number) => { const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5));
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 100000);
  today = process.env.OGEVIA_TEST_TODAY ?? await orgToday(db); // OGEVIA_TEST_TODAY=YYYY-MM-DD only moves the month anchor, to prove the dates below do not depend on the calendar day the suite runs
  recA1 = (await admin("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string };
const create = (fx: Fx, o: { caregiver?: string | null; days?: number[]; start?: string; end?: string; from: string; to: string | null; mode?: string | null; key?: string | null; actor?: Actor; pattern?: unknown }) => {
  const params: unknown[] = [w.orgA, fx.client, fx.service, o.caregiver ?? null, o.days ?? ALL_DAYS, o.start ?? "09:00", o.end ?? "11:00", o.from, o.to];
  if (o.mode !== null) params.push(o.mode ?? "save_valid");
  params.push(o.key === undefined ? randomUUID() : o.key, o.pattern ? JSON.stringify(o.pattern) : null);
  const n = params.length;
  return q(o.actor ?? w.managerA,
    `select *, generated_through::text as generated_through from ogevia_api.create_shift_series(
       p_organization_id => $1, p_client_id => $2, p_service_id => $3, p_caregiver_record_id => $4, p_weekdays => $5::smallint[], p_start => $6::time, p_end => $7::time,
       p_starts_on => $8::date, p_ends_on => $9::date, ${o.mode === null ? "" : "p_on_conflict => $10,"} p_idempotency_key => $${n - 1}, p_pattern => $${n}::jsonb)`,
    params).then((r) => r[0]);
};
const counts = async (fx: Fx) => ({
  series: Number((await admin("select count(*) n from ogevia.shift_series where client_id = $1", [fx.client])).rows[0].n),
  shifts: Number((await admin("select count(*) n from ogevia.shifts where client_id = $1 and status <> 'cancelled'", [fx.client])).rows[0].n),
  reservations: Number((await admin("select count(*) n from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id where s.client_id = $1 and r.released_at is null", [fx.client])).rows[0].n),
  reserved: Number((await admin("select coalesce(sum(r.reserved_minutes),0) n from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id where s.client_id = $1 and r.released_at is null", [fx.client])).rows[0].n),
});

describe("save the valid dates and report every rejected date", () => {
  it("28 daily 2 h shifts against a 10 h month: 5 are saved, the other 23 are all returned with their reason (no 12-date cut-off)", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    const r = await create(fx, { from: m, to: addDays(m, 27) }); // mode defaults to save_valid when not sent
    expect(r).toMatchObject({ created: 5, skipped: 23 });
    expect(r.series_id).toBeTruthy();
    expect(r.rejected).toHaveLength(23);
    expect(r.rejected.every((x: any) => x.reason === "exceeds_authorization" && x.minutes === 120)).toBe(true);
    const dates = r.rejected.map((x: any) => x.localDate);
    expect(dates).toEqual([...dates].sort()); // ordered by date
    expect(new Set(dates).size).toBe(23);
    expect(dates[0]).toBe(addDays(m, 5)); // dates 0-4 were saved
    // reservations: one per saved shift, none for a rejected date, total exactly the authorization
    expect(await counts(fx)).toMatchObject({ series: 1, shifts: 5, reservations: 5, reserved: 600 });
    // the rejected dates are also on record
    const skipped = await admin("select count(*)::int n from ogevia.shift_series_skipped_dates where series_id = $1", [r.series_id]);
    expect(skipped.rows[0].n).toBe(23);
  });

  it("the default (no mode sent) is save-valid; 'skip_flagged' still means the same", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 240, w.orgA, { before: 40, after: 600 });
    const m = addDays(monthStart(2), 0);
    const a = await create(fx, { from: m, to: addDays(m, 5), mode: "skip_flagged" });
    expect(a).toMatchObject({ created: 2, skipped: 4 });
    const fx2 = await freshClient(db, w, w.caregiverA1, 240, w.orgA, { before: 40, after: 600 });
    const b = await create(fx2, { from: m, to: addDays(m, 5), mode: null });
    expect(b).toMatchObject({ created: 2, skipped: 4 });
  });

  it("when no date fits: the full list comes back, no series is created, nothing is reserved, and it is audited without an error", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 60, w.orgA, { before: 40, after: 600 }); // 1 h a month, shifts are 2 h
    const m = monthStart(2);
    const r = await create(fx, { from: m, to: addDays(m, 9) });
    expect(r.series_id).toBeNull();
    expect(r).toMatchObject({ created: 0, skipped: 10 });
    expect(r.rejected).toHaveLength(10);
    expect(await counts(fx)).toEqual({ series: 0, shifts: 0, reservations: 0, reserved: 0 });
    const audit = await admin("select count(*)::int n from ogevia.audit_events where action = 'shift_series.create_rejected' and entity_id = $1", [fx.client]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("refuse is all-or-nothing and names EVERY date (more than 12), then 'and N more' past 40", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 120, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    await expect(create(fx, { from: m, to: addDays(m, 19), mode: "refuse" })).rejects.toMatchObject({ code: "OGC09", message: expect.stringMatching(/19 dates|Some dates cannot be scheduled/) });
    let msg = "";
    try { await create(fx, { from: m, to: addDays(m, 19), mode: "refuse" }); } catch (e: any) { msg = e.message; }
    expect((msg.match(/exceeds authorization/g) ?? []).length).toBe(19); // every flagged date, not 12
    expect(await counts(fx)).toEqual({ series: 0, shifts: 0, reservations: 0, reserved: 0 });
    const big = await freshClient(db, w, w.caregiverA1, 120, w.orgA, { before: 40, after: 600 });
    try { await create(big, { from: m, to: addDays(m, 59), mode: "refuse" }); } catch (e: any) { msg = e.message; }
    expect(msg).toMatch(/and \d+ more/);
  });

  it("mixed reasons in one request: a caregiver conflict and an authorization limit are each reported on their own date", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 360, w.orgA, { before: 40, after: 600 }); // 3 shifts of 2 h
    const m = monthStart(2);
    const d = addDays(m, 1);
    await admin(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_record_id, starts_at, ends_at, status)
                 values ($1,$2,$3,$4, ($5::date + time '10:00') at time zone 'America/Los_Angeles', ($5::date + time '12:00') at time zone 'America/Los_Angeles', 'scheduled')`,
      [w.orgA, fx.client, fx.service, recA1, d]);
    const r = await create(fx, { caregiver: recA1, from: m, to: addDays(m, 6) });
    const byDate = Object.fromEntries(r.rejected.map((x: any) => [x.localDate, x.reason]));
    expect(byDate[d]).toBe("caregiver_conflict");
    expect(Object.values(byDate).filter((x) => x === "exceeds_authorization").length).toBeGreaterThanOrEqual(1);
    expect(r.created + r.skipped).toBe(7);
  });
});

describe("retries cannot create the series twice", () => {
  it("the same key replays the same answer, including the rejected list, and creates nothing new", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 240, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    const key = randomUUID();
    const a = await create(fx, { from: m, to: addDays(m, 5), key });
    const before = await counts(fx);
    const b = await create(fx, { from: m, to: addDays(m, 5), key });
    expect(b.series_id).toBe(a.series_id);
    expect(b.rejected).toEqual(a.rejected);
    expect(b).toMatchObject({ created: a.created, skipped: a.skipped });
    expect(await counts(fx)).toEqual(before);
  });
  it("two simultaneous requests with the same key create one series", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    const key = randomUUID();
    const res = await Promise.allSettled([create(fx, { from: m, to: addDays(m, 6), key }), create(fx, { from: m, to: addDays(m, 6), key, actor: w.ownerA })]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect((await counts(fx)).series).toBe(1);
    expect((await counts(fx)).shifts).toBe(7);
  });
  it("a retry under a NEW key (the first answer was lost) is refused as already saved: no second set of shifts or reservations", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    await create(fx, { from: m, to: addDays(m, 6) });
    const before = await counts(fx);
    await expectPgError(create(fx, { from: m, to: addDays(m, 6) }), "OGC09", /already saved/i);
    expect(await counts(fx)).toEqual(before);
  });
  it("the database itself refuses two live shifts that share a series and a start time", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    const r = await create(fx, { from: m, to: addDays(m, 0) });
    const s = (await admin("select * from ogevia.shifts where series_id = $1", [r.series_id])).rows[0];
    await expect(admin(
      `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status, series_id)
       values ($1,$2,$3,$4,$5,'scheduled',$6)`, [w.orgA, fx.client, fx.service, s.starts_at, s.ends_at, r.series_id])).rejects.toMatchObject({ code: "23505" });
  });
});

describe("extend and change return their rejected dates too", () => {
  it("extending a series reports what did not fit; changing it from a date does the same, and reservations stay exact", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 360, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    const r = await create(fx, { from: m, to: null, days: ALL_DAYS }); // open-ended
    expect(r.created).toBe(9); // 6 h a month = 3 shifts a month; the series is scheduled through the end of the second month after its first date (three months)
    expect(r.rejected.length).toBe(r.skipped);
    const ext = (await q(w.managerA, "select * from ogevia_api.extend_shift_series($1,$2,$3::date,'save_valid',$4)", [w.orgA, r.series_id, addDays(monthStart(6), -1), randomUUID()]))[0]; // through the LAST DAY of the next month (the fourth), whatever its length: 'm + 120 days' lands on the first of the fifth month when the fourth has 30 or fewer days
    expect(ext.created).toBe(3); // the next month holds three more
    expect(ext.rejected.length).toBe(ext.skipped);
    expect(ext.skipped).toBeGreaterThan(0);
    const ch = (await q(w.managerA, "select * from ogevia_api.change_shift_series_from($1,$2,$3::date,null,$4::smallint[],'09:00'::time,'11:00'::time,null,'save_valid','Synthetic change',$5)",
      [w.orgA, r.series_id, addDays(m, 1), ALL_DAYS, randomUUID()]))[0];
    expect(Array.isArray(ch.rejected)).toBe(true);
    expect(ch.rejected.length).toBe(ch.skipped);
    const c = await counts(fx);
    expect(c.reserved).toBe(c.reservations * 120);
    const perMonth = (await admin(`select date_trunc('month', r.service_date) m, sum(r.reserved_minutes)::int t from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
                                   where s.client_id = $1 and r.released_at is null group by 1`, [fx.client])).rows;
    expect(perMonth.length).toBeGreaterThan(0);
    for (const row of perMonth) expect(row.t).toBeLessThanOrEqual(360); // never more than the month's authorization
  });
});

describe("permissions and tenant isolation are unchanged", () => {
  it("a caregiver cannot create a series, and another agency's manager cannot see this agency's client", async () => {
    const fx = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 600 });
    const m = monthStart(2);
    await expectPgError(create(fx, { from: m, to: addDays(m, 3), actor: w.caregiverA1 }), "OGA03", /permission/i);
    await expectPgError(create(fx, { from: m, to: addDays(m, 3), actor: w.managerB }), "OGN04");
  });
});
