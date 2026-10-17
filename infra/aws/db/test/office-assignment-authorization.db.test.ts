// 0065: office assignment (assign_shift_caregiver) re-checks authorization capacity atomically with the other eligibility checks, under the same locks,
// with a database backstop for writers that skip the API function (owner request 2026-10-17, item 1). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const rec: Record<string, string> = {};
let next = 2;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 100000);
  today = await orgToday(db);
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
});
afterAll(async () => db?.drop());

const q = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
type Fx = { client: string; service: string; auth: string };
const fixture = (minutes: number) => freshClient(db, w, w.caregiverA1, minutes, w.orgA, { before: 40, after: 40 });
const openShift = (f: Fx, start = "09:00", end = "13:00", d = day(next++)) =>
  q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, d, start, end]).then((r) => r[0].shift_id as string);
const assign = (a: Actor, shift: string, cg: string, reason: string | null = "Synthetic office fill") =>
  q(a, "select ogevia_api.assign_shift_caregiver($1,$2,$3,$4,$5) as s", [w.orgA, shift, cg, reason, randomUUID()]).then((r) => r[0].s as string);
const shiftRow = async (id: string) => (await db.admin.query("select caregiver_record_id, status from ogevia.shifts where id = $1", [id])).rows[0];
const events = async (id: string) => (await db.admin.query("select event_type from ogevia.shift_coverage_events where shift_id = $1 order by created_at", [id])).rows;

describe("office assignment re-checks the authorization", () => {
  it("an amendment that lowered the cap below used + reserved refuses the assignment; the shift stays open and reserved, nothing is written", async () => {
    const f = await fixture(600); // 10 h a month
    const s = await openShift(f, "09:00", "13:00"); // 4 h reserved
    await api.amend(db, w.managerA, f.auth, 120, "Synthetic: lowered below the open shift"); // 2 h cap < 4 h reserved
    await expectPgError(assign(w.managerA, s, rec["CG-A1"]!), "OGC09", /Authorization no longer covers this shift/);
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    expect(await events(s)).toHaveLength(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'shift.caregiver_assigned'", [s])).rows[0].n).toBe(0);
    expect((await db.admin.query("select reserved_minutes, released_at from ogevia.authorization_reservations where shift_id = $1", [s])).rows).toEqual([{ reserved_minutes: 240, released_at: null }]);
  });
  it("exactly covered succeeds; a shift whose reservation was released is refused (the office must look at it)", async () => {
    const f = await fixture(240);
    const s = await openShift(f, "09:00", "13:00");
    expect(await assign(w.managerA, s, rec["CG-A1"]!)).toBe("covered");
    const g = await fixture(20000);
    const t = await openShift(g);
    await db.admin.query("update ogevia.authorization_reservations set released_at = now(), release_reason = 'synthetic' where shift_id = $1", [t]);
    await expectPgError(assign(w.managerA, t, rec["CG-A1"]!), "OGC09", /no authorization reserved/);
  });
  it("a replacement after a call-out is held to it too, and the replacement is refused with the same message", async () => {
    const f = await fixture(600);
    const s = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','13:00',$5,null)", [w.orgA, f.client, f.service, day(next++), rec["CG-A1"]]))[0].shift_id as string;
    await q(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Synthetic: sick',null)", [w.orgA, s]);
    await api.amend(db, w.managerA, f.auth, 120, "Synthetic: lowered after the call-out");
    await expectPgError(assign(w.managerA, s, rec["CG-A2"]!, "Replacement"), "OGC09", /Authorization no longer covers/);
    expect((await shiftRow(s)).caregiver_record_id).toBe(rec["CG-A1"]); // still the old caregiver on the row, still needing coverage
  });
});

describe("it is atomic with the other eligibility checks and safe under concurrency", () => {
  it("an assignment racing an amendment never commits against a cap that was already lowered, and nothing deadlocks", async () => {
    for (let round = 0; round < 6; round++) {
      const f = await fixture(600);
      const s = await openShift(f, "09:00", "13:00");
      const res = await Promise.allSettled([
        assign(w.managerA, s, rec["CG-A1"]!),
        api.amend(db, w.ownerA, f.auth, 120, "Synthetic: lowered at the same moment"),
      ]);
      for (const r of res) if (r.status === "rejected") expect((r.reason as { code?: string }).code, String((r.reason as Error).message)).not.toBe("40P01"); // no deadlock
      const assigned = (await shiftRow(s)).caregiver_record_id !== null;
      const amended = res[1]!.status === "fulfilled";
      const assignOk = res[0]!.status === "fulfilled";
      expect(assigned).toBe(assignOk);
      if (!assigned) expect((res[0] as PromiseRejectedResult).reason.code).toBe("OGC09"); // refused because the cap was lowered first
      expect(amended || assigned).toBe(true);
    }
  });
  it("six different shifts assigned at once to six different eligible moments all commit (no false conflicts), each exactly once", async () => {
    const f = await fixture(100000);
    const shifts: string[] = [];
    for (let i = 0; i < 4; i++) shifts.push(await openShift(f, "09:00", "11:00", day(next++)));
    const cgs = [rec["CG-A1"]!, rec["CG-A2"]!, rec["CG-A3"]!, rec["CG-A1"]!];
    const res = await Promise.allSettled(shifts.map((s, i) => assign(i % 2 ? w.managerA : w.ownerA, s, cgs[i]!)));
    expect(res.every((r) => r.status === "fulfilled"), JSON.stringify(res.map((r) => (r.status === "rejected" ? (r.reason as Error).message : "ok")))).toBe(true);
    for (const [i, s] of shifts.entries()) expect((await shiftRow(s)).caregiver_record_id).toBe(cgs[i]);
    for (const s of shifts) expect(await events(s)).toHaveLength(1);
  });
  it("two offices assigning two different caregivers to the same open shift: one assignment, then one replacement that needs a reason; one caregiver on the shift at the end", async () => {
    const f = await fixture(100000);
    const s = await openShift(f);
    const res = await Promise.allSettled([assign(w.managerA, s, rec["CG-A1"]!, "A"), assign(w.ownerA, s, rec["CG-A2"]!, "B")]);
    expect(res.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect([rec["CG-A1"], rec["CG-A2"]]).toContain((await shiftRow(s)).caregiver_record_id);
    expect((await db.admin.query("select count(*)::int n from ogevia.authorization_reservations where shift_id = $1 and released_at is null", [s])).rows[0].n).toBe(1);
  });
});

describe("API bypass: writing the caregiver another way is refused by the database", () => {
  it("a direct update that would assign past the authorization is refused; one that fits is allowed; unrelated updates are not blocked; the application role cannot write at all", async () => {
    const f = await fixture(600);
    const s = await openShift(f, "09:00", "13:00");
    await api.amend(db, w.managerA, f.auth, 120, "Synthetic: lowered below the open shift");
    await expect(db.admin.query("update ogevia.shifts set caregiver_record_id = $2 where id = $1", [s, rec["CG-A1"]])).rejects.toMatchObject({ code: "OGC09" });
    expect(await shiftRow(s)).toMatchObject({ caregiver_record_id: null });
    await db.admin.query("update ogevia.shifts set updated_at = now() where id = $1", [s]); // unrelated update
    const g = await fixture(20000);
    const t = await openShift(g);
    await db.admin.query("update ogevia.shifts set caregiver_record_id = $2 where id = $1", [t, rec["CG-A1"]]); // covered: allowed
    await expect(asActor(db, w.caregiverA1.sub, (c) => c.query("update ogevia.shifts set caregiver_record_id = $2 where id = $1", [s, rec["CG-A1"]]))).rejects.toThrow(/permission denied/i);
  });
});
