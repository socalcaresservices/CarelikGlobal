// 0082 Authorization-lineage lock on every path that changes consumed minutes. SYNTHETIC data only.
//
// The scheduling guards (create/reschedule/series/make-up/assign/pickup/care request) read "used + reserved + pending" under ogevia.lock_authorization_lineage and
// then write a reservation. Before 0082, end_service_visit, close_missed_service_visit, void_service_visit, decide_visit_review, revoke_visit_review_decision and
// void_billing_rounding_adjustment changed what those guards read WITHOUT that lock, so a guard could run its read while one of them had already executed its write
// but not yet committed (an unrefusable write that the guard then could not see).
//
// Real two-connection test: connection A runs the writer inside an open transaction and a test-only trigger (installed in this disposable database only) pauses it
// AFTER its write and BEFORE its commit; connection B then starts the scheduling operation. With the lock, B waits for A and sees the committed result; without it B
// reads stale minutes. Each order is exercised. A second part runs many random interleavings (random pause on either side, random start offsets).
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let tomorrow: string;
let sameMonth: boolean;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  tomorrow = (await db.admin.query<{ d: string }>("select to_char($1::date + 1, 'YYYY-MM-DD') d", [today])).rows[0]!.d;
  sameMonth = tomorrow.slice(0, 7) === today.slice(0, 7);
  // TEST-ONLY pause hook (this disposable database only): sleeps when the session set test.race_sleep_ms, after the write and before the commit.
  await db.admin.query(`
    create function public.test_race_pause() returns trigger language plpgsql as $$
    declare v text := current_setting('test.race_sleep_ms', true);
    begin
      if coalesce(v, '') <> '' and v::numeric > 0 then perform pg_sleep(v::numeric / 1000.0); end if;
      return null;
    end $$;`);
  for (const [table, ev] of [["service_visits", "update"], ["authorization_reservations", "insert or update"], ["visit_review_decisions", "insert or update"],
                             ["billing_rounding_adjustments", "update"]] as const) {
    await db.admin.query(`create trigger zz_test_race_pause after ${ev} on ogevia.${table} for each row execute function public.test_race_pause()`);
  }
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string; auth: string; cg: Actor; lineage: string; authorized: number };
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
async function person(): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Pat Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, userId]);
  await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Pat')", [w.orgA, userId, "CG-" + sub.slice(0, 6)]);
  await db.admin.query(`insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at)
    select r.id, r.organization_id, 'completed', 'approved', 'Synthetic fixture clearance', $2, now() from ogevia.caregiver_records r where r.linked_user_id = $1 and r.organization_id = $3`, [userId, w.ownerA.userId, w.orgA]);
  return { userId, sub };
}
async function fx(minutes: number): Promise<Fx> {
  const cg = await person();
  const f = await freshClient(db, w, cg, minutes);
  const lineage = (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id as string;
  return { ...f, cg, lineage, authorized: minutes };
}
const hhmm = (startMin: number, minutes: number) => {
  const f = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [f(startMin), f(startMin + minutes)] as const;
};
const monthStart = () => `${today.slice(0, 7)}-01`;
const summary = async (f: Fx) => (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, monthStart(), f.client]))[0];
const equation = (s: any) => s.hours_billable_minutes + s.hours_rounding_minutes + s.hours_pending_minutes + s.hours_reserved_minutes + s.hours_left_minutes;
/** Everything that is committed against the month, exactly as the guards read it (used + reserved incl. unreserved pending). */
const consumed = async (f: Fx) =>
  Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) + ogevia.authorization_month_reserved($1, $2::date) n", [f.lineage, tomorrow])).rows[0].n);

// --- two explicit connections ------------------------------------------------------------------------------------------------------------------------------
interface Sess { c: pg.PoolClient; pid: number; run: (sql: string, params?: unknown[]) => Promise<any[]>; commit: () => Promise<void>; rollback: () => Promise<void> }
async function open(a: Actor, pauseMs = 0): Promise<Sess> {
  const c = await db.admin.connect();
  await c.query("begin");
  await c.query("set local role ogevia_app");
  await c.query("select ogevia_api.begin_request($1, $2)", [a.sub, randomUUID()]);
  if (pauseMs > 0) await c.query("select set_config('test.race_sleep_ms', $1, true)", [String(pauseMs)]);
  const pid = (await c.query("select pg_backend_pid() pid")).rows[0].pid as number;
  return {
    c, pid,
    run: async (sql, params = []) => (await c.query(sql, params)).rows as any[],
    commit: async () => { await c.query("commit"); c.release(); },
    rollback: async () => { await c.query("rollback").catch(() => {}); c.release(); },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitPaused(pid: number) {
  for (let i = 0; i < 200; i++) {
    const r = await db.admin.query("select 1 from pg_stat_activity where pid = $1 and wait_event = 'PgSleep'", [pid]);
    if (r.rowCount) return;
    await sleep(10);
  }
  throw new Error("the writer never reached its pause point");
}
const waitsOnAdvisoryLock = async (pid: number) => {
  for (let i = 0; i < 40; i++) {
    const r = await db.admin.query("select 1 from pg_locks where pid = $1 and locktype = 'advisory' and not granted", [pid]);
    if (r.rowCount) return true;
    await sleep(10);
  }
  return false;
};
const settle = async <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, error }));

const SQL = {
  end: "select * from ogevia_api.end_service_visit($1)",
  createShift: "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,$7)",
  void: "select ogevia_api.void_service_visit($1, 'Synthetic: entered in error')",
  close: "select ogevia_api.decide_visit_review($1, 'close_not_billable', 'Not a valid visit (synthetic)', null) id",
  revoke: "select ogevia_api.revoke_visit_review_decision($1, 'Synthetic: reopened for another look', null) id",
  closeMissed: "select * from ogevia_api.close_missed_service_visit($1, now(), 'Caregiver forgot to end the visit (synthetic)', null)",
  voidRound: "select ogevia_api.void_billing_rounding_adjustment($1, 'Synthetic: rounding entered in error', null) id",
};
const shiftArgs = (f: Fx, minutes: number, day = tomorrow, startMin = 9 * 60) => {
  const [s, e] = hhmm(startMin, minutes);
  return [w.orgA, f.client, f.service, day, s, e, randomUUID()];
};
async function unscheduledEnded(f: Fx, worked: number, how: "awaiting" | "review" = "awaiting") {
  const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, "Client asked for extra help (synthetic)");
  await ageVisit(db, v, worked);
  await api.end(db, f.cg, v);
  if (how === "review") await api.confirm(db, f.cg, v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  return v;
}
const decisionOf = async (visit: string) => (await db.admin.query("select id from ogevia.visit_review_decisions where visit_id = $1 and revoked_at is null", [visit])).rows[0]?.id as string;
const shiftCount = async (f: Fx) => Number((await db.admin.query("select count(*) n from ogevia.shifts where client_id = $1", [f.client])).rows[0].n);
const skipUnlessSameMonth = (ctx: { skip: () => void }) => { if (!sameMonth) ctx.skip(); };

/** A (writer) pauses after its write inside an open transaction; B (scheduling) starts only then. Returns both outcomes after A commits. */
async function writerThenScheduler(f: Fx, writer: { actor: Actor; sql: string; params: unknown[] }, shiftMinutes: number) {
  const A = await open(writer.actor, 700);
  const pa = settle(A.run(writer.sql, writer.params));
  await waitPaused(A.pid); // A has done its write and holds its transaction open
  const B = await open(w.managerA);
  const pb = settle(B.run(SQL.createShift, shiftArgs(f, shiftMinutes)));
  const blocked = await waitsOnAdvisoryLock(B.pid); // true when B is queued behind A's lineage lock
  const ra = await pa;
  if (ra.ok) await A.commit(); else await A.rollback();
  const rb = await pb;
  if (rb.ok) await B.commit(); else await B.rollback();
  return { ra, rb, blocked };
}
/** B (scheduling) pauses after its reservation insert inside an open transaction; A (writer) starts then. */
async function schedulerThenWriter(f: Fx, writer: { actor: Actor; sql: string; params: unknown[] }, shiftMinutes: number) {
  const B = await open(w.managerA, 700);
  const pb = settle(B.run(SQL.createShift, shiftArgs(f, shiftMinutes)));
  await waitPaused(B.pid);
  const A = await open(writer.actor);
  const pa = settle(A.run(writer.sql, writer.params));
  const blocked = await waitsOnAdvisoryLock(A.pid);
  const rb = await pb;
  if (rb.ok) await B.commit(); else await B.rollback();
  const ra = await pa;
  if (ra.ok) await A.commit(); else await A.rollback();
  return { ra, rb, blocked };
}

describe("a writer that has already changed consumed minutes (not yet committed) is seen by the scheduling guard: nothing is promised twice", () => {
  it("end_service_visit then create_shift: authorized 600, an unscheduled 45-minute visit ends (uncommitted); a 600-minute shift is REFUSED, not promised on top (committed total 45, never 645)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, "Client asked for extra help (synthetic)");
    await ageVisit(db, v, 45);
    const r = await writerThenScheduler(f, { actor: f.cg, sql: SQL.end, params: [v] }, 600);
    expect(r.ra.ok).toBe(true);
    expect(r.rb.ok, "the shift must not be created on top of the ended visit").toBe(false);
    expect((r.rb as any).error.code).toBe("OGC09");
    expect(r.blocked).toBe(true);
    expect(await shiftCount(f)).toBe(0);
    expect(await consumed(f)).toBe(45);
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 45, hours_left_minutes: 555, hours_over_limit_minutes: 0 });
    expect(equation(s)).toBe(600);
  });

  it("revoke_visit_review_decision (reopen) then create_shift: a visit closed as not billable (Pending 0, left 600) is reopened (uncommitted): a 600-minute shift is refused, total 45", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await unscheduledEnded(f, 45, "review");
    await q(w.managerA, SQL.close, [v]);
    expect(await summary(f)).toMatchObject({ hours_pending_minutes: 0, hours_left_minutes: 600 });
    const r = await writerThenScheduler(f, { actor: w.managerA, sql: SQL.revoke, params: [await decisionOf(v)] }, 600);
    expect(r.ra.ok).toBe(true);
    expect(r.rb.ok).toBe(false);
    expect((r.rb as any).error.code).toBe("OGC09");
    expect(r.blocked).toBe(true);
    expect(await shiftCount(f)).toBe(0);
    expect(await consumed(f)).toBe(45);
    expect(equation(await summary(f))).toBe(600);
  });

  it("close_missed_service_visit then create_shift: a manager closes a forgotten open visit of 45 minutes (uncommitted); a 600-minute shift is refused", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, "Client asked for extra help (synthetic)");
    await ageVisit(db, v, 45);
    const r = await writerThenScheduler(f, { actor: w.managerA, sql: SQL.closeMissed, params: [v] }, 600);
    expect(r.ra.ok, r.ra.ok ? "" : (r.ra as any).error.message).toBe(true);
    expect(r.rb.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(await consumed(f)).toBe(45);
  });

  it("decrease paths are exact, not stale: close_not_billable, void_service_visit and void_billing_rounding_adjustment release minutes (uncommitted); a shift that needs them WAITS and then fits", async (ctx) => {
    skipUnlessSameMonth(ctx);
    // close as not billable (unscheduled, in review): Pending 45 -> 0
    const f1 = await fx(600);
    const v1 = await unscheduledEnded(f1, 45, "review");
    const r1 = await writerThenScheduler(f1, { actor: w.managerA, sql: SQL.close, params: [v1] }, 600);
    expect(r1.ra.ok).toBe(true);
    expect(r1.blocked).toBe(true);
    expect(r1.rb.ok, r1.rb.ok ? "" : (r1.rb as any).error.message).toBe(true);
    expect(await consumed(f1)).toBe(600);
    // void an ended visit awaiting confirmation: Pending 45 -> 0
    const f2 = await fx(600);
    const v2 = await unscheduledEnded(f2, 45, "awaiting");
    const r2 = await writerThenScheduler(f2, { actor: w.managerA, sql: SQL.void, params: [v2] }, 600);
    expect(r2.ra.ok).toBe(true);
    expect(r2.blocked).toBe(true);
    expect(r2.rb.ok, r2.rb.ok ? "" : (r2.rb as any).error.message).toBe(true);
    expect(await consumed(f2)).toBe(600);
    // void a rounding adjustment of +10 on a signed 50: left 540 -> 550
    const f3 = await fx(600);
    const v3 = await api.start(db, f3.cg, w.orgA, f3.client, f3.service, null, "Client asked for extra help (synthetic)");
    await ageVisit(db, v3, 50);
    await api.end(db, f3.cg, v3);
    await api.confirm(db, f3.cg, v3, { method: "draw", evidence: await api.registerEvidence(db, f3.cg, w.orgA, v3) });
    const adj = randomUUID();
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query(
        `insert into ogevia.billing_rounding_adjustments (id, organization_id, unit_kind, visit_id, authorization_lineage_id, client_id, service_id, service_date, policy_id,
           covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
         values ($9,$1,'visit',$2,$3,$4,$5,$6::date,$7,array[$2::uuid],50,60,10,false,$8)`,
        [w.orgA, v3, f3.lineage, f3.client, f3.service, today, randomUUID(), w.managerA.userId, adj]);
    } finally { await c.query("reset session_replication_role"); c.release(); }
    expect(await summary(f3)).toMatchObject({ hours_rounding_minutes: 10, hours_left_minutes: 540 });
    const r3 = await writerThenScheduler(f3, { actor: w.managerA, sql: SQL.voidRound, params: [adj] }, 550);
    expect(r3.ra.ok, r3.ra.ok ? "" : (r3.ra as any).error.message).toBe(true);
    expect(r3.blocked).toBe(true);
    expect(r3.rb.ok, r3.rb.ok ? "" : (r3.rb as any).error.message).toBe(true);
    expect(await consumed(f3)).toBe(600);
  });

  it("the reverse order cannot hide minutes either: a 555-minute shift in flight (uncommitted) makes the closing/voiding/reopening wait for it, then everything adds up (equation exact)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await unscheduledEnded(f, 45, "review");
    await q(w.managerA, SQL.close, [v]);
    const r = await schedulerThenWriter(f, { actor: w.managerA, sql: SQL.revoke, params: [await decisionOf(v)] }, 555);
    expect(r.rb.ok, r.rb.ok ? "" : (r.rb as any).error.message).toBe(true);
    expect(r.ra.ok).toBe(true);
    expect(r.blocked).toBe(true);
    // 555 scheduled + 45 reopened = 600: exact, not over
    expect(await consumed(f)).toBe(600);
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 45, hours_reserved_minutes: 555, hours_left_minutes: 0, hours_over_limit_minutes: 0 });
    expect(equation(s)).toBe(600);
  });

  it("work that was already under way is never refused: a 600-minute shift commits first, then the unscheduled visit ends: the visit is recorded and the agency reads Over limit 45 (not a guard failure)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, "Client asked for extra help (synthetic)");
    await ageVisit(db, v, 45);
    const r = await schedulerThenWriter(f, { actor: f.cg, sql: SQL.end, params: [v] }, 600);
    expect(r.rb.ok).toBe(true); // an unscheduled visit that is still a draft consumes nothing yet (0081 definition, unchanged)
    expect(r.ra.ok, r.ra.ok ? "" : (r.ra as any).error.message).toBe(true); // ending real work is never refused
    expect(r.blocked).toBe(true); // it waited for the in-flight scheduling operation instead of racing it
    const s = await summary(f);
    expect(s).toMatchObject({ hours_pending_minutes: 45, hours_reserved_minutes: 600, hours_over_limit_minutes: 45 });
    expect(await consumed(f)).toBe(645);
  });

  it("confirm_service_visit (already locked) and create_shift in both orders: the 45 minutes move from Pending to Billable and are counted once (45 + 555 = 600)", async (ctx) => {
    skipUnlessSameMonth(ctx);
    for (const order of ["writerFirst", "schedulerFirst"] as const) {
      const f = await fx(600);
      const v = await unscheduledEnded(f, 45, "awaiting");
      const evidence = await api.registerEvidence(db, f.cg, w.orgA, v);
      const confirm = { actor: f.cg, sql: "select * from ogevia_api.confirm_service_visit($1,'client','draw',$2,null,null,null,null,null)", params: [v, evidence] };
      const r = order === "writerFirst" ? await writerThenScheduler(f, confirm, 555) : await schedulerThenWriter(f, confirm, 555);
      expect(r.ra.ok, r.ra.ok ? "" : (r.ra as any).error.message).toBe(true);
      expect(r.rb.ok, r.rb.ok ? "" : (r.rb as any).error.message).toBe(true);
      expect(await consumed(f)).toBe(600);
      const sm = await summary(f);
      expect(sm.hours_billable_minutes + sm.hours_pending_minutes).toBe(45); // an unscheduled visit is confirmed into review: its 45 minutes are Pending (carried), once
      expect(sm).toMatchObject({ hours_reserved_minutes: 555, hours_left_minutes: 0, hours_over_limit_minutes: 0 });
      expect(equation(sm)).toBe(600);
    }
  });
});

describe("scheduling operations against each other and against the reconciliation of consumption", () => {
  it("two schedulers racing for the last 300 minutes: exactly one wins in either order, the loser gets the existing 'available' error, committed total 600 of 600", async (ctx) => {
    skipUnlessSameMonth(ctx);
    for (const pauseSide of ["first", "second"] as const) {
      const f = await fx(600);
      await q(w.managerA, SQL.createShift, shiftArgs(f, 300, tomorrow, 6 * 60));
      const A = await open(w.managerA, pauseSide === "first" ? 600 : 0);
      const pa = settle(A.run(SQL.createShift, shiftArgs(f, 300, tomorrow, 12 * 60)));
      if (pauseSide === "first") await waitPaused(A.pid);
      const B = await open(w.schedulerA);
      const pb = settle(B.run(SQL.createShift, shiftArgs(f, 300, tomorrow, 18 * 60)));
      const ra = await pa; // A finishes its pause, then commits; only then can B (queued behind A's lineage lock) go on
      if (ra.ok) await A.commit(); else await A.rollback();
      const rb = await pb;
      if (rb.ok) await B.commit(); else await B.rollback();
      expect([ra.ok, rb.ok].filter(Boolean).length, `${pauseSide}: exactly one of two 300-minute shifts fits in the last 300`).toBe(1);
      const loser = (ra.ok ? rb : ra) as { ok: false; error: { code?: string; message: string } };
      expect(loser.error.code).toBe("OGC09");
      expect(await consumed(f)).toBe(600);
    }
  });

  it("reschedule_shift growing a shift races a new shift for the same minutes: committed total never exceeds 600", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const f = await fx(600);
    const first = (await q(w.managerA, SQL.createShift, shiftArgs(f, 200, tomorrow, 6 * 60)))[0];
    const [s, e] = hhmm(6 * 60, 400); // grow 200 -> 400 (needs 200 more)
    const A = await open(w.managerA, 600);
    const pa = settle(A.run("select * from ogevia_api.reschedule_shift($1,$2,$3::date,$4::time,$5::time,'Synthetic: longer visit',$6)", [w.orgA, first.shift_id, tomorrow, s, e, randomUUID()]));
    await waitPaused(A.pid);
    const B = await open(w.managerA);
    const pb = settle(B.run(SQL.createShift, shiftArgs(f, 300, tomorrow, 14 * 60)));
    const ra = await pa;
    if (ra.ok) await A.commit(); else await A.rollback();
    const rb = await pb;
    if (rb.ok) await B.commit(); else await B.rollback();
    expect(ra.ok, ra.ok ? "" : (ra as any).error.message).toBe(true);
    expect(rb.ok, "400 + 300 > 600: the new shift must be refused").toBe(false);
    expect(await consumed(f)).toBe(400);
  });
});

// pickup_open_shift only records a caregiver's REQUEST (no reservation, no minutes); confirm_shift_pickup is the consuming step and takes the lock.
describe("lock inventory: every function that writes minutes the guards read takes the authorization-lineage lock (directly or through a helper)", () => {
  it("reads the catalog: each listed function reaches ogevia.lock_authorization_lineage", async () => {
    const reaches = (await db.admin.query(
      `with recursive f as (select p.oid, n.nspname || '.' || p.proname fq, p.proname, p.prosrc src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname in ('ogevia', 'ogevia_api') and p.prokind = 'f'),
       edges as (select a.fq caller, b.fq callee from f a join f b on a.oid <> b.oid and position(b.proname in a.src) > 0 and a.src ~ ('\\m' || b.proname || '\\s*\\(')),
       rec(root, cur) as (select fq, fq from f union select r.root, e.callee from rec r join edges e on e.caller = r.cur)
       select root from rec where cur = 'ogevia.lock_authorization_lineage' group by root`)).rows.map((r) => r.root as string);
    const must = ["create_shift", "reschedule_shift", "create_shift_series", "change_shift_series_from", "extend_shift_series", "end_shift_series", "schedule_makeup_shift",
      "assign_shift_caregiver", "confirm_shift_pickup", "assign_care_request", "confirm_service_visit", "correct_service_visit",
      "review_late_visit_confirmation", "reconcile_ended_shift", "approve_billing_rounding_adjustment", "amend_client_authorization", "record_outage_visit",
      // 0082
      "end_service_visit", "close_missed_service_visit", "void_service_visit", "decide_visit_review", "revoke_visit_review_decision", "void_billing_rounding_adjustment"];
    for (const fn of must) expect(reaches, fn).toContain(`ogevia_api.${fn}`);
  });
});

describe("many interleavings: random writer, random scheduler, random pauses and start offsets", () => {
  it("40 rounds: no deadlock, no unexpected error, the equation is exact, and any overage is explained by a write that cannot be refused (end or reopen) committed after the shift", async (ctx) => {
    skipUnlessSameMonth(ctx);
    const kinds = ["end", "reopen", "close", "void", "closeMissed"] as const;
    let overBy = 0;
    const seen = new Set<string>();
    for (let round = 0; round < 40; round++) {
      const kind = kinds[round % kinds.length]!;
      const f = await fx(600);
      let writer: { actor: Actor; sql: string; params: unknown[] };
      const unrefusable = kind === "end" || kind === "reopen" || kind === "closeMissed";
      if (kind === "end" || kind === "closeMissed") {
        const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, "Client asked for extra help (synthetic)");
        await ageVisit(db, v, 45);
        writer = kind === "end" ? { actor: f.cg, sql: SQL.end, params: [v] } : { actor: w.managerA, sql: SQL.closeMissed, params: [v] };
      } else if (kind === "reopen") {
        const v = await unscheduledEnded(f, 45, "review");
        await q(w.managerA, SQL.close, [v]);
        writer = { actor: w.managerA, sql: SQL.revoke, params: [await decisionOf(v)] };
      } else if (kind === "close") {
        const v = await unscheduledEnded(f, 45, "review");
        writer = { actor: w.managerA, sql: SQL.close, params: [v] };
      } else {
        const v = await unscheduledEnded(f, 45, "awaiting");
        writer = { actor: w.managerA, sql: SQL.void, params: [v] };
      }
      const pauseA = [0, 0, 150, 400][Math.floor(Math.random() * 4)]!;
      const pauseB = [0, 0, 150, 400][Math.floor(Math.random() * 4)]!;
      const offset = Math.floor(Math.random() * 120);
      const bFirst = Math.random() < 0.5;
      const A = await open(writer.actor, pauseA);
      const B = await open(w.managerA, pauseB);
      const runA = async () => { const r = await settle(A.run(writer.sql, writer.params)); if (r.ok) await A.commit(); else await A.rollback(); return r; };
      const runB = async () => { const r = await settle(B.run(SQL.createShift, shiftArgs(f, 600))); if (r.ok) await B.commit(); else await B.rollback(); return r; };
      const [ra, rb] = await Promise.all([bFirst ? (async () => { await sleep(offset); return runA(); })() : runA(), bFirst ? runB() : (async () => { await sleep(offset); return runB(); })()]);
      for (const r of [ra, rb]) if (!r.ok) expect(["OGC09"], `unexpected error ${r.error.code}: ${r.error.message}`).toContain(r.error.code); // 40P01 (deadlock) would fail here
      seen.add(`${kind}:${ra.ok}:${rb.ok}`);
      const s = await summary(f);
      expect(equation(s), `round ${round} ${kind}`).toBe(600);
      const total = await consumed(f);
      if (total > 600) {
        expect(unrefusable && ra.ok && rb.ok, `round ${round}: ${kind} total ${total} is over 600 and is not explained by an unrefusable write`).toBe(true);
        overBy = Math.max(overBy, total - 600);
      }
    }
    expect(overBy).toBeLessThanOrEqual(45);
  }, 120000);
});

describe("the writers keep their existing errors and idempotency", () => {
  it("end_service_visit twice returns the same record; close/revoke/void twice with the same key return the same id; wrong-state errors are unchanged", async () => {
    const f = await fx(600);
    const v = await unscheduledEnded(f, 30, "awaiting");
    const again = await api.end(db, f.cg, v);
    expect(again.worked_minutes).toBe(30);
    const g = await fx(600);
    const v2 = await unscheduledEnded(g, 30, "review");
    const key = randomUUID();
    const one = await q(w.managerA, "select ogevia_api.decide_visit_review($1,'close_not_billable','Not a valid visit (synthetic)',$2) id", [v2, key]);
    const two = await q(w.managerA, "select ogevia_api.decide_visit_review($1,'close_not_billable','Not a valid visit (synthetic)',$2) id", [v2, key]);
    expect(two[0].id).toBe(one[0].id);
    await expectPgError(q(w.managerA, SQL.close, [v2]), "OGC09", /already has a review decision/);
    const rkey = randomUUID();
    const r1 = await q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1,'Synthetic: reopened for another look',$2) id", [one[0].id, rkey]);
    const r2 = await q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1,'Synthetic: reopened for another look',$2) id", [one[0].id, rkey]);
    expect(r2[0].id).toBe(r1[0].id);
    await expectPgError(q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1,'Synthetic: reopened for another look',null)", [one[0].id]), "OGC09", /already revoked/);
    await q(w.managerA, SQL.void, [v]);
    await expectPgError(q(w.managerA, SQL.void, [v]), "OGC09", /signed visit cannot be voided/);
    await expectPgError(q(f.cg, SQL.void, [v2]), "OGA03");
  });
});
