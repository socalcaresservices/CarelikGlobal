// 0040 Availability approval workflow. SYNTHETIC data only. Fixed agency-local dates where dates matter.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveAvailability, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let fresh: { client: string; service: string; auth: string };
const rec: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fresh = await freshClient(db, w, w.caregiverA1, 30000, w.orgA, { before: 40, after: 200 });
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const win = (weekday: number, start: string, end: string) => ({ weekday, specific_date: null, start_local: start, end_local: end });
const state = (a: Actor) => q(a, "select ogevia_api.get_my_availability_state($1) as s", [w.orgA]).then((r) => r[0]!.s as any);
const submit = (a: Actor, reason: string, windows: unknown[] | null, unavailable: unknown[] | null, version: number | null, key: string | null = null) =>
  q(a, "select ogevia_api.request_availability_change($1,$2,$3::jsonb,$4::jsonb,$5,$6) as id",
    [w.orgA, reason, windows === null ? null : JSON.stringify(windows), unavailable === null ? null : JSON.stringify(unavailable), version, key]).then((r) => r[0]!.id as string);
const review = (a: Actor, id: string, decision: string, note: string | null = null) =>
  q(a, "select ogevia_api.review_availability_request($1,$2,$3,null) as v", [id, decision, note]).then((r) => r[0]!.v as number);
const adminEdit = (a: Actor, record: string, windows: unknown[] | null, unavailable: unknown[] | null, reason: string, version: number | null) =>
  q(a, "select ogevia_api.set_caregiver_availability($1,$2,$3::jsonb,$4::jsonb,$5,$6,null) as v",
    [w.orgA, record, windows === null ? null : JSON.stringify(windows), unavailable === null ? null : JSON.stringify(unavailable), reason, version]).then((r) => r[0]!.v as number);
const approvedRows = async (record: string) => ({
  windows: (await db.admin.query("select weekday, start_local::text s, end_local::text e from ogevia.caregiver_availability_windows where caregiver_record_id = $1 order by weekday, start_local", [record])).rows,
  unavailable: (await db.admin.query("select unavailable_date::text d from ogevia.caregiver_unavailable_dates where caregiver_record_id = $1 order by 1", [record])).rows.map((r: any) => r.d),
});

describe("not provided, pending and approved are different things", () => {
  it("a caregiver who has provided nothing is 'not provided', with the agency time zone shown", async () => {
    const s = await state(w.caregiverA3);
    expect(s).toMatchObject({ has_record: true, provided: false, version: 0, timezone: "America/Los_Angeles" });
    expect(s.windows).toEqual([]);
    expect(s.pending).toBeNull();
  });

  it("a pending request never contributes to matching or readiness; the current approved availability stays active", async () => {
    const A1 = rec["CG-A1"]!;
    await approveAvailability(db, w, w.caregiverA1, [win(dow(day(5)), "08:00", "12:00")]);
    const before = await approvedRows(A1);
    expect(before.windows).toHaveLength(1);
    const v = (await state(w.caregiverA1)).version;
    const id = await submit(w.caregiverA1, "I can work longer hours now", [win(dow(day(5)), "08:00", "20:00")], null, v);
    // approved rows unchanged; the request is visible to the caregiver as pending
    expect(await approvedRows(A1)).toEqual(before);
    const s = await state(w.caregiverA1);
    expect(s.pending).toMatchObject({ request_id: id, stale: false, reason: "I can work longer hours now" });
    // a care request 14:00-18:00 on that day is NOT matched (only the approved 08:00-12:00 counts)
    const cr = (await db.admin.query(
      `insert into ogevia.care_requests(organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key)
       values ($1,$2,$3,$4, ($5::date + time '14:00') at time zone 'America/Los_Angeles', ($5::date + time '18:00') at time zone 'America/Los_Angeles', 240, gen_random_uuid()) returning id`,
      [w.orgA, fresh.client, fresh.service, fresh.auth, day(5)])).rows[0].id;
    let ids = (await q(w.managerA, "select caregiver_record_id from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, cr])).map((r: any) => r.caregiver_record_id);
    expect(ids).not.toContain(A1);
    // once approved, it is matched
    await review(w.managerA, id, "approve", "Fine");
    ids = (await q(w.managerA, "select caregiver_record_id from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, cr])).map((r: any) => r.caregiver_record_id);
    expect(ids).toContain(A1);
  });
});

describe("requests", () => {
  it("a reason is required; only caregivers submit for themselves; the same availability is not a change; one pending at a time; cancel", async () => {
    const A2 = w.caregiverA2;
    await expectPgError(submit(A2, " ", [win(1, "08:00", "12:00")], null, 0), "OGV22");
    await expectPgError(q(w.managerA, "select ogevia_api.request_availability_change($1,'Reason here',null,null,0,null)", [w.orgA]), "OGA03");
    await expectPgError(submit(A2, "No change at all", null, null, 0), "OGV22");
    const id = await submit(A2, "New school hours", [win(1, "08:00", "12:00")], [], 0);
    await expectPgError(submit(A2, "Another change", [win(2, "08:00", "12:00")], [], 0), "OGC09");
    await expectPgError(q(w.caregiverA1, "select ogevia_api.cancel_my_availability_request($1,$2)", [w.orgA, id]), "OGN04"); // not theirs
    await q(A2, "select ogevia_api.cancel_my_availability_request($1,$2)", [w.orgA, id]);
    await expectPgError(review(w.managerA, id, "approve"), "OGC09"); // cancelled requests cannot be approved
    const r = (await db.admin.query("select status, reviewed_by from ogevia.caregiver_availability_requests where id = $1", [id])).rows[0];
    expect(r.status).toBe("cancelled");
    expect(r.reviewed_by).toBe(A2.userId);
  });

  it("windows must be well formed: one day each, start different from end, overnight allowed, weekday 0-6", async () => {
    const A2 = w.caregiverA2;
    for (const bad of [
      [{ weekday: 1, specific_date: day(3), start_local: "08:00", end_local: "12:00" }],
      [{ weekday: null, specific_date: null, start_local: "08:00", end_local: "12:00" }],
      [{ weekday: 7, specific_date: null, start_local: "08:00", end_local: "12:00" }],
      [{ weekday: 1, specific_date: null, start_local: "08:00", end_local: "08:00" }],
    ]) {
      await expectPgError(submit(A2, "Testing validation", bad, [], 0), "OGV22");
    }
    const id = await submit(A2, "Night shifts only", [win(6, "22:00", "06:00")], [], 0); // overnight is valid
    await q(A2, "select ogevia_api.cancel_my_availability_request($1,$2)", [w.orgA, id]);
  });
});

describe("review", () => {
  it("only an administrator reviews; decline needs a note and changes nothing; approve applies, records who and when, and is audited", async () => {
    const A2 = w.caregiverA2;
    const id = await submit(A2, "Weekday mornings please", [win(1, "08:00", "12:00"), win(3, "08:00", "12:00")], [], 0);
    await expectPgError(review(A2, id, "approve"), "OGA03");
    await expectPgError(review(w.schedulerA, id, "approve"), "OGA03");
    await expectPgError(review(w.managerB, id, "approve"), "OGN04");
    await expectPgError(review(w.managerA, id, "decline", " "), "OGV22");
    await expectPgError(review(w.managerA, id, "maybe"), "OGV22");
    await review(w.managerA, id, "decline", "Please include Fridays too");
    expect(await approvedRows(rec["CG-A2"]!)).toEqual({ windows: [], unavailable: [] });
    expect((await state(A2)).last_decision).toMatchObject({ status: "declined", note: "Please include Fridays too" });
    await expectPgError(review(w.managerA, id, "approve"), "OGC09"); // already reviewed

    const id2 = await submit(A2, "Weekday mornings please", [win(1, "08:00", "12:00"), win(3, "08:00", "12:00")], [], 0);
    const v = await review(w.managerA, id2, "approve", "Looks right");
    expect(v).toBe(1);
    expect((await approvedRows(rec["CG-A2"]!)).windows).toHaveLength(2);
    const r = (await db.admin.query("select status, reviewed_by, reviewed_at, requested_by from ogevia.caregiver_availability_requests where id = $1", [id2])).rows[0];
    expect(r).toMatchObject({ status: "approved", reviewed_by: w.managerA.userId, requested_by: A2.userId });
    expect(r.reviewed_at).toBeTruthy();
    const audit = (await db.admin.query("select action, reason from ogevia.audit_events where entity_id = $1 order by id", [id2])).rows.map((x: any) => x.action);
    expect(audit).toEqual(["availability.requested", "availability.approved"]);
    // submitted values are kept exactly as submitted
    const kept = (await db.admin.query("select proposed_windows from ogevia.caregiver_availability_requests where id = $1", [id2])).rows[0].proposed_windows;
    expect(kept).toHaveLength(2);
    // requests are immutable except their one review
    await expect(db.admin.query("update ogevia.caregiver_availability_requests set reason = 'edited' where id = $1", [id2])).rejects.toThrow();
    await expect(db.admin.query("delete from ogevia.caregiver_availability_requests where id = $1", [id2])).rejects.toThrow();
  });

  it("the review list shows current and requested side by side; other agencies and caregivers cannot see it", async () => {
    const A3 = w.caregiverA3;
    await submit(A3, "Starting part-time", [win(2, "09:00", "15:00")], [], 0);
    const rows = await q(w.managerA, "select * from ogevia_api.list_availability_requests($1,'pending')", [w.orgA]);
    const row = rows.find((x: any) => x.caregiver_code === "CG-A3");
    expect(row).toMatchObject({ status: "pending", stale: false, baseline_version: 0, current_version: 0 });
    expect(row.proposed_windows).toHaveLength(1);
    expect(row.current_windows).toEqual([]);
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.list_availability_requests($1,'pending')", [w.orgA]), "OGA03");
    await expectPgError(q(w.managerB, "select * from ogevia_api.list_availability_requests($1,'pending')", [w.orgA]), "OGN04");
  });
});

describe("exceptions are preserved and stale saves are refused", () => {
  it("leaving exceptions out keeps them; clearing needs an explicit empty list", async () => {
    const A1 = rec["CG-A1"]!;
    const d1 = day(30);
    await approveAvailability(db, w, w.caregiverA1, [win(dow(day(5)), "08:00", "20:00")], [{ date: d1, reason: "Appointment" }]);
    expect((await approvedRows(A1)).unavailable).toEqual([d1]);
    // a request that only changes weekly windows (exceptions omitted = null) keeps the exception
    let v = (await state(w.caregiverA1)).version;
    let id = await submit(w.caregiverA1, "Shorter hours", [win(dow(day(5)), "09:00", "17:00")], null, v);
    await review(w.managerA, id, "approve");
    expect((await approvedRows(A1)).unavailable).toEqual([d1]);
    expect((await approvedRows(A1)).windows).toEqual([{ weekday: dow(day(5)), s: "09:00:00", e: "17:00:00" }]);
    // explicit [] clears them
    v = (await state(w.caregiverA1)).version;
    id = await submit(w.caregiverA1, "Appointment cancelled", null, [], v);
    await review(w.managerA, id, "approve");
    expect((await approvedRows(A1)).unavailable).toEqual([]);
    expect((await approvedRows(A1)).windows).toHaveLength(1); // windows kept when omitted
  });

  it("a request written against an older version is stale and cannot be approved over a newer change", async () => {
    const A3 = rec["CG-A3"]!;
    const pending = (await q(w.managerA, "select request_id from ogevia_api.list_availability_requests($1,'pending')", [w.orgA])).find((x: any) => x.request_id)!.request_id;
    // an administrator edits A3 directly with a reason; that bumps the version
    const v = await adminEdit(w.managerA, A3, [win(4, "10:00", "14:00")], [], "Phone call with the caregiver", 0);
    expect(v).toBe(1);
    const row = (await q(w.managerA, "select * from ogevia_api.list_availability_requests($1,'pending')", [w.orgA])).find((x: any) => x.request_id === pending);
    expect(row).toMatchObject({ stale: true, baseline_version: 0, current_version: 1 });
    await expectPgError(review(w.managerA, pending, "approve"), "OGC09", /changed after this request/);
    // the newer approved availability is intact
    expect((await approvedRows(A3)).windows).toEqual([{ weekday: 4, s: "10:00:00", e: "14:00:00" }]);
    // the caregiver cannot submit against the old version either
    await q(w.caregiverA3, "select ogevia_api.cancel_my_availability_request($1,$2)", [w.orgA, pending]);
    await expectPgError(submit(w.caregiverA3, "Stale page", [win(5, "10:00", "14:00")], [], 0), "OGC09");
  });
});

describe("administrator edits", () => {
  it("need a reason, the version the administrator saw and the right permission; they are audited with before and after", async () => {
    const A2 = rec["CG-A2"]!;
    const v = (await q(w.managerA, "select ogevia_api.get_caregiver_availability($1,$2) as s", [w.orgA, A2]))[0]!.s.version as number;
    await expectPgError(adminEdit(w.managerA, A2, [win(5, "08:00", "12:00")], null, " ", v), "OGV22");
    await expectPgError(adminEdit(w.managerA, A2, [win(5, "08:00", "12:00")], null, "Family request", null), "OGC09");
    await expectPgError(adminEdit(w.managerA, A2, [win(5, "08:00", "12:00")], null, "Family request", v + 3), "OGC09");
    await expectPgError(adminEdit(w.caregiverA2, A2, [win(5, "08:00", "12:00")], null, "Let me", v), "OGA03");
    await expectPgError(adminEdit(w.schedulerA, A2, [win(5, "08:00", "12:00")], null, "Not allowed", v), "OGA03");
    await expectPgError(adminEdit(w.managerB, A2, [win(5, "08:00", "12:00")], null, "Other agency", v), "OGN04");
    const after = await adminEdit(w.managerA, A2, [win(5, "08:00", "12:00")], null, "Family request", v);
    expect(after).toBe(v + 1);
    const a = (await db.admin.query("select reason, before_state, after_state from ogevia.audit_events where action = 'availability.admin_edit' and entity_id = $1", [A2])).rows[0];
    expect(a.reason).toBe("Family request");
    expect(a.before_state.windows).toHaveLength(2);
    expect(a.after_state.windows).toHaveLength(1);
    const g = (await q(w.managerA, "select ogevia_api.get_caregiver_availability($1,$2) as s", [w.orgA, A2]))[0]!.s;
    expect(g).toMatchObject({ version: after, update_source: "admin", timezone: "America/Los_Angeles", provided: true });
    expect(g.updated_by).toBeTruthy();
    await expectPgError(q(w.caregiverA1, "select ogevia_api.get_caregiver_availability($1,$2)", [w.orgA, A2]), "OGA03");
  });

  it("the caregiver can no longer write availability directly", async () => {
    await expectPgError(q(w.caregiverA1, "select ogevia_api.replace_my_availability($1,'[]'::jsonb,'[]'::jsonb)", [w.orgA]), "OGV22", /Request change/);
  });

  it("an availability change never moves or cancels a shift; shifts now outside it are listed for review", async () => {
    const A1 = rec["CG-A1"]!;
    // approved availability: day(5) weekday 09:00-17:00. Book a shift inside it, then request narrower hours.
    const s = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, fresh.client, fresh.service, day(5), A1]))[0]!.shift_id;
    const v = (await state(w.caregiverA1)).version;
    const id = await submit(w.caregiverA1, "Afternoons only from now on", [win(dow(day(5)), "13:00", "17:00")], null, v);
    await review(w.managerA, id, "approve");
    const list = await q(w.managerA, "select * from ogevia_api.list_availability_conflicts($1,$2,365)", [w.orgA, A1]);
    expect(list.map((x: any) => x.shift_id)).toContain(s);
    expect((await db.admin.query("select status, caregiver_record_id from ogevia.shifts where id = $1", [s])).rows[0]).toEqual({ status: "scheduled", caregiver_record_id: A1 });
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.list_availability_conflicts($1,$2,90)", [w.orgA, A1]), "OGA03");
    await expectPgError(q(w.managerB, "select * from ogevia_api.list_availability_conflicts($1,$2,90)", [w.orgA, A1]), "OGN04");
  });
});

describe("concurrency", () => {
  it("two administrators approving the same request: one applies it, the other is told it was already reviewed", async () => {
    const A3 = w.caregiverA3;
    const v = (await state(A3)).version;
    const id = await submit(A3, "Concurrent review test", [win(1, "07:00", "11:00")], null, v);
    const open = async (sub: string) => {
      const c = await db.admin.connect();
      await c.query("begin");
      await c.query("set local role ogevia_app");
      await c.query("select ogevia_api.begin_request($1, $2)", [sub, randomUUID()]);
      return c;
    };
    const t1 = await open(w.managerA.sub);
    const t2 = await open(w.ownerA.sub);
    const finish = async (c: pg.PoolClient, ok: boolean) => { try { await c.query(ok ? "commit" : "rollback"); } catch { /* ended */ } finally { c.release(); } };
    try {
      await t1.query("select ogevia_api.review_availability_request($1,'approve','First',null)", [id]);
      const second = t2.query("select ogevia_api.review_availability_request($1,'approve','Second',null)", [id]).then(() => "approved", (e: { message: string }) => e.message);
      await new Promise((r) => setTimeout(r, 200));
      await t1.query("commit");
      expect(await second).toMatch(/already reviewed/);
    } finally {
      await finish(t1, false);
      await finish(t2, false);
    }
    const n = (await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'availability.approved'", [id])).rows[0].n;
    expect(n).toBe(1);
  });
});

describe("required availability uses only the approved record", () => {
  it("with the agency switch on, a pending request does not make a shift acceptable; an approved one does", async () => {
    await q(w.ownerA, "select ogevia_api.set_readiness_settings($1,false,true,30,'Availability now required')", [w.orgA]);
    const A3 = rec["CG-A3"]!;
    const date = day(12);
    // A3's approved availability is weekday 4 / 10:00-14:00 and weekday 1 07:00-11:00; request something for date's weekday
    const wd = dow(date);
    const v = (await state(w.caregiverA3)).version;
    const id = await submit(w.caregiverA3, "Please add this day", [win(wd, "08:00", "18:00"), win(4, "10:00", "14:00"), win(1, "07:00", "11:00")], null, v);
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, fresh.client, fresh.service, date, A3]),
      "OGV22", /Needs override: outside approved availability/);
    await review(w.managerA, id, "approve");
    const ok = await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, fresh.client, fresh.service, date, A3]);
    expect(ok[0]!.shift_id).toBeTruthy();
    await q(w.ownerA, "select ogevia_api.set_readiness_settings($1,false,false,30,'Back to defaults')", [w.orgA]);
  });
});
