// Wave 1 (0051), changed by 0063 (owner directive 2026-10-17, requirement 9): a caregiver ASKS for an open or called-out shift; the shift is NOT assigned
// until an administrator confirms. At confirmation the server re-checks the shift, assignment, overlaps, the readiness gate (compliance, availability),
// work-hour limits and authorization capacity, and two competing confirmations cannot double-assign. The reservation made at scheduling is kept (Q-R);
// a caregiver who called out does not take the shift back (O-1). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const rec: Record<string, string> = {};
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  await db.admin.query("update ogevia.organizations set slug = 'socal-care-services' where id = $1", [w.orgA]); // the 8 h / 40 h policy applies (0060)
});
afterAll(async () => db?.drop());

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
let next = 2;
type Fx = { client: string; service: string; auth: string };

/** A client with a generous authorization, assigned to the given caregivers (test setup). */
async function fixture(minutes = 20000, caregivers: Actor[] = [w.caregiverA1, w.caregiverA2]): Promise<Fx> {
  const f = await freshClient(db, w, caregivers[0]!, minutes, w.orgA, { before: 40, after: 40 });
  for (const a of caregivers.slice(1)) {
    await db.admin.query(
      "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)",
      [w.orgA, a.userId, f.client, f.service, today]);
  }
  return f;
}
/** An open shift made the real way: the manager schedules it with no caregiver; its minutes are reserved. */
const openShift = (f: Fx, start = "09:00", end = "11:00", d = day(next++)) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, d, start, end]).then((r) => r[0].shift_id as string);
const pick = (a: Actor, shift: string, key: string | null = null) => q(a, "select ogevia_api.pickup_open_shift($1,$2,$3) as s", [w.orgA, shift, key]).then((r) => r[0].s as string);
const requestOf = async (shift: string, cg: string, status = "pending") =>
  (await db.admin.query("select * from ogevia.shift_pickup_requests where shift_id = $1 and caregiver_record_id = $2 and status = $3", [shift, cg, status])).rows[0];
const confirm = (a: Actor, request: string, key: string | null = null) => q(a, "select ogevia_api.confirm_shift_pickup($1,$2,$3) as s", [w.orgA, request, key]).then((r) => r[0].s as string);
const decline = (a: Actor, request: string, reason = "Synthetic: someone closer is available", key: string | null = null) =>
  q(a, "select ogevia_api.decline_shift_pickup($1,$2,$3,$4) as s", [w.orgA, request, reason, key]).then((r) => r[0].s as string);
const queue = (a: Actor) => q(a, "select * from ogevia_api.list_shift_pickup_requests($1)", [w.orgA]);
/** Ask, then return the request id (the caregiver's request). */
const ask = async (a: Actor, cg: string, shift: string) => { await pick(a, shift); return (await requestOf(shift, cg)).id as string; };
const open = (a: Actor) => q(a, "select * from ogevia_api.list_open_shifts($1)", [w.orgA]);
const shiftRow = async (id: string) => (await db.admin.query("select caregiver_record_id, caregiver_user_id, status from ogevia.shifts where id = $1", [id])).rows[0];
const events = async (id: string) => (await db.admin.query("select event_type, reason, after_snapshot from ogevia.shift_coverage_events where shift_id = $1 order by created_at", [id])).rows;
const reservation = async (id: string) => (await db.admin.query("select id, reserved_minutes, released_at from ogevia.authorization_reservations where shift_id = $1", [id])).rows;
const reservedTotal = async (f: Fx) => Number((await db.admin.query(
  "select coalesce(sum(r.reserved_minutes),0) n from ogevia.authorization_reservations r join ogevia.client_authorizations a on a.lineage_id = r.authorization_lineage_id where a.id = $1 and r.released_at is null", [f.auth])).rows[0].n);

describe("listing open shifts", () => {
  it("shows an open shift only to caregivers assigned to that client and service, with a client code and no name; a requested shift says so, to the requester only", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const mine = (await open(w.caregiverA1)).find((r) => r.shift_id === s);
    expect(mine).toMatchObject({ minutes: 120, coverage_state: "needs_coverage", my_request_status: null });
    expect(mine.client_code).toBeTruthy();
    expect(Object.keys(mine)).not.toContain("client_name");
    expect((await open(w.caregiverA3)).find((r) => r.shift_id === s)).toBeUndefined();
    expect(await open(w.managerA)).toEqual([]);
    expect(await open(w.caregiverB1)).toEqual([]);
    await pick(w.caregiverA1, s);
    expect((await open(w.caregiverA1)).find((r) => r.shift_id === s)).toMatchObject({ my_request_status: "requested" });
    expect((await open(w.caregiverA2)).find((r) => r.shift_id === s)).toMatchObject({ my_request_status: null });
  });
});

describe("asking for an open shift does NOT assign it", () => {
  it("records a request only: the shift, its coverage state, its reservation and its history are untouched; the audit says who asked", async () => {
    const f = await fixture();
    const s = await openShift(f, "09:00", "12:00");
    const before = [await shiftRow(s), await reservation(s), await events(s), await reservedTotal(f)];
    expect(await pick(w.caregiverA1, s)).toBe("requested");
    expect([await shiftRow(s), await reservation(s), await events(s), await reservedTotal(f)]).toEqual(before);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null, caregiver_user_id: null, status: "scheduled" });
    expect(await requestOf(s, rec["CG-A1"]!)).toMatchObject({ status: "pending", requested_by: w.caregiverA1.userId, decided_at: null });
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'shift.pickup_requested'", [s])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'shift.picked_up'", [s])).rows[0].n).toBe(0);
    expect((await q(w.caregiverA1, "select * from ogevia_api.list_my_shifts($1)", [w.orgA])).find((r) => r.shift_id === s)).toBeUndefined(); // not on their schedule
    const list = await q(w.managerA, "select * from ogevia_api.list_shifts($1, $2::date, $3::date, null)", [w.orgA, day(-1), day(40)]);
    expect(list.find((r) => r.shift_id === s)).toMatchObject({ coverage_state: "needs_coverage" });
  });

  it("two caregivers can both ask; neither is assigned; nothing is written to the shift", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const results = await Promise.allSettled([pick(w.caregiverA1, s), pick(w.caregiverA2, s)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await events(s)).toHaveLength(0);
    expect((await queue(w.managerA)).filter((r) => r.shift_id === s)).toHaveLength(2);
  });

  it("a retry with the same key, and a second tap with a new key, are one request", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const key = randomUUID();
    expect(await pick(w.caregiverA1, s, key)).toBe("requested");
    expect(await pick(w.caregiverA1, s, key)).toBe("requested");
    expect(await pick(w.caregiverA1, s, randomUUID())).toBe("requested");
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_pickup_requests where shift_id = $1", [s])).rows[0].n).toBe(1);
  });

  it("refuses, saving nothing, when the client is not assigned to the caregiver", async () => {
    const f = await fixture();
    const s = await openShift(f);
    await expectPgError(pick(w.caregiverA3, s), "OGA03", /not assigned to you/);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_pickup_requests where shift_id = $1", [s])).rows[0].n).toBe(0);
  });

  it("refuses when the caregiver already has a shift at that time", async () => {
    const f = await fixture();
    const d = day(next++);
    await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A1"]]);
    const s = await openShift(f, "11:00", "13:00", d);
    await expectPgError(pick(w.caregiverA1, s), "OGC09", /already|overlap|another shift/i);
  });

  it("refuses a shift that is cancelled, a care-request shift, an unknown shift, a non-caregiver, another agency", async () => {
    const f = await fixture();
    const s = await openShift(f);
    await q(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic cancel',null)", [w.orgA, s]);
    await expectPgError(pick(w.caregiverA1, s), "OGC09", /no longer scheduled/);
    const t = await openShift(f);
    await expectPgError(pick(w.managerA, t), "OGA03", /Only an active caregiver/);
    await expectPgError(pick(w.caregiverB1, t), "OGA03", /Only an active caregiver/);
    await expectPgError(pick(w.outsider, t), "OGA03", /Only an active caregiver/);
    await expectPgError(pick(w.caregiverA1, randomUUID()), "OGN04", /Shift not found/);
  });

  it("a caregiver who called out may not ask for that shift again (O-1); another may", async () => {
    const f = await fixture();
    const s = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, f.client, f.service, day(next++), rec["CG-A1"]]))[0].shift_id as string;
    await q(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Synthetic: sick',null)", [w.orgA, s]);
    expect((await open(w.caregiverA1)).find((r) => r.shift_id === s)).toBeUndefined();
    await expectPgError(pick(w.caregiverA1, s), "OGC09", /You called out of this shift/);
    expect(await pick(w.caregiverA2, s)).toBe("requested");
  });

  it("a caregiver can withdraw their own waiting request; nobody else's; the shift is untouched", async () => {
    const f = await fixture();
    const s = await openShift(f);
    await pick(w.caregiverA1, s);
    await pick(w.caregiverA2, s);
    await expectPgError(q(w.caregiverA3, "select ogevia_api.withdraw_my_shift_pickup($1,$2)", [w.orgA, s]), "OGN04", /no waiting request/);
    expect((await q(w.caregiverA1, "select ogevia_api.withdraw_my_shift_pickup($1,$2) as s", [w.orgA, s]))[0].s).toBe("withdrawn");
    expect(await requestOf(s, rec["CG-A1"]!, "withdrawn")).toBeTruthy();
    expect(await requestOf(s, rec["CG-A2"]!)).toBeTruthy(); // still waiting
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
  });
});

describe("the administrator confirms, and only then is the caregiver assigned", () => {
  it("confirmation assigns the same shift, keeps the reservation untouched, records who and how, closes the other requests", async () => {
    const f = await fixture();
    const s = await openShift(f, "09:00", "12:00");
    const resBefore = await reservation(s);
    const totalBefore = await reservedTotal(f);
    const r1 = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    await ask(w.caregiverA2, rec["CG-A2"]!, s);
    expect(await confirm(w.managerA, r1)).toBe("covered");
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: rec["CG-A1"], caregiver_user_id: w.caregiverA1.userId, status: "scheduled" });
    expect(await reservation(s)).toEqual(resBefore);
    expect(await reservedTotal(f)).toBe(totalBefore);
    const ev = await events(s);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "reassigned", reason: "Open shift filled: request confirmed by the office" });
    expect(ev[0].after_snapshot).toMatchObject({ pickup_request_id: r1, authorization_checked: true, reserved_minutes: 180 });
    expect(await requestOf(s, rec["CG-A1"]!, "confirmed")).toMatchObject({ decided_by: w.managerA.userId });
    expect((await requestOf(s, rec["CG-A1"]!, "confirmed")).confirmation_snapshot.checks).toContain("work_hours");
    expect(await requestOf(s, rec["CG-A2"]!, "superseded")).toMatchObject({ decision_reason: "The shift was filled" });
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'shift.pickup_confirmed'", [s])).rows[0].n).toBe(1);
    expect((await q(w.caregiverA1, "select * from ogevia_api.list_my_shifts($1)", [w.orgA])).find((x) => x.shift_id === s)).toMatchObject({ coverage_state: "covered" });
    expect((await open(w.caregiverA2)).find((x) => x.shift_id === s)).toBeUndefined();
    const list = await q(w.managerA, "select * from ogevia_api.list_shifts($1, $2::date, $3::date, null)", [w.orgA, day(-1), day(40)]);
    expect(list.filter((x) => x.shift_id === s)).toHaveLength(1);
  });

  it("only someone who may manage shifts can confirm; another agency's manager cannot see the request", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    await expectPgError(confirm(w.caregiverA1, r), "OGA03", /permission/i);
    await expectPgError(confirm(w.caregiverA2, r), "OGA03");
    await expectPgError(q(w.managerB, "select ogevia_api.confirm_shift_pickup($1,$2,null)", [w.orgA, r]), "OGN04");
    expect(await queue(w.managerB)).toEqual([]);
    expect(await queue(w.caregiverA1)).toEqual([]);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await confirm(w.schedulerA, r)).toBe("covered"); // shifts.manage is enough
  });

  it("the same key replays the answer; confirming the same request again says it was already confirmed", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    const key = randomUUID();
    expect(await confirm(w.managerA, r, key)).toBe("covered");
    expect(await confirm(w.managerA, r, key)).toBe("covered");
    await expectPgError(confirm(w.managerA, r), "OGC09", /already confirmed/);
    expect(await events(s)).toHaveLength(1);
  });

  it("COMPETING CONFIRMATIONS: two administrators confirming two different requests at once assign exactly one caregiver", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r1 = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    const r2 = await ask(w.caregiverA2, rec["CG-A2"]!, s);
    const results = await Promise.allSettled([confirm(w.managerA, r1), confirm(w.ownerA, r2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.code).toBe("OGC09");
    expect(lost.reason.message).toMatch(/just filled|already/);
    const winner = (await shiftRow(s)).caregiver_record_id;
    expect([rec["CG-A1"], rec["CG-A2"]]).toContain(winner);
    expect(await events(s)).toHaveLength(1);
    expect(await reservation(s)).toHaveLength(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_pickup_requests where shift_id = $1 and status = 'confirmed'", [s])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_pickup_requests where shift_id = $1 and status = 'pending'", [s])).rows[0].n).toBe(0);
  });

  it("the same request confirmed twice at once is one assignment", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    const results = await Promise.allSettled([confirm(w.managerA, r), confirm(w.ownerA, r)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await events(s)).toHaveLength(1);
  });

  it("a confirmation racing an office assignment of the same shift never leaves two caregivers: the shift ends with exactly one, and every change is on record", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    const results = await Promise.allSettled([
      confirm(w.managerA, r),
      q(w.ownerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic office fill',null)", [w.orgA, s, rec["CG-A2"]]),
    ]);
    expect(results.filter((x) => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const final = (await shiftRow(s)).caregiver_record_id as string;
    expect([rec["CG-A1"], rec["CG-A2"]]).toContain(final);
    const ev = await events(s);
    expect(ev.length).toBe(results.filter((x) => x.status === "fulfilled").length); // one 'reassigned' event per change that took effect
    expect((await db.admin.query("select count(*)::int n from ogevia.shifts where id = $1", [s])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.authorization_reservations where shift_id = $1 and released_at is null", [s])).rows[0].n).toBe(1);
    // the request is never left waiting once the shift has a caregiver
    expect((await db.admin.query("select count(*)::int n from ogevia.shift_pickup_requests where shift_id = $1 and status = 'pending'", [s])).rows[0].n).toBe(0);
  });
});

describe("everything is re-checked at the moment of confirmation", () => {
  it("work-hour limits: the agency 8 h / 40 h policy refuses a confirmation that would exceed it, however the hours got there", async () => {
    const f = await fixture();
    const d = day(next++);
    const s = await openShift(f, "07:00", "10:00", d); // 3 h open
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    // after the request the office gives the caregiver 6 h that day elsewhere: 3 + 6 = 9 > 8
    await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'11:00','17:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A1"]]);
    await expectPgError(confirm(w.managerA, r), "OGR30", /daily hour limit/i);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await requestOf(s, rec["CG-A1"]!)).toBeTruthy(); // still waiting; nothing changed
    expect(await events(s)).toHaveLength(0);
  });

  it("overlap: a shift given to the caregiver after the request makes the confirmation refuse", async () => {
    const f = await fixture();
    const d = day(next++);
    const s = await openShift(f, "09:00", "11:00", d);
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A1"]]);
    await expectPgError(confirm(w.managerA, r), "OGC09", /already has a shift/);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
  });

  it("compliance: a requirement that starts being enforced after the request (no cleared background check) refuses the confirmation", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA2, rec["CG-A2"]!, s);
    await db.admin.query("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [rec["CG-A2"]]);
    await db.admin.query("insert into ogevia.organization_readiness_settings (organization_id, enforcement_active_from) values ($1, now() - interval '1 day') on conflict (organization_id) do update set enforcement_active_from = excluded.enforcement_active_from", [w.orgA]);
    try {
      await expectPgError(confirm(w.managerA, r), "OGR30", /background|clearance/i);
      expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
      // and the caregiver cannot ask again while the requirement is unmet
      await expectPgError(pick(w.caregiverA2, await openShift(f)), "OGR30");
    } finally {
      await db.admin.query("update ogevia.organization_readiness_settings set enforcement_active_from = null where organization_id = $1", [w.orgA]);
    }
  });

  it("assignment: the client assignment ended after the request refuses the confirmation", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA2, rec["CG-A2"]!, s);
    await db.admin.query("update ogevia.caregiver_assignments set is_active = false where client_id = $1 and caregiver_user_id = $2", [f.client, w.caregiverA2.userId]);
    await expectPgError(confirm(w.managerA, r), "OGC09", /no longer assigned/);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
  });

  it("authorization: lowering the authorization after the request refuses; exactly covering it succeeds; a missing reservation refuses", async () => {
    const f = await fixture(600);
    const s = await openShift(f, "09:00", "13:00"); // 4 h reserved
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    await api.amend(db, w.managerA, f.auth, 120, "Synthetic: lowered below the open shift");
    await expectPgError(confirm(w.managerA, r), "OGC09", /Authorization no longer covers this shift/);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await reservation(s)).toEqual([expect.objectContaining({ reserved_minutes: 240, released_at: null })]);
    expect(await events(s)).toHaveLength(0);

    const g = await fixture(240);
    const t = await openShift(g, "09:00", "13:00");
    expect(await confirm(w.managerA, await ask(w.caregiverA1, rec["CG-A1"]!, t))).toBe("covered"); // reserved equals the cap

    const h = await fixture();
    const u = await openShift(h);
    const ru = await ask(w.caregiverA1, rec["CG-A1"]!, u);
    await db.admin.query("update ogevia.authorization_reservations set released_at = now(), release_reason = 'synthetic' where shift_id = $1", [u]);
    await expectPgError(confirm(w.managerA, ru), "OGC09", /no authorization reserved/);
  });

  it("the shift changed after the request: filled elsewhere or cancelled closes the request; a started visit blocks it", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    await q(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Synthetic office fill',null)", [w.orgA, s, rec["CG-A2"]]);
    expect(await requestOf(s, rec["CG-A1"]!, "superseded")).toMatchObject({ decision_reason: "The shift was filled" });
    await expectPgError(confirm(w.managerA, r), "OGC09", /closed|just filled/);
    expect((await shiftRow(s)).caregiver_record_id).toBe(rec["CG-A2"]);

    const g = await openShift(f);
    const rg = await ask(w.caregiverA1, rec["CG-A1"]!, g);
    await q(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic cancel',null)", [w.orgA, g]);
    expect(await requestOf(g, rec["CG-A1"]!, "superseded")).toMatchObject({ decision_reason: "The shift is no longer scheduled" });
    await expectPgError(confirm(w.managerA, rg), "OGC09");
  });
});

describe("declining", () => {
  it("needs a reason, leaves the shift open, and does not touch the other requests", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r1 = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    await ask(w.caregiverA2, rec["CG-A2"]!, s);
    await expectPgError(decline(w.managerA, r1, "  "), "OGV22", /reason/);
    await expectPgError(decline(w.caregiverA1, r1), "OGA03");
    const key = randomUUID();
    expect(await decline(w.managerA, r1, "Synthetic: a closer caregiver is free", key)).toBe("declined");
    expect(await decline(w.managerA, r1, "Synthetic: a closer caregiver is free", key)).toBe("declined");
    expect(await requestOf(s, rec["CG-A1"]!, "declined")).toMatchObject({ decision_reason: "Synthetic: a closer caregiver is free", decided_by: w.managerA.userId });
    expect(await requestOf(s, rec["CG-A2"]!)).toBeTruthy();
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    await expectPgError(confirm(w.managerA, r1), "OGC09", /already declined/);
    await expectPgError(decline(w.managerA, r1, "Synthetic again"), "OGC09", /already declined/);
  });
});

describe("a called-out shift (O-1)", () => {
  it("another caregiver asks, the office confirms, the shift stays one shift and the reservation is unchanged", async () => {
    const f = await fixture();
    const d = day(next++);
    const s = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A1"]]))[0].shift_id as string;
    await q(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Synthetic: sick',null)", [w.orgA, s]);
    const reservedBefore = await reservedTotal(f);
    const r = await ask(w.caregiverA2, rec["CG-A2"]!, s);
    expect((await shiftRow(s)).caregiver_record_id).toBe(rec["CG-A1"]); // still the old caregiver on the row until confirmed
    expect(await confirm(w.managerA, r)).toBe("covered");
    expect(await reservedTotal(f)).toBe(reservedBefore);
    const ev = await events(s);
    expect(ev.map((e) => e.event_type)).toEqual(["called_out", "reassigned"]);
    expect(ev[1].reason).toBe("Replacement after call-out: request confirmed by the office");
    expect((await q(w.managerA, "select * from ogevia_api.list_shifts($1, $2::date, $3::date, null)", [w.orgA, day(-1), day(40)])).filter((x) => x.shift_id === s)).toHaveLength(1);
  });
});

describe("the office queue and the attention overview", () => {
  it("lists each waiting request with what would block it now; the count is routine and never added to the urgent total", async () => {
    const f = await fixture();
    const d = day(next++);
    const s = await openShift(f, "09:00", "11:00", d);
    await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A2"]]);
    const before = (await q(w.managerA, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]))[0].o;
    await ask(w.caregiverA1, rec["CG-A1"]!, s);
    // A2's own request would have been refused at request time (overlap), so make it pending the other way: request first, then give the shift
    const s2 = await openShift(f, "13:00", "15:00", d);
    await ask(w.caregiverA2, rec["CG-A2"]!, s2);
    await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'14:00','16:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A2"]]);
    const q1 = await queue(w.managerA);
    const mine = q1.find((x) => x.shift_id === s)!;
    const blocked = q1.find((x) => x.shift_id === s2)!;
    expect(mine).toMatchObject({ caregiver_code: "CG-A1", blockers: [] });
    expect(mine.client_code).toBeTruthy();
    expect(blocked.blockers.join(" ")).toMatch(/already booked/i);
    const after = (await q(w.managerA, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]))[0].o;
    expect(after.pickups.count).toBe((before.pickups?.count ?? 0) + 2);
    expect(after.pickups.oldestRequestedAt).toBeTruthy();
    expect(after.urgent.itemCount).toBe(before.urgent.itemCount + (after.urgent.items.length - before.urgent.items.length)); // not inflated by the requests themselves
    expect((await q(w.schedulerA, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]))[0].o.pickups.count).toBe(after.pickups.count);
    await expectPgError(q(w.caregiverA1, "select ogevia_api.get_attention_overview($1,48)", [w.orgA]), "OGA03");
  });
});

describe("a request cannot be altered or erased, and the application role cannot write shifts", () => {
  it("a decided request is final; no delete; the application role has no direct access", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const r = await ask(w.caregiverA1, rec["CG-A1"]!, s);
    await confirm(w.managerA, r);
    await expect(db.admin.query("update ogevia.shift_pickup_requests set status = 'pending', decided_at = null where id = $1", [r])).rejects.toMatchObject({ code: "OGC09" });
    await expect(db.admin.query("delete from ogevia.shift_pickup_requests where id = $1", [r])).rejects.toThrow();
    await expect(asActor(db, w.caregiverA1.sub, (c) => c.query("update ogevia.shifts set caregiver_record_id = $1 where id = $2", [rec["CG-A1"], s]))).rejects.toThrow(/permission denied/i);
    await expect(asActor(db, w.caregiverA1.sub, (c) => c.query("insert into ogevia.shift_pickup_requests (organization_id, shift_id, caregiver_record_id, requested_by) values ($1,$2,$3,$4)", [w.orgA, s, rec["CG-A1"], w.caregiverA1.userId]))).rejects.toThrow(/permission denied/i);
  });
});
