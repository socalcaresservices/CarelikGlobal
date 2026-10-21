// 0067: every reserved minute is shown; a shift that ended with no visit is reconciled by a person, never released automatically (owner request 2026-10-17,
// blockers 1 and 2). Approved definitions: committed = billable + approved rounding adjustments + reserved; over-limit is not clamped; a minute is counted once.
// SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, asReplica, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let monthStart: string;
let recA1: string;
type Fx = { client: string; service: string; auth: string };

const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const summaryFor = async (f: Fx, month = monthStart) => (await as(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1,$2::date,$3)", [w.orgA, month, f.client]))[0];
const overview = async (month = monthStart) => (await as(w.managerA, "select * from ogevia_api.get_utilisation_overview($1,$2::date)", [w.orgA, month])).find((r) => r.service_id === w.serviceA);
const list = () => as(w.managerA, "select * from ogevia_api.list_shifts_to_reconcile($1)", [w.orgA]);
const reconcile = (a: Actor, shift: string, outcome: string, note = "Checked the schedule and called the caregiver (synthetic)", key: string | null = randomUUID()) =>
  as(a, "select ogevia_api.reconcile_ended_shift($1,$2,$3,$4,$5) as r", [w.orgA, shift, outcome, note, key]).then((r) => r[0].r as Record<string, any>);
const reservation = async (shift: string) => (await q("select released_at, release_reason, reserved_minutes from ogevia.authorization_reservations where shift_id = $1", [shift])).rows[0];
const bucket = async (shift: string) => (await q("select ogevia.reservation_bucket(r.id) b from ogevia.authorization_reservations r where r.shift_id = $1", [shift])).rows[0].b as string | null;

/** A staff shift and its reservation (the shape create_shift writes), placed relative to now. */
async function reserved(f: Fx, startMin: number, minutes: number, caregiver: Actor | null = w.caregiverA1) {
  const rec = caregiver ? (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [caregiver.userId])).rows[0].id : null;
  const shift = (await q(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(mins => $6 + $7), 'scheduled', a.lineage_id
     from ogevia.client_authorizations a where a.id = $8 returning id`, [w.orgA, f.client, f.service, caregiver?.userId ?? null, rec, startMin, minutes, f.auth])).rows[0].id as string;
  await q(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
           select $1, a.lineage_id, null, $2, (starts_at at time zone 'America/Los_Angeles')::date, $3 from ogevia.client_authorizations a, ogevia.shifts s where a.id = $4 and s.id = $2`,
    [w.orgA, shift, minutes, f.auth]);
  return shift;
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  monthStart = `${today.slice(0, 7)}-01`;
  recA1 = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
});
afterAll(async () => db?.drop());

describe("every lifecycle stage of a reservation lands in exactly one bucket, and the buckets add up", () => {
  it("ahead, underway (started), visit open, held for review, and ended with no visit; reserved = the sum; authorized = billable + adjustments + reserved + remaining", async () => {
    // keep all five reservations in the current agency month whatever time of day/month the suite runs
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const ahead = await reserved(f, 24 * 60, 60, null);
    const started = await reserved(f, -30, 90, null);
    const ended = await reserved(f, -180, 45, null);
    // a visit that is open on its own shift (draft) -> underway
    const f2 = await freshClient(db, w, w.caregiverA2, 20000, w.orgA, { before: 40, after: 200 });
    const openShift = await reserved(f2, -5, 120, w.caregiverA2);
    const openVisit = await api.start(db, w.caregiverA2, w.orgA, f2.client, f2.service, null, null);
    expect((await q("select scheduled_shift_id from ogevia.service_visits where id = $1", [openVisit])).rows[0].scheduled_shift_id).toBe(openShift);
    // a visit in review with no billable minutes holds its reservation -> held_review
    const f3 = await freshClient(db, w, w.caregiverA3, 20000, w.orgA, { before: 40, after: 200 });
    const reviewShift = await reserved(f3, -5, 100, w.caregiverA3);
    const rv = await api.start(db, w.caregiverA3, w.orgA, f3.client, f3.service, null, null);
    await ageVisit(db, rv, 40);
    await api.end(db, w.caregiverA3, rv);
    await api.confirm(db, w.caregiverA3, rv, { method: "unable_to_confirm", reason: "Client asleep (synthetic)" });

    expect(await bucket(ahead)).toBe("ahead");
    expect(await bucket(started)).toBe("underway");
    expect(await bucket(ended)).toBe("unreconciled");
    expect(await bucket(openShift)).toBe("underway");
    expect(await bucket(reviewShift)).toBe("held_review");

    const s1 = await summaryFor(f);
    expect(s1).toMatchObject({ reserved_ahead_minutes: 60, reserved_underway_minutes: 90, reserved_review_minutes: 0, reserved_reconcile_minutes: 45, reserved_minutes: 195 });
    expect(s1.reserved_ahead_minutes + s1.reserved_underway_minutes + s1.reserved_review_minutes + s1.reserved_reconcile_minutes).toBe(s1.reserved_minutes);
    expect(s1.authorized_minutes).toBe(s1.billable_minutes + s1.adjustment_minutes + s1.reserved_minutes + s1.remaining_minutes);
    expect(await summaryFor(f2)).toMatchObject({ reserved_underway_minutes: 120, reserved_minutes: 120 });
    expect(await summaryFor(f3)).toMatchObject({ reserved_review_minutes: 100, reserved_minutes: 100 });
  });

  it("with approved rounding adjustments and an over-limit month: committed includes them, remaining is signed, the buckets still add up", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 200, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service);
    await reserved(f, 24 * 60, 120, null);
    await reserved(f, -30, 90, null); // started
    const lineage = (await q("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id;
    await q("set session_replication_role = replica");
    const policy = (await q(`insert into ogevia.billing_rounding_policies (organization_id, payer_key, payer_label, service_id, version, method, effective_from, reason, created_by)
       values ($1,'none-lc','None (synthetic)',$2,1,'none',$3,'Synthetic fixture',$4) returning id`, [w.orgA, f.service, monthStart, w.ownerA.userId])).rows[0].id;
    await q(`insert into ogevia.billing_rounding_adjustments (organization_id, unit_kind, authorization_lineage_id, client_id, service_id, service_date, policy_id,
         covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
       values ($1,'day',$2,$3,$4,$5::date,$6,$7::uuid[],60,75,15,false,$8)`, [w.orgA, lineage, f.client, f.service, today, policy, [v.visit], w.ownerA.userId]);
    await q("set session_replication_role = origin");
    const s = await summaryFor(f);
    expect(s).toMatchObject({ billable_minutes: 60, adjustment_minutes: 15, reserved_minutes: 210, committed_minutes: 285, remaining_minutes: -85, over_limit_minutes: 85 });
    expect(s.authorized_minutes).toBe(s.billable_minutes + s.adjustment_minutes + s.reserved_minutes + s.remaining_minutes);
    expect(s.reserved_ahead_minutes + s.reserved_underway_minutes + s.reserved_review_minutes + s.reserved_reconcile_minutes).toBe(s.reserved_minutes);
  });

  it("Home (utilisation overview), the monthly summary and the attention count agree: one ledger, one total", async () => {
    const o = await overview();
    const all = await as(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1,$2::date,null)", [w.orgA, monthStart]);
    const mine = all.filter((r) => r.service_id === w.serviceA);
    const sum = (k: string) => mine.reduce((t, r) => t + Number(r[k]), 0);
    expect(o.reserved_minutes).toBe(sum("reserved_minutes"));
    expect(o.scheduled_minutes).toBe(sum("reserved_ahead_minutes") + sum("reserved_underway_minutes"));
    expect(o.held_review_minutes).toBe(sum("reserved_review_minutes"));
    expect(o.needs_reconciliation_minutes).toBe(sum("reserved_reconcile_minutes"));
    expect(o.reserved_minutes).toBe(o.scheduled_minutes + o.held_review_minutes + o.needs_reconciliation_minutes);
    const att = (await as(w.managerA, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]))[0].o;
    expect(att.reconciliation).toMatchObject({ minutes: o.needs_reconciliation_minutes });
    const expectCount = (await q(`select count(*)::int n from ogevia.authorization_reservations r where r.released_at is null and ogevia.reservation_bucket(r.id) in ('unreconciled','awaiting_record')`)).rows[0].n;
    expect(att.reconciliation.count).toBe(expectCount);
  });
});

describe("nothing is released automatically", () => {
  it("an ended shift with no visit keeps its reservation through every read, sweep and scheduled function; history is untouched", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const ended = await reserved(f, -300, 60);
    const before = await reservation(ended);
    await list(); await overview(); await summaryFor(f);
    await as(w.managerA, "select ogevia_api.get_attention_overview($1,48)", [w.orgA]);
    const c = await db.admin.connect();
    try { await c.query("begin"); await c.query("set local role ogevia_app"); await c.query("select ogevia_api.system_compliance_orgs()"); await c.query("commit"); } finally { c.release(); }
    expect(await reservation(ended)).toEqual(before);
    expect(before).toMatchObject({ released_at: null });
    expect((await q("select count(*)::int n from ogevia.shift_reconciliations where shift_id = $1", [ended])).rows[0].n).toBe(0);
    expect((await list()).map((r) => r.shift_id)).toContain(ended);
  });
});

describe("reconciliation by a person", () => {
  it("'no service delivered' releases exactly that reservation, once, with the person, time and note; remaining rises by the minutes; retry with the same key returns the same answer", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const ended = await reserved(f, -240, 75);
    const before = await summaryFor(f);
    const key = randomUUID();
    const out = await reconcile(w.managerA, ended, "no_service_delivered", "Caregiver called out; client confirmed no visit (synthetic)", key);
    expect(out).toMatchObject({ outcome: "no_service_delivered", reservedMinutes: 75, released: true });
    expect(await reservation(ended)).toMatchObject({ release_reason: "reconciled_no_service", reserved_minutes: 75 });
    expect((await reservation(ended)).released_at).not.toBeNull();
    const dec = (await q("select outcome, note, decided_by, reserved_minutes from ogevia.shift_reconciliations where shift_id = $1", [ended])).rows;
    expect(dec).toEqual([{ outcome: "no_service_delivered", note: "Caregiver called out; client confirmed no visit (synthetic)", decided_by: w.managerA.userId, reserved_minutes: 75 }]);
    expect((await q("select count(*)::int n from ogevia.audit_events where entity_id = (select id from ogevia.authorization_reservations where shift_id = $1) and action = 'authorization_reservation.reconciled_released'", [ended])).rows[0].n).toBe(1);
    const after = await summaryFor(f);
    expect(after.remaining_minutes - before.remaining_minutes).toBe(75);
    expect(after.reserved_minutes - before.reserved_minutes).toBe(-75);
    expect(await reconcile(w.managerA, ended, "no_service_delivered", "Caregiver called out; client confirmed no visit (synthetic)", key)).toEqual(out); // same key: same answer, no second row
    expect((await q("select count(*)::int n from ogevia.shift_reconciliations where shift_id = $1", [ended])).rows[0].n).toBe(1);
    await expectPgError(reconcile(w.managerA, ended, "no_service_delivered"), "OGC09", /no open reservation/); // a new request after the release
    expect((await list()).map((r) => r.shift_id)).not.toContain(ended);
    await expectPgError(q("update ogevia.shift_reconciliations set note = 'x' where shift_id = $1", [ended]), undefined as never).catch(() => null);
    await expect(q("delete from ogevia.shift_reconciliations where shift_id = $1", [ended])).rejects.toThrow();
  });

  it("'cannot confirm' keeps the reservation counted and moves it to awaiting-record; a later 'no service' releases it; the same outcome twice is refused", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const ended = await reserved(f, -240, 50);
    const before = await summaryFor(f);
    await reconcile(w.managerA, ended, "hold_service_may_have_occurred", "Caregiver says she went; no clock record yet (synthetic)");
    expect(await bucket(ended)).toBe("awaiting_record");
    const mid = await summaryFor(f);
    expect(mid.reserved_minutes).toBe(before.reserved_minutes); // still counted
    expect(mid.reserved_reconcile_minutes).toBe(before.reserved_reconcile_minutes); // still in the reconcile bucket, now owned
    expect(await reservation(ended)).toMatchObject({ released_at: null });
    const row = (await list()).find((r) => r.shift_id === ended);
    expect(row).toMatchObject({ bucket: "awaiting_record", last_outcome: "hold_service_may_have_occurred" });
    await expectPgError(reconcile(w.managerA, ended, "hold_service_may_have_occurred", "Still checking the schedule today (synthetic)"), "OGC09", /already marked/);
    await reconcile(w.ownerA, ended, "no_service_delivered", "Confirmed with the client's parent that nobody came (synthetic)");
    expect(await reservation(ended)).toMatchObject({ release_reason: "reconciled_no_service" });
    expect((await q("select outcome from ogevia.shift_reconciliations where shift_id = $1 order by decided_at, id", [ended])).rows.map((r) => r.outcome)).toEqual(["hold_service_may_have_occurred", "no_service_delivered"]);
  });

  it("refuses a shift that has not ended, one with a visit, bad input, a caregiver, and another agency", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const future = await reserved(f, 120, 60);
    await expectPgError(reconcile(w.managerA, future, "no_service_delivered"), "OGC09", /ended with no visit record/);
    const f2 = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const withVisit = await reserved(f2, -5, 120, w.caregiverA1);
    const v = await api.start(db, w.caregiverA1, w.orgA, f2.client, f2.service, null, null);
    expect((await q("select scheduled_shift_id from ogevia.service_visits where id = $1", [v])).rows[0].scheduled_shift_id).toBe(withVisit);
    await asReplica(db, "update ogevia.shifts set starts_at = now() - interval '5 hours', ends_at = now() - interval '3 hours' where id = $1", [withVisit]); // the shift is over, its visit still open
    await expectPgError(reconcile(w.managerA, withVisit, "no_service_delivered"), "OGC09", /ended with no visit record/);
    const ended = await reserved(f, -240, 30);
    await expectPgError(reconcile(w.managerA, ended, "no_service_delivered", "short"), "OGV22", /at least 10/);
    await expectPgError(reconcile(w.managerA, ended, "release_it_anyway" as never), "OGV22", /Choose an outcome/);
    await expectPgError(reconcile(w.caregiverA1, ended, "no_service_delivered"), "OGA03");
    await expectPgError(as(w.managerB, "select ogevia_api.reconcile_ended_shift($1,$2,'no_service_delivered','Checked everything twice here',null)", [w.orgA, ended]), "OGN04");
    await expectPgError(as(w.caregiverA1, "select * from ogevia_api.list_shifts_to_reconcile($1)", [w.orgA]), "OGA03");
    expect(await reservation(ended)).toMatchObject({ released_at: null });
  });
});

describe("concurrency", () => {
  it("two offices reconciling one shift at once: exactly one decision is recorded and the minutes are released once", async () => {
    for (let round = 0; round < 5; round++) {
      const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
      const ended = await reserved(f, -240, 40);
      const res = await Promise.allSettled([reconcile(w.managerA, ended, "no_service_delivered"), reconcile(w.ownerA, ended, "no_service_delivered")]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of res) if (r.status === "rejected") expect((r.reason as { code?: string }).code).toBe("OGC09");
      expect((await q("select count(*)::int n from ogevia.shift_reconciliations where shift_id = $1", [ended])).rows[0].n).toBe(1);
      expect((await summaryFor(f)).reserved_minutes).toBe(0);
    }
  });
  it("reconciling while an amendment lowers the cap: no deadlock, and the final ledger is consistent", async () => {
    for (let round = 0; round < 4; round++) {
      const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
      const ended = await reserved(f, -240, 40);
      const res = await Promise.allSettled([reconcile(w.managerA, ended, "no_service_delivered"), api.amend(db, w.ownerA, f.auth, 10000, "Synthetic: amended while reconciling")]);
      for (const r of res) if (r.status === "rejected") expect((r.reason as { code?: string }).code, String((r.reason as Error).message)).not.toBe("40P01");
      const s = await summaryFor(f);
      expect(s.reserved_minutes).toBe(0);
      expect(s.authorized_minutes).toBe(10000);
    }
  });
});

describe("month boundaries and the agency month", () => {
  it("a shift that crosses midnight at month end is reserved, scheduled and reconciled in the month it STARTS (agency-local), and its minutes are never split across two months", async () => {
    // pick a month end inside the next 120 days; the shift starts 22:00 on the last local day of that month and ends 06:00 on the 1st
    const lastDay = (await q("select to_char((date_trunc('month', $1::date) + interval '2 months' - interval '1 day')::date, 'YYYY-MM-DD') d", [today])).rows[0].d as string;
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const made = (await as(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'22:00','06:00',null,null)", [w.orgA, f.client, f.service, lastDay]))[0];
    const month0 = `${lastDay.slice(0, 7)}-01`;
    const month1 = (await q("select to_char(($1::date + interval '1 month')::date, 'YYYY-MM-DD') d", [month0])).rows[0].d as string;
    expect(Number(made.reserved_minutes)).toBe(480);
    expect(await summaryFor(f, month0)).toMatchObject({ reserved_minutes: 480, reserved_ahead_minutes: 480 });
    expect(await summaryFor(f, month1)).toMatchObject({ reserved_minutes: 0 });
    expect((await q("select service_date::text d from ogevia.authorization_reservations where shift_id = $1", [made.shift_id])).rows[0].d).toBe(lastDay);
    // the same reservation is the one the Home overview reports for that month, and none for the next
    expect((await overview(month0)).reserved_minutes).toBeGreaterThanOrEqual(480);
    // rescheduling the shift into the next month moves the reservation with it
    const moved = (await as(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'09:00','11:00','Synthetic: moved to the next month',null)", [w.orgA, made.shift_id, month1]))[0];
    expect(Number(moved.reserved_minutes)).toBe(120);
    expect(await summaryFor(f, month0)).toMatchObject({ reserved_minutes: 0 });
    expect(await summaryFor(f, month1)).toMatchObject({ reserved_minutes: 120 });
  });
});

describe("lifecycle transitions of one reservation", () => {
  const setTimes = (shift: string, startMin: number, endMin: number) =>
    asReplica(db, "update ogevia.shifts set starts_at = now() + make_interval(mins => $2), ends_at = now() + make_interval(mins => $3) where id = $1", [shift, startMin, endMin]);

  it("ahead -> underway -> ended with no visit -> (held, then released by a person); every step is counted once and nothing releases by itself", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const s = await reserved(f, 24 * 60, 60, null);
    const steps: Array<[string, number, number, string]> = [["ahead", 600, 660, "ahead"], ["underway", -10, 50, "underway"], ["ended", -120, -60, "unreconciled"]];
    for (const [, a, b, expected] of steps) {
      await setTimes(s, a, b);
      expect(await bucket(s)).toBe(expected);
      const sm = await summaryFor(f);
      expect(sm.reserved_minutes).toBe(60); // counted exactly once at every step
      expect(sm.reserved_ahead_minutes + sm.reserved_underway_minutes + sm.reserved_review_minutes + sm.reserved_reconcile_minutes).toBe(60);
      expect((await reservation(s)).released_at).toBeNull();
    }
    await reconcile(w.managerA, s, "hold_service_may_have_occurred", "Waiting to hear back from the family (synthetic)");
    expect(await bucket(s)).toBe("awaiting_record");
    expect((await summaryFor(f)).reserved_minutes).toBe(60);
    await reconcile(w.managerA, s, "no_service_delivered", "Family confirmed nobody came (synthetic)");
    expect(await bucket(s)).toBeNull();
    expect((await summaryFor(f)).reserved_minutes).toBe(0);
  });

  it("underway shift -> visit started (open) -> ended -> signed: the reservation becomes used time exactly once", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 20000, w.orgA, { before: 40, after: 200 });
    const s = await reserved(f, 24 * 60, 120, w.caregiverA3);
    await setTimes(s, -5, 115);
    expect(await bucket(s)).toBe("underway");
    const v = await api.start(db, w.caregiverA3, w.orgA, f.client, f.service, null, null);
    expect(await bucket(s)).toBe("underway"); // open visit: still reserved, still underway
    await ageVisit(db, v, 45);
    await api.end(db, w.caregiverA3, v);
    expect(await bucket(s)).toBe("held_review"); // ended, awaiting the client's confirmation: still reserved, now held
    const before = await summaryFor(f);
    expect(before).toMatchObject({ billable_minutes: 0, reserved_minutes: 120, reserved_review_minutes: 120 });
    const evidence = await api.registerEvidence(db, w.caregiverA3, w.orgA, v);
    await api.confirm(db, w.caregiverA3, v, { evidence });
    expect(await bucket(s)).toBeNull();
    const after = await summaryFor(f);
    expect(after).toMatchObject({ billable_minutes: 45, reserved_minutes: 0, reserved_reconcile_minutes: 0 });
    expect(after.authorized_minutes).toBe(after.billable_minutes + after.adjustment_minutes + after.reserved_minutes + after.remaining_minutes);
  });

  it("cancelled shift: released by the existing rule (unchanged). A called-out shift that then ends with no visit is listed for reconciliation, not dropped", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const gone = await reserved(f, 24 * 60, 60, null);
    await as(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic: client unwell',null)", [w.orgA, gone]);
    expect(await bucket(gone)).toBeNull();
    const calledOut = await reserved(f, 24 * 60, 60, w.caregiverA1);
    await as(w.caregiverA1, "select ogevia_api.call_out_my_shift($1,$2,'Synthetic: sick',null)", [w.orgA, calledOut]);
    expect(await bucket(calledOut)).toBe("ahead"); // still reserved: a replacement is expected
    await setTimes(calledOut, -120, -60);
    expect(await bucket(calledOut)).toBe("unreconciled");
    expect((await list()).map((r) => r.shift_id)).toContain(calledOut);
  });

  it("a signed visit's correction does not bring the released reservation back (history), and the shift never re-enters the reconcile list", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 20000, w.orgA, { before: 40, after: 200 });
    const s = await reserved(f, 24 * 60, 90, w.caregiverA3);
    await setTimes(s, -5, 85);
    const v = await api.start(db, w.caregiverA3, w.orgA, f.client, f.service, null, null);
    await ageVisit(db, v, 40);
    await api.end(db, w.caregiverA3, v);
    await api.confirm(db, w.caregiverA3, v, { evidence: await api.registerEvidence(db, w.caregiverA3, w.orgA, v) });
    expect(await bucket(s)).toBeNull();
    await as(w.managerA, "select ogevia_api.correct_service_visit($1, now() - interval '300 minutes', now() - interval '250 minutes', 'Synthetic: times corrected', $2) as id", [v, randomUUID()]);
    expect(await bucket(s)).toBeNull();
    expect((await list()).map((r) => r.shift_id)).not.toContain(s);
  });
});

describe("delivered but not verified (0071)", () => {
  it("a person's attestation that the service was delivered keeps it reserved, counted and visible; it creates no visit, no verification and nothing billable, and releases nothing", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const s = await reserved(f, -300, 70, null);
    const before = await summaryFor(f);
    const visitsBefore = (await q("select count(*)::int n from ogevia.service_visits where client_id = $1", [f.client])).rows[0].n;
    await reconcile(w.managerA, s, "delivered_unverified", "Caregiver and family both say the visit happened; no clock record (synthetic)");
    expect(await bucket(s)).toBe("awaiting_record");
    const after = await summaryFor(f);
    expect(after).toMatchObject({ reserved_minutes: before.reserved_minutes, reserved_reconcile_minutes: before.reserved_reconcile_minutes, billable_minutes: before.billable_minutes, remaining_minutes: before.remaining_minutes });
    expect((await reservation(s)).released_at).toBeNull();
    expect((await q("select count(*)::int n from ogevia.service_visits where client_id = $1", [f.client])).rows[0].n).toBe(visitsBefore); // no visit invented
    expect((await q("select count(*)::int n from ogevia.billing_approvals a join ogevia.service_visits v on v.id = a.visit_id where v.client_id = $1", [f.client])).rows[0].n).toBe(0);
    const row = (await list()).find((r) => r.shift_id === s);
    expect(row).toMatchObject({ bucket: "awaiting_record", last_outcome: "delivered_unverified" });
    // nothing releases it on its own: every read, the overview and the attention count leave it as it is
    await overview(); await summaryFor(f); await as(w.managerA, "select ogevia_api.get_attention_overview($1,48)", [w.orgA]);
    expect((await reservation(s)).released_at).toBeNull();
    // the same attestation twice is refused; a caregiver cannot make it
    await expectPgError(reconcile(w.managerA, s, "delivered_unverified", "Checked again and nothing changed here (synthetic)"), "OGC09", /already marked/);
    await expectPgError(reconcile(w.caregiverA1, s, "delivered_unverified"), "OGA03");
  });

  it("releasing it later is a new, audited decision that records it superseded a delivered attestation; both decisions stay on record", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const s = await reserved(f, -300, 40, null);
    await reconcile(w.managerA, s, "delivered_unverified", "Caregiver says the visit happened (synthetic)");
    await reconcile(w.ownerA, s, "no_service_delivered", "Family now says nobody came; the caregiver withdrew the claim (synthetic)");
    expect((await q("select outcome from ogevia.shift_reconciliations where shift_id = $1 order by decided_at, id", [s])).rows.map((r) => r.outcome)).toEqual(["delivered_unverified", "no_service_delivered"]);
    const audit = (await q("select after_state from ogevia.audit_events where action = 'authorization_reservation.reconciled_released' and (after_state ->> 'shift_id') = $1", [s])).rows[0];
    expect(audit.after_state).toMatchObject({ supersedes_delivered_attestation: true });
    expect(await bucket(s)).toBeNull();
  });
});
