// 0075 list_shifts says what happened to a shift: the display state is decided once, in the database. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, asReplica, createTestDb, endedVisit, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let fx: { client: string; service: string; auth: string };
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const list = (client: string, a: Actor = w.managerA) => as(a, "select * from ogevia_api.list_shifts($1,$2,$3,$4)", [w.orgA, day(-20), day(20), client]);
const stateOf = async (shift: string, client: string) => (await list(client)).find((s) => s.shift_id === shift)?.display_state as string | undefined;
async function park() {
  await asReplica(db, "update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Synthetic fixture' where caregiver_user_id = $1 and status in ('draft', 'awaiting_signature', 'administrator_review')", [w.caregiverA1.userId, w.managerA.userId]);
}
async function shiftAt(client: string, service: string, startHours: number, hours: number, status = "scheduled", caregiver: string | null = null) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    return (await c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,null,$4, now() + make_interval(secs => $5::numeric * 3600), now() + make_interval(secs => ($5::numeric + $6::numeric) * 3600), $7::ogevia.shift_status) returning id`,
      [w.orgA, client, service, caregiver, startHours, hours, status])).rows[0].id as string;
  } finally { await c.query("set session_replication_role = origin"); c.release(); }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 40, after: 200 });
});
afterAll(async () => db?.drop());

describe("what happened to a shift", () => {
  it("future shifts keep covered / needs coverage; cancelled and no-show come from the shift itself", async () => {
    const rec = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id as string;
    const open = await shiftAt(fx.client, fx.service, 30, 2);
    const covered = await shiftAt(fx.client, fx.service, 40, 2, "scheduled", rec);
    const cancelled = await shiftAt(fx.client, fx.service, 50, 2, "cancelled");
    const noShow = await shiftAt(fx.client, fx.service, -30, 2, "no_show");
    expect(await stateOf(open, fx.client)).toBe("needs_coverage");
    expect(await stateOf(covered, fx.client)).toBe("covered");
    expect(await stateOf(cancelled, fx.client)).toBe("cancelled");
    expect(await stateOf(noShow, fx.client)).toBe("no_show");
  });

  it("an ended shift with no visit is Missed until a person decides; each decision is then shown, the reservation stays reserved and nothing is released by the listing", async () => {
    const one = async () => {
      const id = await shiftAt(fx.client, fx.service, -10, 2);
      await asReplica(db, "insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes) select $1, a.lineage_id, null, $2, $3::date, 120 from ogevia.client_authorizations a where a.id = $4", [w.orgA, id, today, fx.auth]);
      return id;
    };
    const a = await one(), b = await one(), c = await one();
    for (const id of [a, b, c]) expect(await stateOf(id, fx.client)).toBe("missed");
    const rec = (shift: string, outcome: string) => as(w.managerA, "select ogevia_api.reconcile_ended_shift($1,$2,$3,'Checked with the family and caregiver (synthetic)',$4)", [w.orgA, shift, outcome, randomUUID()]);
    await rec(a, "no_service_delivered");
    await rec(b, "hold_service_may_have_occurred");
    await rec(c, "delivered_unverified");
    expect(await stateOf(a, fx.client)).toBe("not_delivered");
    expect(await stateOf(b, fx.client)).toBe("awaiting_record");
    expect(await stateOf(c, fx.client)).toBe("delivered_not_verified");
    const rows = await list(fx.client);
    expect(rows.find((s) => s.shift_id === c)).toMatchObject({ reconciliation_outcome: "delivered_unverified", visit_status: null });
    expect((await q("select count(*)::int n from ogevia.authorization_reservations where shift_id in ($1,$2) and released_at is null", [b, c])).rows[0].n).toBe(2); // still reserved
    expect((await q("select count(*)::int n from ogevia.authorization_reservations where shift_id = $1 and released_at is null", [a])).rows[0].n).toBe(0); // the person released it
  });

  it("a visit decides the state: in progress, verification pending, in review, completed, and partial only when worked time is short by more than the agency's rule", async () => {
    await park();
    const started = await api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service);
    let shiftOf = async (v: string) => (await q("select scheduled_shift_id s from ogevia.service_visits where id = $1", [v])).rows[0].s as string;
    expect(await stateOf(await shiftOf(started), fx.client)).toBe("in_progress");
    await ageVisit(db, started, 60);
    await api.end(db, w.caregiverA1, started);
    expect(await stateOf(await shiftOf(started), fx.client)).toBe("verification_pending");
    await park();
    const signed = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, fx.client, fx.service);
    const sh = await shiftOf(signed.visit);
    expect(await stateOf(sh, fx.client)).toBe("completed");
    // the shift was booked for 80 minutes but 60 were worked: short by 20, more than the 15-minute starting rule
    await asReplica(db, "update ogevia.shifts set ends_at = starts_at + interval '80 minutes' where id = $1", [sh]);
    expect(await stateOf(sh, fx.client)).toBe("partial");
    await asReplica(db, "update ogevia.shifts set ends_at = starts_at + interval '75 minutes' where id = $1", [sh]);
    expect(await stateOf(sh, fx.client)).toBe("completed"); // short by exactly 15: within the rule
    await park();
    const review = await endedVisit(db, w.caregiverA1, w, 45, w.orgA, fx.client, fx.service);
    await as(w.caregiverA1, "select * from ogevia_api.confirm_service_visit($1,'client','unable_to_confirm',null,null,null,'Client asleep; parent not home (synthetic)',null,'attest-v1')", [review]);
    expect(await stateOf(await shiftOf(review), fx.client)).toBe("in_review");
  });

  it("the older columns are unchanged, a caregiver is refused, and another agency sees nothing", async () => {
    const rows = await list(fx.client);
    expect(rows.length).toBeGreaterThan(3);
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining(["shift_id", "coverage_state", "client_code", "has_visit", "makeup_for_shift_id", "display_state", "scheduled_minutes"]));
    await expectPgError(list(fx.client, w.caregiverA1), "OGA03").catch(async () => { expect(await list(fx.client, w.caregiverA1)).toHaveLength(0); });
    expect(await as(w.managerB, "select * from ogevia_api.list_shifts($1,$2,$3,$4)", [w.orgB, day(-20), day(20), null]).then((r) => r.filter((s) => s.client_id === fx.client))).toHaveLength(0);
  });
});
