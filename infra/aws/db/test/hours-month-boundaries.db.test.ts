// Agency-local month boundaries, midnight, daylight-saving days and idempotent retries in the hours accounting (go-live readiness, 0082 audit). SYNTHETIC data only.
// Agency time zone America/Los_Angeles. Real transitions are found from today so the tests stay valid. A shift's minutes are REAL elapsed minutes (a fall-back day has 25
// hours); its reservation belongs to the agency-local date it STARTS on, so a shift that crosses midnight at month end is counted entirely in the month it starts in.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
const TZ = "America/Los_Angeles";
let lastDayOfMonth: string; // the next month end at least 3 days ahead
let firstOfNext: string;
let fallBack: string;
let springForward: string;
beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 600);
  const r = (await db.admin.query(
    `select to_char(e, 'YYYY-MM-DD') e, to_char(e + 1, 'YYYY-MM-DD') n from (
       select (date_trunc('month', d) + interval '1 month - 1 day')::date e from generate_series(current_date + 3, current_date + 70, interval '1 day') d
       order by 1 limit 1) x`)).rows[0];
  lastDayOfMonth = r.e; firstOfNext = r.n;
  const find = async (time: string, issue: string) => (await db.admin.query(
    `select min(d)::date::text d from generate_series(current_date + 3, current_date + 400, interval '1 day') d where ogevia.local_time_issue($1, d::date, $2::time) = $3`, [TZ, time, issue])).rows[0].d as string;
  fallBack = await find("01:30", "ambiguous");
  springForward = await find("02:30", "nonexistent");
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const realMinutes = async (date: string, start: string, end: string) =>
  Number((await db.admin.query(
    `select (extract(epoch from ((case when $3::time <= $2::time then $1::date + 1 else $1::date end + $3::time) at time zone $4) - (($1::date + $2::time) at time zone $4)) / 60)::int m`,
    [date, start, end, TZ])).rows[0].m);
const createShift = (client: string, service: string, date: string, start: string, end: string, key: string | null = randomUUID()) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,$7)", [w.orgA, client, service, date, start, end, key]).then((r) => r[0]);
const reservedIn = async (lineage: string, day: string) => Number((await db.admin.query("select ogevia.authorization_month_reserved($1, $2::date) n", [lineage, day])).rows[0].n);
const lineageOf = async (auth: string) => (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [auth])).rows[0].lineage_id as string;
const summaryFor = async (client: string, month: string) => (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, month, client]))[0];

describe("agency-local dates", () => {
  it("local date and month change at LOCAL midnight, also on the fall-back night and at month end (fixed instants)", async () => {
    const d = async (iso: string) => (await db.admin.query("select to_char(ogevia.organization_local_date($1, $2::timestamptz), 'YYYY-MM-DD') d", [w.orgA, iso])).rows[0].d as string;
    expect(await d("2026-11-01T06:30:00Z")).toBe("2026-10-31"); // 23:30 PDT on Oct 31
    expect(await d("2026-11-01T07:00:00Z")).toBe("2026-11-01"); // 00:00 PDT on Nov 1
    expect(await d("2026-11-01T08:30:00Z")).toBe("2026-11-01"); // 01:30 PDT (first 01:30 of the fall-back night)
    expect(await d("2026-11-01T09:30:00Z")).toBe("2026-11-01"); // 01:30 PST (second)
    expect(await d("2026-11-02T07:59:59Z")).toBe("2026-11-01"); // 23:59:59 PST on the 25-hour day
    expect(await d("2026-11-02T08:00:00Z")).toBe("2026-11-02");
    expect(await d("2026-12-01T07:59:59Z")).toBe("2026-11-30"); // last second of November
    expect(await d("2026-12-01T08:00:00Z")).toBe("2026-12-01");
    expect(await d("2027-03-14T09:59:59Z")).toBe("2027-03-14"); // 01:59:59 PST just before spring forward
    expect(await d("2027-03-14T10:00:00Z")).toBe("2027-03-14"); // 03:00 PDT
  });
});

describe("a shift that crosses midnight at the end of a month", () => {
  it("is counted entirely in the month it starts in, with its REAL minutes; the next month keeps its full capacity; the cap of the first month is exact", async () => {
    const minutes = await realMinutes(lastDayOfMonth, "22:00", "02:00");
    expect([240, 300, 180]).toContain(minutes); // 4 hours, or 5 / 3 when a clock change falls inside
    const c = await freshClient(db, w, w.caregiverA1, minutes, w.orgA, { before: 5, after: 400 }); // the cap is exactly this shift
    const lineage = await lineageOf(c.auth);
    const made = await createShift(c.client, c.service, lastDayOfMonth, "22:00", "02:00");
    expect(made.reserved_minutes).toBe(minutes);
    expect(await reservedIn(lineage, lastDayOfMonth)).toBe(minutes);
    expect(await reservedIn(lineage, firstOfNext)).toBe(0); // nothing leaks into the next month
    const res = (await db.admin.query("select to_char(service_date, 'YYYY-MM-DD') d, reserved_minutes from ogevia.authorization_reservations where shift_id = $1", [made.shift_id])).rows[0];
    expect(res).toEqual({ d: lastDayOfMonth, reserved_minutes: minutes });
    // the month's cap is used up: one more quarter hour in that month is refused; the same on the 1st of the next month is accepted
    await expectPgError(createShift(c.client, c.service, lastDayOfMonth, "10:00", "10:15"), "OGC09", /available|authorized|left/i);
    expect(await createShift(c.client, c.service, firstOfNext, "10:00", "10:15")).toMatchObject({ reserved_minutes: 15 });
    // the screens agree: month A is fully reserved, month B holds only the 15 minutes
    const a = await summaryFor(c.client, `${lastDayOfMonth.slice(0, 7)}-01`);
    expect(a).toMatchObject({ hours_reserved_minutes: minutes, hours_left_minutes: 0 });
    const b = await summaryFor(c.client, `${firstOfNext.slice(0, 7)}-01`);
    expect(b).toMatchObject({ hours_reserved_minutes: 15, hours_left_minutes: minutes - 15 });
  });

  it("an idempotent retry of the same request returns the same shift and writes ONE reservation (also across the boundary)", async () => {
    const c = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 5, after: 400 });
    const key = randomUUID();
    const first = await createShift(c.client, c.service, lastDayOfMonth, "22:00", "02:00", key);
    const again = await createShift(c.client, c.service, lastDayOfMonth, "22:00", "02:00", key);
    expect(again.shift_id).toBe(first.shift_id);
    expect(Number((await db.admin.query("select count(*) n from ogevia.authorization_reservations where shift_id = $1", [first.shift_id])).rows[0].n)).toBe(1);
    expect(Number((await db.admin.query("select count(*) n from ogevia.shifts where client_id = $1", [c.client])).rows[0].n)).toBe(1);
  });
});

describe("daylight-saving days: minutes are real elapsed minutes", () => {
  it("fall-back night: 00:00-06:00 is 7 hours (420), 23:00 the evening before to 03:00 is 5 hours (300); spring-forward: 00:00-04:00 is 3 hours (180)", async () => {
    const c = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 5, after: 400 });
    const fb = await createShift(c.client, c.service, fallBack, "00:00", "06:00");
    expect(fb.reserved_minutes).toBe(420);
    const cross = await createShift(c.client, c.service, addDays(fallBack, -1), "23:00", "03:00");
    expect(cross.reserved_minutes).toBe(300);
    expect(cross.reserved_minutes).toBe(await realMinutes(addDays(fallBack, -1), "23:00", "03:00"));
    const sf = await createShift(c.client, c.service, springForward, "00:00", "04:00");
    expect(sf.reserved_minutes).toBe(180);
    // each reservation is counted in the month of its start date and the guard reads the same figures
    const lineage = await lineageOf(c.auth);
    const total = Number((await db.admin.query("select coalesce(sum(r.reserved_minutes), 0) n from ogevia.authorization_reservations r where r.authorization_lineage_id = $1 and r.released_at is null and date_trunc('month', r.service_date) = date_trunc('month', $2::date)", [lineage, fallBack])).rows[0].n);
    expect(await reservedIn(lineage, fallBack)).toBe(total);
    // the unclear local times stay refused (0035)
    await expectPgError(createShift(c.client, c.service, fallBack, "01:30", "03:30"), "OGV22", /happens twice/);
    await expectPgError(createShift(c.client, c.service, springForward, "02:30", "04:00"), "OGV22", /does not exist/);
  });
});

it("reports expiring capacity once, includes day 30, excludes day 31, and restricts dollar estimates", async () => {
  const eligible = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 10, after: 30 });
  const outside = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 10, after: 31 });
  const current = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 10, after: 0 });
  const rows = (actor: Actor) => q(actor, "select * from ogevia_api.list_expiring_authorization_hours($1)", [w.orgA]);
  const fixture = await db.admin.connect();
  try {
    await fixture.query("set session_replication_role = replica");
    await fixture.query("update ogevia.client_authorizations set hourly_rate_cents = 3250 where id = $1", [eligible.auth]);
  } finally {
    await fixture.query("reset session_replication_role");
    fixture.release();
  }
  const owner = await rows(w.ownerA);
  expect(owner.filter((row) => row.client_id === eligible.client)).toEqual([
    expect.objectContaining({ days_left: 30, available_minutes: 600, estimated_cents: "32500" }),
  ]);
  expect(owner.find((row) => row.client_id === current.client)).toMatchObject({ days_left: 0, available_minutes: 600 });
  expect(owner.some((row) => row.client_id === outside.client)).toBe(false);
  expect((await rows(w.managerA)).find((row) => row.client_id === eligible.client)).toMatchObject({ available_minutes: 600, estimated_cents: null });
  expect(await rows(w.caregiverA1)).toEqual([]);
  expect(await rows(w.managerB)).toEqual([]);
});
