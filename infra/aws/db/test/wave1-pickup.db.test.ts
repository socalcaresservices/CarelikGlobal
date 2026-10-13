// Wave 1 (0051): a caregiver picks up an open or called-out shift (G09, D-P).
// Exactly one caregiver wins; a retry or double tap makes no second claim; authorization is re-checked on the server at claim
// time; the reservation made at scheduling is kept (Q-R); a caregiver who called out does not take the shift back (O-1).
// SYNTHETIC data only.
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
const open = (a: Actor) => q(a, "select * from ogevia_api.list_open_shifts($1)", [w.orgA]);
const shiftRow = async (id: string) => (await db.admin.query("select caregiver_record_id, caregiver_user_id, status from ogevia.shifts where id = $1", [id])).rows[0];
const events = async (id: string) => (await db.admin.query("select event_type, reason, after_snapshot from ogevia.shift_coverage_events where shift_id = $1 order by created_at", [id])).rows;
const reservation = async (id: string) => (await db.admin.query("select id, reserved_minutes, released_at from ogevia.authorization_reservations where shift_id = $1", [id])).rows;
const reservedTotal = async (f: Fx) => Number((await db.admin.query(
  "select coalesce(sum(r.reserved_minutes),0) n from ogevia.authorization_reservations r join ogevia.client_authorizations a on a.lineage_id = r.authorization_lineage_id where a.id = $1 and r.released_at is null", [f.auth])).rows[0].n);

describe("listing open shifts", () => {
  it("shows an open shift only to caregivers assigned to that client and service, with a client code and no name", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const mine = (await open(w.caregiverA1)).find((r) => r.shift_id === s);
    expect(mine).toMatchObject({ minutes: 120, coverage_state: "needs_coverage" });
    expect(mine.client_code).toBeTruthy();
    expect(Object.keys(mine)).not.toContain("client_name");
    expect((await open(w.caregiverA3)).find((r) => r.shift_id === s)).toBeUndefined();
    expect(await open(w.managerA)).toEqual([]);
    expect(await open(w.caregiverB1)).toEqual([]);
  });
});

describe("picking up an open shift", () => {
  it("assigns the same shift, keeps the reservation untouched, records who and how, and shows in My shifts", async () => {
    const f = await fixture();
    const s = await openShift(f, "09:00", "12:00");
    const resBefore = await reservation(s);
    const totalBefore = await reservedTotal(f);
    expect(await pick(w.caregiverA1, s)).toBe("covered");
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: rec["CG-A1"], caregiver_user_id: w.caregiverA1.userId, status: "scheduled" });
    expect(await reservation(s)).toEqual(resBefore); // same row, same minutes, still held
    expect(await reservedTotal(f)).toBe(totalBefore);
    const ev = await events(s);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "reassigned", reason: "Open shift picked up by caregiver" });
    expect(ev[0].after_snapshot).toMatchObject({ pickup: true, authorization_checked: true, reserved_minutes: 180 });
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'shift.picked_up'", [s])).rows[0].n).toBe(1);
    expect((await q(w.caregiverA1, "select * from ogevia_api.list_my_shifts($1)", [w.orgA])).find((r) => r.shift_id === s)).toMatchObject({ coverage_state: "covered" });
    expect((await open(w.caregiverA2)).find((r) => r.shift_id === s)).toBeUndefined();
    // The office sees the same shift, covered, one shift only.
    const list = await q(w.managerA, "select * from ogevia_api.list_shifts($1, $2::date, $3::date, null)", [w.orgA, day(-1), day(40)]);
    expect(list.filter((r) => r.shift_id === s)).toHaveLength(1);
    expect(list.find((r) => r.shift_id === s)).toMatchObject({ coverage_state: "covered", reserved_minutes: 180 });
  });

  it("two caregivers claiming at once: exactly one wins, the other is told it was just filled, one event is written", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const results = await Promise.allSettled([pick(w.caregiverA1, s), pick(w.caregiverA2, s)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.code).toBe("OGC09");
    expect(lost.reason.message).toMatch(/just filled/);
    const winner = (await shiftRow(s)).caregiver_record_id;
    expect([rec["CG-A1"], rec["CG-A2"]]).toContain(winner);
    expect(await events(s)).toHaveLength(1);
    expect(await reservation(s)).toHaveLength(1);
  });

  it("a retry with the same key, and a second tap with a new key, are not a second claim", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const key = randomUUID();
    expect(await pick(w.caregiverA1, s, key)).toBe("covered");
    expect(await pick(w.caregiverA1, s, key)).toBe("covered");
    expect(await pick(w.caregiverA1, s, randomUUID())).toBe("covered");
    expect(await events(s)).toHaveLength(1);
    await expectPgError(pick(w.caregiverA2, s), "OGC09", /just filled/);
  });

  it("refuses, saving nothing, when the client is not assigned to the caregiver", async () => {
    const f = await fixture();
    const s = await openShift(f);
    await expectPgError(pick(w.caregiverA3, s), "OGA03", /not assigned to you/);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await events(s)).toHaveLength(0);
  });

  it("refuses when the caregiver already has a shift at that time", async () => {
    const f = await fixture();
    const d = day(next++);
    const mine = await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'10:00','12:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A1"]]);
    expect(mine).toHaveLength(1);
    const s = await openShift(f, "11:00", "13:00", d);
    await expectPgError(pick(w.caregiverA1, s), "OGC09", /already|overlap|another shift/i);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
  });

  it("refuses a shift that is cancelled, one with a visit started, or a care-request shift; and a non-caregiver or other agency", async () => {
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

  it("is atomic: a refusal leaves the shift, its reservation and its history exactly as they were", async () => {
    const f = await fixture();
    const s = await openShift(f);
    const before = [await shiftRow(s), await reservation(s), await events(s)];
    await expectPgError(pick(w.caregiverA3, s), "OGA03");
    expect([await shiftRow(s), await reservation(s), await events(s)]).toEqual(before);
  });
});

describe("a called-out shift (O-1)", () => {
  it("the caregiver who called out may not pick it up again; another caregiver can; it stays one shift", async () => {
    const f = await fixture();
    const d = day(next++);
    const s = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, f.client, f.service, d, rec["CG-A1"]]))[0].shift_id as string;
    await q(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Synthetic: sick',null)", [w.orgA, s]);
    expect((await open(w.caregiverA1)).find((r) => r.shift_id === s)).toBeUndefined();
    await expectPgError(pick(w.caregiverA1, s), "OGC09", /You called out of this shift/);
    const o = (await open(w.caregiverA2)).find((r) => r.shift_id === s);
    expect(o).toMatchObject({ coverage_state: "needs_coverage" });
    const reservedBefore = await reservedTotal(f);
    expect(await pick(w.caregiverA2, s)).toBe("covered");
    expect(await reservedTotal(f)).toBe(reservedBefore);
    const ev = await events(s);
    expect(ev.map((e) => e.event_type)).toEqual(["called_out", "reassigned"]);
    expect(ev[1].reason).toBe("Replacement picked up by caregiver after call-out");
    expect((await q(w.managerA, "select * from ogevia_api.list_shifts($1, $2::date, $3::date, null)", [w.orgA, day(-1), day(40)])).filter((r) => r.shift_id === s)).toHaveLength(1);
  });
});

describe("authorization is re-checked when the claim is made (Q-R)", () => {
  it("refuses when an amendment has left the authorization below what is used plus reserved; the shift stays open and reserved", async () => {
    const f = await fixture(600); // 10 hours a month
    const s = await openShift(f, "09:00", "13:00"); // 4 hours reserved
    await api.amend(db, w.managerA, f.auth, 120, "Synthetic: lowered below the open shift"); // cap 2 hours < 4 reserved
    await expectPgError(pick(w.caregiverA1, s), "OGC09", /Authorization no longer covers this shift/);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await reservation(s)).toEqual([expect.objectContaining({ reserved_minutes: 240, released_at: null })]);
    expect(await events(s)).toHaveLength(0);
  });

  it("succeeds when the authorization still covers the shift exactly (reserved equals the cap)", async () => {
    const f = await fixture(240);
    const s = await openShift(f, "09:00", "13:00");
    expect(await pick(w.caregiverA1, s)).toBe("covered");
  });

  it("refuses when the shift has no reservation (the office must look at it)", async () => {
    const f = await fixture();
    const s = await openShift(f);
    await db.admin.query("update ogevia.authorization_reservations set released_at = now(), release_reason = 'synthetic' where shift_id = $1", [s]);
    await expectPgError(pick(w.caregiverA1, s), "OGC09", /no authorization reserved/);
  });
});
