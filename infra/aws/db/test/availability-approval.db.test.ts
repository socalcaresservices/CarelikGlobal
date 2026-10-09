// 0039 Availability requests and administrator approval. SYNTHETIC data only.
// Dates are computed from the agency-local "today" so the suite gives the same answer whenever it runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const LA = "America/Los_Angeles";

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
});
afterAll(async () => db?.drop());

const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const dowOf = async (d: string) => (await db.admin.query<{ n: number }>("select extract(dow from $1::date)::int n", [d])).rows[0]!.n;
const recordOf = async (a: Actor) =>
  (await db.admin.query<{ id: string }>("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0]!.id;

/** Baseline hours the caregiver entered before this release (layer 0), written as the old direct edit did. */
async function seedLegacy(a: Actor, weekly: { weekday: number; start: string; end: string }[], unavailable: string[] = []) {
  const id = await recordOf(a);
  await db.admin.query("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [id]);
  await db.admin.query("delete from ogevia.caregiver_unavailable_dates where caregiver_record_id = $1", [id]);
  await db.admin.query("delete from ogevia.availability_requests where caregiver_record_id = $1", [id]);
  await db.admin.query("delete from ogevia.caregiver_availability_state where caregiver_record_id = $1", [id]);
  for (const x of weekly) {
    await db.admin.query(
      "insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,$4,$5)",
      [w.orgA, id, x.weekday, x.start, x.end],
    );
  }
  for (const d of unavailable) {
    await db.admin.query("insert into ogevia.caregiver_unavailable_dates(organization_id, caregiver_record_id, unavailable_date) values ($1,$2,$3)", [w.orgA, id, d]);
  }
  return id;
}

/** Availability status for an agency-local interval. */
async function status(rec: string, d1: string, t1: string, d2: string, t2: string) {
  const r = await db.admin.query<{ s: string }>(
    "select ogevia.availability_status($1, $2, ($3 || ' ' || $4)::timestamp at time zone $7, ($5 || ' ' || $6)::timestamp at time zone $7) s",
    [w.orgA, rec, d1, t1, d2, t2, LA],
  );
  return r.rows[0]!.s;
}

const request = (a: Actor, kind: "weekly" | "date", windows: unknown[], from: string, until: string | null, reason = "School schedule changed", base = 0, key: string | null = null) =>
  asActor(db, a.sub, async (c) =>
    (await c.query<{ id: string }>("select ogevia_api.request_availability_change($1,$2,$3::jsonb,$4::date,$5::date,$6,$7,$8) as id", [w.orgA, kind, JSON.stringify(windows), from, until, reason, base, key])).rows[0]!.id,
  );
const review = (a: Actor, id: string, decision: "approve" | "decline", note: string | null = null) =>
  asActor(db, a.sub, async (c) => (await c.query<{ r: Record<string, unknown> }>("select ogevia_api.review_availability_request($1,$2,$3,$4) as r", [w.orgA, id, decision, note])).rows[0]!.r);
const get = (a: Actor, rec: string | null = null) =>
  asActor(db, a.sub, async (c) => (await c.query<{ r: any }>("select ogevia_api.get_availability($1,$2) as r", [w.orgA, rec])).rows[0]!.r);

const mon = (start: string, end: string) => ({ weekday: 1, start_local: start, end_local: end });

describe("requests never change approved availability", () => {
  it("a pending request leaves approved hours untouched and is shown separately; the caregiver can see its status", async () => {
    const rec = await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const from = await add(7);
    const id = await request(w.caregiverA1, "weekly", [mon("10:00", "12:00")], from, null);
    const state = await get(w.caregiverA1);
    expect(state.weekly).toEqual([{ weekday: 1, start_local: "08:00", end_local: "20:00" }]);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({ requestId: id, status: "pending", kind: "weekly" });
    expect(state.version).toBe(0);
    expect(state.timezone).toBe(LA);
    const monday = await add((8 - (await dowOf(today))) % 7 + 7);
    expect(await status(rec, monday, "08:00", monday, "09:00")).toBe("covered");
  });

  it("requires a reason, a start date that is not in the past, and an end date for a temporary change", async () => {
    await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const from = await add(7);
    await expectPgError(request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], from, null, "  "), "OGV22", /reason/i);
    await expectPgError(request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], await add(-1), null), "OGV22", /past/i);
    await expectPgError(request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], from, await add(3)), "OGV22", /end date/i);
    await expectPgError(request(w.caregiverA1, "weekly", [], from, null), "OGV22", /at least one/i);
    await expectPgError(request(w.caregiverA1, "weekly", [mon("09:00", "09:00")], from, null), "OGV22", /same time/i);
    await expectPgError(request(w.caregiverA1, "weekly", [mon("09:00", "12:00"), mon("11:00", "14:00")], from, null), "OGV22", /overlap/i);
    await expectPgError(request(w.caregiverA1, "date", [{ weekday: 2, start_local: "09:00", end_local: "10:00" }], from, null), "OGV22", /times only/i);
    const temp = await request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], from, await add(30));
    const row = (await db.admin.query("select is_temporary, effective_until::text u from ogevia.availability_requests where id = $1", [temp])).rows[0];
    expect(row.is_temporary).toBe(true);
  });

  it("refuses a stale form and a second pending request for the same hours; an idempotent retry returns the same request", async () => {
    await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const from = await add(7);
    const key = "11111111-1111-4111-8111-111111111111";
    const id = await request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], from, null, "Reason one", 0, key);
    expect(await request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], from, null, "Reason one", 0, key)).toBe(id);
    await expectPgError(request(w.caregiverA1, "weekly", [mon("10:00", "16:00")], from, null, "Reason two", 0), "OGC09", /already have a pending/i);
    await review(w.ownerA, id, "approve");
    await expectPgError(request(w.caregiverA1, "weekly", [mon("10:00", "16:00")], from, null, "Reason two", 0), "OGC09", /changed since/i);
    await request(w.caregiverA1, "weekly", [mon("10:00", "16:00")], from, null, "Reason two", 1);
  });
});

describe("who may approve", () => {
  it("only an administrator approves or declines; managers, schedulers, the requester and other agencies cannot", async () => {
    await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const id = await request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], await add(7), null);
    await expectPgError(review(w.caregiverA1, id, "approve"), "OGA03");
    await expectPgError(review(w.managerA, id, "approve"), "OGA03");
    await expectPgError(review(w.schedulerA, id, "approve"), "OGA03");
    await expectPgError(review(w.managerB, id, "approve"), "OGN04");
    await expectPgError(review(w.outsider, id, "approve"), "OGN04");
    // Managers may read, caregivers of another agency may not; one caregiver cannot read another's record.
    const list = await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.list_availability_requests($1,'pending')", [w.orgA])).rows);
    expect(list.length).toBeGreaterThan(0);
    await expectPgError(asActor(db, w.managerB.sub, (c) => c.query("select * from ogevia_api.list_availability_requests($1,'pending')", [w.orgA])), "OGN04");
    await expectPgError(asActor(db, w.caregiverA2.sub, (c) => c.query("select * from ogevia_api.list_availability_requests($1,'pending')", [w.orgA])), "OGA03");
    await expectPgError(get(w.caregiverA2, await recordOf(w.caregiverA1)), "OGA03");
    await expectPgError(asActor(db, w.caregiverB1.sub, (c) => c.query("select ogevia_api.get_availability($1, $2)", [w.orgA, null])), "OGN04");
    const still = (await db.admin.query("select status::text s from ogevia.availability_requests where id = $1", [id])).rows[0];
    expect(still.s).toBe("pending");
  });

  it("declining needs a note; a decided request cannot be decided again; two admins deciding at once get one winner", async () => {
    await seedLegacy(w.caregiverA2, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const from = await add(7);
    const a = await request(w.caregiverA2, "weekly", [mon("09:00", "17:00")], from, null);
    await expectPgError(review(w.ownerA, a, "decline", " "), "OGV22", /note/i);
    await review(w.ownerA, a, "decline", "Hours do not fit the client schedule");
    await expectPgError(review(w.ownerA, a, "approve"), "OGC09", /already declined/i);
    const decl = (await db.admin.query("select status::text s, review_note n, reviewed_by from ogevia.availability_requests where id = $1", [a])).rows[0];
    expect(decl).toMatchObject({ s: "declined", n: "Hours do not fit the client schedule", reviewed_by: w.ownerA.userId });

    const b = await request(w.caregiverA2, "weekly", [mon("09:00", "17:00")], from, null, "Second try", 0);
    const results = await Promise.allSettled([review(w.ownerA, b, "approve"), review(w.ownerA, b, "approve"), review(w.ownerA, b, "decline", "Changed my mind")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) expect((r.reason as { code: string }).code).toBe("OGC09");
    const versions = (await db.admin.query("select version from ogevia.caregiver_availability_state where caregiver_record_id = $1", [await recordOf(w.caregiverA2)])).rows[0];
    expect(versions.version).toBeLessThanOrEqual(1);
  });

  it("withdraw: only the requester, only while pending", async () => {
    await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const id = await request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], await add(7), null);
    await expectPgError(asActor(db, w.caregiverA2.sub, (c) => c.query("select ogevia_api.withdraw_availability_request($1,$2)", [w.orgA, id])), "OGN04");
    await asActor(db, w.caregiverA1.sub, (c) => c.query("select ogevia_api.withdraw_availability_request($1,$2)", [w.orgA, id]));
    await expectPgError(asActor(db, w.caregiverA1.sub, (c) => c.query("select ogevia_api.withdraw_availability_request($1,$2)", [w.orgA, id])), "OGC09", /already withdrawn/i);
    await expectPgError(review(w.ownerA, id, "approve"), "OGC09", /already withdrawn/i);
  });
});

describe("approved hours are layered, never overwritten", () => {
  it("a permanent weekly change applies from its start date; earlier dates keep the old hours; history is kept", async () => {
    const rec = await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const monday1 = await add(((8 - (await dowOf(today))) % 7) + 7); // first Monday at least 7 days out
    const monday2 = await add(((8 - (await dowOf(today))) % 7) + 14);
    const id = await request(w.caregiverA1, "weekly", [mon("10:00", "12:00")], monday2, null);
    const res = await review(w.ownerA, id, "approve", "OK");
    expect(res).toMatchObject({ status: "approved", approvedVersion: 1 });
    expect(await status(rec, monday1, "08:00", monday1, "09:00")).toBe("covered");
    expect(await status(rec, monday2, "08:00", monday2, "09:00")).toBe("outside");
    expect(await status(rec, monday2, "10:00", monday2, "12:00")).toBe("covered");
    const legacyRows = (await db.admin.query("select count(*)::int n from ogevia.caregiver_availability_windows where caregiver_record_id = $1 and request_id is null", [rec])).rows[0];
    expect(legacyRows.n).toBe(1);
    const rows = (await db.admin.query("select requested_by, reviewed_by, status::text s, approved_version, reviewed_at is not null r from ogevia.availability_requests where id = $1", [id])).rows[0];
    expect(rows).toMatchObject({ requested_by: w.caregiverA1.userId, reviewed_by: w.ownerA.userId, s: "approved", approved_version: 1, r: true });
    const audit = (await db.admin.query("select action from ogevia.audit_events where entity_id = $1 order by id", [id])).rows.map((x) => x.action);
    expect(audit).toEqual(["availability.requested", "availability.approved"]);
  });

  it("a temporary change ends on its end date and the earlier hours resume", async () => {
    const rec = await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const m1 = await add(((8 - (await dowOf(today))) % 7) + 7);
    const m2 = await add(((8 - (await dowOf(today))) % 7) + 14);
    const m3 = await add(((8 - (await dowOf(today))) % 7) + 21);
    const id = await request(w.caregiverA1, "weekly", [mon("13:00", "15:00")], m1, await add(((8 - (await dowOf(today))) % 7) + 16));
    await review(w.ownerA, id, "approve");
    expect(await status(rec, m2, "13:00", m2, "15:00")).toBe("covered");
    expect(await status(rec, m2, "08:00", m2, "09:00")).toBe("outside");
    expect(await status(rec, m3, "08:00", m3, "09:00")).toBe("covered");
  });

  it("a specific-date override REPLACES that day's hours (it does not widen them), and 'unavailable' removes the day", async () => {
    const rec = await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const m1 = await add(((8 - (await dowOf(today))) % 7) + 7);
    const m2 = await add(((8 - (await dowOf(today))) % 7) + 14);
    const over = await request(w.caregiverA1, "date", [{ start_local: "10:00", end_local: "12:00" }], m1, null);
    await review(w.ownerA, over, "approve");
    expect(await status(rec, m1, "10:00", m1, "12:00")).toBe("covered");
    expect(await status(rec, m1, "08:00", m1, "09:00")).toBe("outside"); // not a union with the weekly 08:00-20:00
    expect(await status(rec, m1, "15:00", m1, "16:00")).toBe("outside");
    const off = await request(w.caregiverA1, "date", [], m2, null, "Out of town", 1);
    await review(w.ownerA, off, "approve");
    expect(await status(rec, m2, "09:00", m2, "10:00")).toBe("outside");
    // A later approved override for the same date wins over the earlier one.
    const again = await request(w.caregiverA1, "date", [{ start_local: "06:00", end_local: "22:00" }], m2, null, "Back in town", 2);
    await review(w.ownerA, again, "approve");
    expect(await status(rec, m2, "09:00", m2, "10:00")).toBe("covered");
    const day = await get(w.caregiverA1);
    expect(day.exceptions.map((e: any) => e.date)).toEqual([m1, m2]);
  });

  it("exceptions survive a later weekly change (the direct-replace deletion defect)", async () => {
    const rec = await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const m1 = await add(((8 - (await dowOf(today))) % 7) + 7);
    const off = await request(w.caregiverA1, "date", [], m1, null, "Appointment");
    await review(w.ownerA, off, "approve");
    const weekly = await request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], m1, null, "New schedule", 1);
    await review(w.ownerA, weekly, "approve");
    expect(await status(rec, m1, "10:00", m1, "11:00")).toBe("outside");
    expect((await get(w.caregiverA1)).exceptions).toHaveLength(1);
    // The old direct-replace entry point is withdrawn: it can no longer wipe saved exceptions.
    await expectPgError(asActor(db, w.caregiverA1.sub, (c) => c.query("select ogevia_api.replace_my_availability($1,'[]'::jsonb,'[]'::jsonb)", [w.orgA])), "OGV22", /administrator approval/i);
    expect((await get(w.caregiverA1)).exceptions).toHaveLength(1);
  });

  it("'Not provided' is distinct from 'outside approved hours', and neither counts as available", async () => {
    const rec = await seedLegacy(w.caregiverA3, []);
    const m = await add(7);
    expect(await status(rec, m, "09:00", m, "10:00")).toBe("not_provided");
    expect((await get(w.caregiverA3)).provided).toBe(false);
    const rec1 = await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "09:00" }]);
    expect(await status(rec1, m, "23:00", m, "23:30")).toBe("outside");
  });

  it("overnight windows and the spring-forward / fall-back days are measured in agency time", async () => {
    // 2027-03-14 (spring forward) is a Sunday; 2026-11-01 (fall back) is a Sunday.
    const rec = await seedLegacy(w.caregiverA1, [{ weekday: 6, start: "22:00", end: "06:00" }, { weekday: 0, start: "00:00", end: "23:59" }]);
    expect(await status(rec, "2027-03-13", "22:00", "2027-03-14", "05:00")).toBe("covered");
    expect(await status(rec, "2027-03-13", "22:00", "2027-03-14", "06:30")).toBe("covered"); // Sunday window continues
    expect(await status(rec, "2026-10-31", "23:00", "2026-11-01", "05:00")).toBe("covered");
    const rec2 = await seedLegacy(w.caregiverA2, [{ weekday: 6, start: "22:00", end: "06:00" }]);
    expect(await status(rec2, "2026-10-31", "22:00", "2026-11-01", "06:00")).toBe("covered"); // 9 elapsed hours that night
    expect(await status(rec2, "2026-10-31", "22:00", "2026-11-01", "06:01")).toBe("outside");
  });
});

describe("administrator direct edit", () => {
  it("needs the administrator permission and a reason, is audited, and replaces a pending request", async () => {
    const rec = await seedLegacy(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const from = await add(7);
    const pending = await request(w.caregiverA1, "weekly", [mon("09:00", "17:00")], from, null);
    const direct = (a: Actor, reason: string) =>
      asActor(db, a.sub, async (c) => (await c.query<{ r: any }>("select ogevia_api.set_availability_direct($1,$2,'weekly',$3::jsonb,$4::date,null,$5) as r", [w.orgA, rec, JSON.stringify([mon("07:00", "15:00")]), from, reason])).rows[0]!.r);
    await expectPgError(direct(w.managerA, "Phone call with caregiver"), "OGA03");
    await expectPgError(direct(w.ownerA, " "), "OGV22", /reason/i);
    const res = await direct(w.ownerA, "Phone call with caregiver");
    expect(res).toMatchObject({ status: "approved", approvedVersion: 1 });
    expect((await db.admin.query("select status::text s from ogevia.availability_requests where id = $1", [pending])).rows[0].s).toBe("superseded");
    await expectPgError(review(w.ownerA, pending, "approve"), "OGC09", /already superseded/i);
    const a = (await db.admin.query("select action, reason, actor_user_id from ogevia.audit_events where action = 'availability.edited_directly' order by id desc limit 1")).rows[0];
    expect(a).toMatchObject({ reason: "Phone call with caregiver", actor_user_id: w.ownerA.userId });
    const src = (await db.admin.query("select source from ogevia.availability_requests where id = $1", [res.requestId])).rows[0];
    expect(src.source).toBe("administrator");
  });
});

describe("future shifts are flagged, never changed", () => {
  it("a change that removes coverage flags the shift; preview shows it before approval; the shift stays scheduled", async () => {
    const rec = await seedLegacy(w.caregiverA1, [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start: "00:00", end: "23:59" })));
    const day = await add(10);
    const dow = await dowOf(day);
    const shift = (await db.admin.query<{ id: string }>(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, ($6 || ' 10:00')::timestamp at time zone $7, ($6 || ' 12:00')::timestamp at time zone $7, 'scheduled') returning id`,
      [w.orgA, w.clientA1, w.serviceA, w.caregiverA1.userId, rec, day, LA],
    )).rows[0]!.id;
    const id = await request(w.caregiverA1, "weekly", [{ weekday: dow, start_local: "13:00", end_local: "18:00" }], await add(7), null, "New job");
    const preview = await asActor(db, w.managerA.sub, async (c) => (await c.query<{ r: any }>("select ogevia_api.preview_availability_request($1,$2) as r", [w.orgA, id])).rows[0]!.r);
    expect(preview.affectedShifts.map((s: any) => s.shiftId)).toEqual([shift]);
    expect(preview.note).toBe("Approving availability does not assign work or change booked shifts.");
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_readiness_flags")).rows[0].n).toBe(0); // preview wrote nothing
    expect((await db.admin.query("select status::text s from ogevia.availability_requests where id = $1", [id])).rows[0].s).toBe("pending");
    const res = await review(w.ownerA, id, "approve");
    expect((res.affectedShifts as any[]).map((s) => s.shiftId)).toEqual([shift]);
    const flag = (await db.admin.query("select kind, reason_code, resolved_at from ogevia.shift_readiness_flags where shift_id = $1", [shift])).rows;
    expect(flag).toMatchObject([{ kind: "availability", reason_code: "outside_approved_hours", resolved_at: null }]);
    expect((await db.admin.query("select status::text s, caregiver_record_id from ogevia.shifts where id = $1", [shift])).rows[0]).toMatchObject({ s: "scheduled", caregiver_record_id: rec });
    // Restoring coverage clears the flag.
    const back = await request(w.caregiverA1, "weekly", [{ weekday: dow, start_local: "08:00", end_local: "20:00" }], await add(7), null, "Job ended", 1);
    await review(w.ownerA, back, "approve");
    expect((await db.admin.query("select resolved_at is not null r from ogevia.shift_readiness_flags where shift_id = $1", [shift])).rows[0].r).toBe(true);
  });
});
