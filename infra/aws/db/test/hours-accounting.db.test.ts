// 0079 Hours accounting (owner requirement 2.2, 2.3): Authorized = Billable + Rounding + Pending + Reserved + Hours left, per authorization.
// Every figure is recomputed INDEPENDENTLY here from the raw tables (service_visits, authorization_reservations, billing_rounding_adjustments,
// visit_review_decisions, shifts) and compared with what the server reports, for each scenario. The same records then feed every surface (Home, client details,
// reports, chain report, continuity pack, caregiver Start Visit) and the figures must agree. SYNTHETIC data only; fixed arithmetic, no wall-clock dependence
// beyond "now" for shifts that are ahead, under way or ended.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

type Fx = { client: string; service: string; auth: string; cg: Actor; lineage: string; authorized: number };
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);

async function person(): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Pat Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, userId]);
  await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Pat')", [w.orgA, userId, "CG-" + sub.slice(0, 6)]);
  return { userId, sub };
}
/** A caregiver of its own and a client with a current authorization of `minutes`, so scenarios never share a caregiver's hours. */
async function fx(minutes: number): Promise<Fx> {
  const cg = await person();
  const f = await freshClient(db, w, cg, minutes);
  const lineage = (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id as string;
  return { ...f, cg, lineage, authorized: minutes };
}
const recordOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [a.userId, w.orgA])).rows[0].id as string;
const monthStart = async () => `${(await orgToday(db)).slice(0, 7)}-01`;

/** A staff shift (the shape create_shift writes) and its reservation (service date today), starting `startMin` minutes from now. */
async function reservedShift(f: Fx, minutes: number, startMin = -1) {
  const shift = (await db.admin.query(
    `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3,$4,$5, now() + make_interval(mins => $6), now() + make_interval(mins => $6 + $7), 'scheduled', a.lineage_id
     from ogevia.client_authorizations a where a.id = $8 returning id`,
    [w.orgA, f.client, f.service, f.cg.userId, await recordOf(f.cg), startMin, minutes, f.auth])).rows[0].id as string;
  await db.admin.query(
    `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
     select $1, a.lineage_id, null, $2, $3::date, $4 from ogevia.client_authorizations a where a.id = $5`,
    [w.orgA, shift, await orgToday(db), minutes, f.auth]);
  return shift;
}
/** Start, work `worked` minutes, end; then optionally confirm. */
async function visit(f: Fx, worked: number, how: { confirm?: "draw" | "unable_to_confirm" | null; unscheduled?: string | null } = {}) {
  const v = await api.start(db, f.cg, w.orgA, f.client, f.service, null, how.unscheduled === undefined ? null : how.unscheduled);
  await ageVisit(db, v, worked);
  await api.end(db, f.cg, v);
  if (how.confirm === "draw") await api.confirm(db, f.cg, v, { method: "draw", evidence: await api.registerEvidence(db, f.cg, w.orgA, v) });
  if (how.confirm === "unable_to_confirm") await api.confirm(db, f.cg, v, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  return v;
}
async function adjustment(f: Fx, visitId: string, base: number, delta: number) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica"); // fixture row; the product path (approve_billing_rounding) is covered by rounding.db.test.ts
    await c.query(
      `insert into ogevia.billing_rounding_adjustments (organization_id, unit_kind, visit_id, authorization_lineage_id, client_id, service_id, service_date, policy_id,
         covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
       values ($1,'visit',$2,$3,$4,$5,$6::date,$7,array[$2::uuid],$8,$9,$10,false,$11)`,
      [w.orgA, visitId, f.lineage, f.client, f.service, await orgToday(db), randomUUID(), base, base + delta, delta, w.managerA.userId]);
  } finally { await c.query("reset session_replication_role"); c.release(); }
}
async function acceptLate(visitId: string, minutes: number) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica"); // fixture row; the product flow is covered by signature-recovery.db.test.ts
    await c.query(
      `insert into ogevia.visit_review_decisions (organization_id, visit_id, decision, reason, review_reasons, visit_snapshot, decided_by, late_confirmation_review_id, accepted_minutes)
       values ($1,$2,'accept_late_confirmation','Late confirmation accepted (synthetic)',array['no_signer'],'{}'::jsonb,$3,$4,$5)`,
      [w.orgA, visitId, w.managerA.userId, randomUUID(), minutes]);
  } finally { await c.query("reset session_replication_role"); c.release(); }
}

/** Every bucket recomputed from the raw tables, row by row. Nothing here calls an accounting function except authorization_month_usage for the cross-check. */
async function independent(f: Fx) {
  const m0 = await monthStart();
  const inMonth = "r.service_date >= $2::date and r.service_date < ($2::date + interval '1 month')";
  const visits = (await db.admin.query(
    `select v.id, v.status, coalesce(v.worked_minutes,0) w, coalesce(v.billable_minutes,0) b, v.scheduled_shift_id sh,
            coalesce((select sum(d.accepted_minutes) from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation'),0)::int late,
            exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null and d.decision = 'close_not_billable') closed,
            exists (select 1 from ogevia.authorization_reservations r where r.shift_id = v.scheduled_shift_id and r.released_at is null) has_res
       from ogevia.service_visits v join ogevia.client_authorizations a on a.id = v.service_authorization_id
      where a.lineage_id = $1 and v.service_date >= $2::date and v.service_date < ($2::date + interval '1 month') and v.status in ('signed','administrator_review','awaiting_signature')`,
    [f.lineage, m0])).rows as any[];
  const res = (await db.admin.query(
    `select r.id, r.reserved_minutes m, s.status sstatus, s.starts_at > now() future, s.ends_at >= now() notended,
            (select x.status from ogevia.service_visits x where x.scheduled_shift_id = r.shift_id and x.status not in ('voided','corrected') order by x.created_at desc limit 1) vstatus,
            (select coalesce(x.billable_minutes,0) from ogevia.service_visits x where x.scheduled_shift_id = r.shift_id and x.status not in ('voided','corrected') order by x.created_at desc limit 1) vbill,
            (select coalesce(sum(d.accepted_minutes),0) from ogevia.service_visits x join ogevia.visit_review_decisions d on d.visit_id = x.id and d.revoked_at is null and d.decision = 'accept_late_confirmation'
              where x.scheduled_shift_id = r.shift_id and x.status = 'administrator_review') vlate
       from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
      where r.authorization_lineage_id = $1 and r.released_at is null and ${inMonth}`, [f.lineage, m0])).rows as any[];
  const rounding = Number((await db.admin.query(
    "select coalesce(sum(adjustment_minutes),0) n from ogevia.billing_rounding_adjustments r where r.authorization_lineage_id = $1 and r.voided_at is null and " + inMonth, [f.lineage, m0])).rows[0].n);

  let billable = 0, carried = 0, unreserved = 0, wnb = 0;
  for (const v of visits) {
    if (v.status === "signed") { billable += v.b; wnb += Math.max(v.w - v.b, 0); continue; }
    if (v.status === "administrator_review") {
      billable += v.late; carried += v.b;
      if (v.b === 0 && v.late === 0) { if (!v.has_res) { if (v.closed) wnb += v.w; else unreserved += v.w; } /* else its minutes are inside the shift's held reservation */ }
      else wnb += Math.max(v.w - v.b - v.late, 0);
      continue;
    }
    if (!v.has_res) unreserved += v.w; // awaiting confirmation, nothing reserved
  }
  let held = 0, ahead = 0, underway = 0, reconcile = 0;
  for (const r of res) {
    if (r.vstatus === "draft") underway += r.m;
    else if (r.vstatus === "signed") { /* already Billable */ }
    else if (r.vstatus === "administrator_review") { if (r.vbill === 0 && Number(r.vlate) === 0) held += r.m; /* else the visit's own minutes count: never both */ }
    else if (r.vstatus === "awaiting_signature") held += r.m;
    else if (r.sstatus === "scheduled" && r.future) ahead += r.m;
    else if (r.sstatus === "scheduled" && r.notended) underway += r.m;
    else reconcile += r.m;
  }
  const pending = carried + held + unreserved;
  const reserved = ahead + underway + reconcile;
  const left = f.authorized - (billable + rounding + pending + reserved);
  const usage = Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [f.lineage, await orgToday(db)])).rows[0].n);
  return { billable, rounding, carried, held, unreserved, pending, ahead, underway, reconcile, reserved, left, over: Math.max(-left, 0), wnb, usage };
}
const summaryRow = async (f: Fx) => (await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, $3)", [w.orgA, await monthStart(), f.client]))[0];

/** The server's buckets must equal the independent ones, the equation must hold, and the caregiver cap usage must be Billable + Rounding + Pending-in-review. */
async function check(f: Fx, expected?: Partial<Record<"billable" | "rounding" | "pending" | "reserved" | "left" | "over" | "wnb", number>>) {
  const i = await independent(f);
  const s = await summaryRow(f);
  expect({
    billable: s.hours_billable_minutes, rounding: s.hours_rounding_minutes, pending: s.hours_pending_minutes, review: s.hours_pending_review_minutes,
    held: s.hours_pending_held_minutes, unreserved: s.hours_pending_unreserved_minutes, reserved: s.hours_reserved_minutes, left: s.hours_left_minutes,
    over: s.hours_over_limit_minutes, wnb: s.hours_worked_not_billable_minutes,
  }).toEqual({ billable: i.billable, rounding: i.rounding, pending: i.pending, review: i.carried, held: i.held, unreserved: i.unreserved, reserved: i.reserved, left: i.left, over: i.over, wnb: i.wnb });
  expect(s.reserved_ahead_minutes + s.reserved_underway_minutes + s.reserved_reconcile_minutes).toBe(i.reserved);
  expect(s.hours_billable_minutes + s.hours_rounding_minutes + s.hours_pending_minutes + s.hours_reserved_minutes + s.hours_left_minutes).toBe(s.authorized_minutes); // the equation
  expect(i.usage).toBe(i.billable + i.rounding + i.carried); // the caregiver's cap usage and the office figures use the same records
  expect(s.billable_minutes + s.adjustment_minutes + s.reserved_minutes).toBe(i.billable + i.rounding + i.carried + i.held + i.reserved); // old fields: unchanged meaning
  if (expected) for (const [k, v] of Object.entries(expected)) expect((i as any)[k], k).toBe(v);
  return { i, s };
}

describe("every minute is in exactly one bucket (recomputed from the raw tables, per authorization)", () => {
  it("nothing yet: all hours left", async () => {
    const f = await fx(600);
    await check(f, { billable: 0, pending: 0, reserved: 0, left: 600 });
  });

  it("pending: worked, awaiting client confirmation, on a scheduled shift: the 130 minutes held are Pending, not Reserved and not Billable", async () => {
    const f = await fx(600);
    await reservedShift(f, 130);
    await visit(f, 60, { confirm: null });
    const { s } = await check(f, { billable: 0, pending: 130, reserved: 0, left: 470 });
    expect(s).toMatchObject({ hours_pending_held_minutes: 130, hours_pending_review_minutes: 0, remaining_minutes: 470 });
  });

  it("pending: in administrator review with no signer (nothing billable) on a scheduled shift: Pending, the same 130 minutes once", async () => {
    const f = await fx(600);
    await reservedShift(f, 130);
    await visit(f, 60, { confirm: "unable_to_confirm" });
    await check(f, { billable: 0, pending: 130, reserved: 0, left: 470 });
  });

  it("pending: in review CARRYING billable minutes (schedule variance): the 60 are Pending (and in the caregiver's cap usage); the shift is not also held", async () => {
    const f = await fx(600);
    await reservedShift(f, 130);
    await visit(f, 60, { confirm: "draw" });
    const { i, s } = await check(f, { billable: 0, pending: 60, reserved: 0, left: 540, wnb: 0 });
    expect(i.carried).toBe(60);
    expect(s).toMatchObject({ billable_minutes: 60, hours_billable_minutes: 0 }); // old field keeps counting it as billable; the new Billable is confirmed time only
  });

  it("GAP FIXED: an unscheduled visit awaiting confirmation was in NO bucket (old Remaining 600 hid 45 worked minutes); it is now Pending and Hours left is 555", async () => {
    const f = await fx(600);
    await visit(f, 45, { confirm: null, unscheduled: "Client asked for extra help (synthetic)" });
    const { s } = await check(f, { pending: 45, left: 555 });
    expect(s.remaining_minutes).toBe(600); // before 0079 the equation was short by exactly these 45 minutes
    expect(s.hours_pending_unreserved_minutes).toBe(45);
  });

  it("GAP FIXED: an unscheduled visit in review with no signer is Pending (45), not hidden", async () => {
    const f = await fx(600);
    await visit(f, 45, { confirm: "unable_to_confirm", unscheduled: "Client asked for extra help (synthetic)" });
    await check(f, { pending: 45, left: 555, wnb: 0 });
  });

  it("a review closed as not billable moves its unscheduled minutes out of Pending into the visible 'Worked, not billable' line", async () => {
    const f = await fx(600);
    const v = await visit(f, 45, { confirm: "unable_to_confirm", unscheduled: "Client asked for extra help (synthetic)" });
    await q(w.managerA, "select ogevia_api.decide_visit_review($1, 'close_not_billable', 'Not a valid visit (synthetic)', null) as id", [v]);
    await check(f, { pending: 0, left: 600, wnb: 45 });
  });

  it("under way: a visit still open on its shift keeps the shift Reserved (under way), not Pending", async () => {
    const f = await fx(600);
    await reservedShift(f, 130);
    await api.start(db, f.cg, w.orgA, f.client, f.service, null, null);
    await check(f, { reserved: 130, pending: 0, left: 470 });
  });

  it("CHARACTERIZATION (owner decision open): a review closed as not billable on a scheduled visit still holds its shift's reservation, so it stays Pending; nothing is double counted", async () => {
    const f = await fx(600);
    await reservedShift(f, 130);
    const v = await visit(f, 60, { confirm: "unable_to_confirm" });
    await q(w.managerA, "select ogevia_api.decide_visit_review($1, 'close_not_billable', 'Not a valid visit (synthetic)', null) as id", [v]);
    await check(f, { pending: 130, reserved: 0, left: 470 });
  });

  it("reservations: ahead 90 + under way 60 + ended without a record 30 + awaiting a record 120 = Reserved 300; Hours left 300", async () => {
    const f = await fx(600);
    await reservedShift(f, 90, 180); // starts in 3 hours
    await reservedShift(f, 60, -1); // started a minute ago
    const ended = await reservedShift(f, 30, -480); // ended 7.5 hours ago
    const held = await reservedShift(f, 120, -300); // ended 3 hours ago
    await q(w.managerA, "select ogevia_api.reconcile_ended_shift($1, $2, 'hold_service_may_have_occurred', 'Checked the schedule and the caregiver (synthetic)', null)", [w.orgA, held]);
    const { s } = await check(f, { reserved: 300, pending: 0, left: 300 });
    expect(s).toMatchObject({ reserved_ahead_minutes: 90, reserved_underway_minutes: 60, reserved_reconcile_minutes: 150, hours_reserved_minutes: 300 });
    expect(ended).toBeTruthy();
  });

  it("a released reservation (reconciled: no service) leaves Reserved; nothing else changes", async () => {
    const f = await fx(600);
    const ended = await reservedShift(f, 30, -480);
    await check(f, { reserved: 30, left: 570 });
    await q(w.managerA, "select ogevia_api.reconcile_ended_shift($1, $2, 'no_service_delivered', 'Confirmed with the family: no visit (synthetic)', null)", [w.orgA, ended]);
    await check(f, { reserved: 0, left: 600 });
  });

  it("rounding: a positive adjustment (+10 on 50) is its own visible line and counts once; Hours left 540", async () => {
    const f = await fx(600);
    await reservedShift(f, 50); // a shift of the same length: the visit is signed and the shift's reservation is released
    const v = await visit(f, 50, { confirm: "draw" });
    await check(f, { billable: 50, rounding: 0, reserved: 0, left: 550 });
    await adjustment(f, v, 50, 10);
    const { s } = await check(f, { billable: 50, rounding: 10, left: 540 });
    expect(s).toMatchObject({ hours_rounding_minutes: 10, adjustment_minutes: 10 });
  });

  it("rounding: a negative adjustment (-5 on 40) returns time; Hours left 565", async () => {
    const f = await fx(600);
    await reservedShift(f, 40);
    const v = await visit(f, 40, { confirm: "draw" });
    await adjustment(f, v, 40, -5);
    await check(f, { billable: 40, rounding: -5, left: 565 });
  });

  it("a correction: the original visit is replaced by the corrected one; only the corrected minutes are Billable", async () => {
    const f = await fx(600);
    await reservedShift(f, 130);
    const v = await visit(f, 60, { confirm: "draw" });
    await check(f, { pending: 60, left: 540 });
    const timeIn = (await db.admin.query("select time_in from ogevia.service_visits where id = $1", [v])).rows[0].time_in as Date;
    await api.correct(db, w.managerA, v, new Date(timeIn.getTime() - 70 * 60_000), new Date(timeIn.getTime() + 60 * 60_000 - 5 * 60_000), "Synthetic: actual times");
    await check(f, { billable: 125, pending: 0, reserved: 0, left: 475 });
  });

  it("a late confirmation accepted: the 45 accepted minutes are Billable, the shift's hold is released from Pending, once", async () => {
    const f = await fx(600);
    await reservedShift(f, 120);
    const v = await visit(f, 45, { confirm: "unable_to_confirm" });
    await check(f, { billable: 0, pending: 120, left: 480 });
    await acceptLate(v, 45);
    const { s } = await check(f, { billable: 45, pending: 0, reserved: 0, left: 555 });
    expect(s.hours_billable_minutes).toBe(45);
  });

  it("an overage: worked 150 on a 100-minute authorization is capped at 100 (Pending in review); with 60 more reserved the authorization is Over limit by 60; the 50 uncounted minutes are shown as Worked, not billable", async () => {
    const f = await fx(100);
    await reservedShift(f, 150);
    await visit(f, 150, { confirm: "draw" });
    await check(f, { pending: 100, left: 0, over: 0, wnb: 50 });
    await reservedShift(f, 60, 180); // raw fixture: the product refuses to schedule beyond the cap
    const { s } = await check(f, { pending: 100, reserved: 60, left: -60, over: 60, wnb: 50 });
    expect(s).toMatchObject({ hours_left_minutes: -60, hours_over_limit_minutes: 60, hours_worked_not_billable_minutes: 50, worked_minutes: 150, billable_minutes: 100 });
  });
});

describe("overages are per authorization and are never offset", () => {
  it("one authorization Over limit by 60 beside another with 600 unused: the second one's time is not used; the Home total shows both side by side", async () => {
    const over = await fx(100);
    await reservedShift(over, 150);
    await visit(over, 150, { confirm: "draw" });
    await reservedShift(over, 60, 180);
    const unused = await fx(600);
    const so = await summaryRow(over), su = await summaryRow(unused);
    expect([so.hours_left_minutes, so.hours_over_limit_minutes]).toEqual([-60, 60]);
    expect([su.hours_left_minutes, su.hours_over_limit_minutes]).toEqual([600, 0]);
    // Home sums over every authorization of the service: Hours left adds only authorizations that still have time, Over limit only those over.
    const rows = await q(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1, $2::date, null)", [w.orgA, await monthStart()]);
    const home = (await q(w.managerA, "select * from ogevia_api.get_utilisation_overview($1, $2::date)", [w.orgA, await monthStart()])).find((x) => x.service_id === w.serviceA);
    const mine = rows.filter((r) => r.service_id === w.serviceA);
    expect(home.hours_left_minutes).toBe(mine.reduce((n, r) => n + Math.max(r.hours_left_minutes, 0), 0));
    expect(home.hours_over_limit_minutes).toBe(mine.reduce((n, r) => n + r.hours_over_limit_minutes, 0));
    expect(home.hours_over_limit_minutes).toBeGreaterThanOrEqual(60);
    for (const k of ["hours_billable_minutes", "hours_rounding_minutes", "hours_pending_minutes", "hours_reserved_minutes", "hours_worked_not_billable_minutes"] as const) {
      expect(home[k], k).toBe(mine.reduce((n, r) => n + r[k], 0));
    }
    // The old aggregate field already behaved this way (0057); it still does.
    expect(home.remaining_minutes).toBe(mine.reduce((n, r) => n + Math.max(r.remaining_minutes, 0), 0));
  });
});

describe("the same records give the same figure on every surface (2.3)", () => {
  it("Home, client details/reports (summary), chain report, continuity pack and the caregiver's Start Visit lists agree for the same authorization", async () => {
    const f = await fx(600);
    await db.admin.query("update ogevia.clients set client_code = $2 where id = $1", [f.client, "CL-A-HRS-" + f.client.slice(0, 6)]);
    await reservedShift(f, 90, 180);
    await reservedShift(f, 130); // under way, then its visit awaits confirmation: Pending
    await visit(f, 60, { confirm: null });
    const { i, s } = await check(f, { pending: 130, reserved: 90, left: 380 });
    const month = await monthStart();

    // Reports / client details / schedule utilisation: the monthly summary rows.
    expect(s.hours_left_minutes).toBe(380);
    // Chain report
    const chain = (await q(w.managerA, "select * from ogevia_api.get_monthly_chain_report($1, $2::date, $3)", [w.orgA, month, f.client]))[0];
    expect([chain.hours_billable_minutes, chain.hours_rounding_minutes, chain.hours_pending_minutes, chain.hours_reserved_minutes, chain.hours_left_minutes, chain.hours_over_limit_minutes])
      .toEqual([s.hours_billable_minutes, s.hours_rounding_minutes, s.hours_pending_minutes, s.hours_reserved_minutes, s.hours_left_minutes, s.hours_over_limit_minutes]);
    expect(chain.hours_balance_ok).toBe(true);
    expect(chain.balance_ok).toBe(true); // the old identity on the old fields still holds
    // Continuity pack
    const code = (await db.admin.query("select client_code from ogevia.clients where id = $1", [f.client])).rows[0].client_code as string;
    const pack = (await q(w.managerA, "select ogevia_api.create_continuity_pack($1, $2) as p", [w.orgA, randomUUID()]))[0].p;
    const pa = pack.authorizations.find((x: any) => x.client_code === code);
    expect([pa.hours_billable_minutes, pa.hours_rounding_minutes, pa.hours_pending_minutes, pa.hours_reserved_minutes, pa.hours_left_minutes, pa.hours_over_limit_minutes])
      .toEqual([s.hours_billable_minutes, s.hours_rounding_minutes, s.hours_pending_minutes, s.hours_reserved_minutes, s.hours_left_minutes, s.hours_over_limit_minutes]);
    // Caregiver: Start Visit service list. Left to record = authorized - cap usage; Hours left = the office figure; the difference is labelled.
    const svc = (await q(f.cg, "select * from ogevia_api.list_caregiver_hours_balances($1, $2)", [w.orgA, f.client]))[0];
    const listed = (await q(f.cg, "select * from ogevia_api.list_authorized_services_for_client($1, $2)", [w.orgA, f.client]))[0];
    expect(svc.service_id).toBe(f.service);
    expect(Number(svc.left_to_record_minutes)).toBe(f.authorized - i.usage);
    expect(Number(svc.hours_left_minutes)).toBe(s.hours_left_minutes);
    expect(Number(listed.minutes_used_this_month)).toBe(i.usage); // the old list still reports the same usage
    expect(Number(svc.left_to_record_minutes) - Number(svc.office_pending_minutes) - Number(svc.office_reserved_minutes)).toBe(Number(svc.hours_left_minutes));
    expect(Number(svc.office_pending_minutes)).toBe(i.held + i.unreserved);
    expect(Number(svc.office_reserved_minutes)).toBe(i.reserved);
    // Caregiver: the active visit panel (here the visit awaits confirmation, so it is still the caregiver's active visit).
    const active = (await q(f.cg, "select * from ogevia_api.get_active_service_visit($1)", [w.orgA]))[0];
    const activeBalance = (await q(f.cg, "select * from ogevia_api.get_active_visit_balance($1)", [w.orgA]))[0];
    expect(activeBalance.visit_id).toBe(active.visit_id);
    expect(Number(activeBalance.left_to_record_minutes)).toBe(f.authorized - Number(active.confirmed_minutes_this_month));
    expect(Number(activeBalance.left_to_record_minutes)).toBe(f.authorized - i.usage); // this visit carries no counted minutes yet
    // The two figures differ ONLY by pending and reserved time the office also deducts.
    expect(f.authorized - i.usage - (s.hours_pending_held_minutes + s.hours_pending_unreserved_minutes + s.hours_reserved_minutes)).toBe(s.hours_left_minutes);
  });

  it("the caregiver 'left to record' equals the office Hours left when nothing is pending or scheduled, and goes negative with the office figure when over", async () => {
    const f = await fx(100);
    await visit(f, 150, { confirm: "draw", unscheduled: "Client asked for extra help (synthetic)" }); // review, capped 100, nothing reserved
    const s = await summaryRow(f);
    const svc = (await q(f.cg, "select * from ogevia_api.list_caregiver_hours_balances($1, $2)", [w.orgA, f.client]))[0];
    expect(Number(svc.left_to_record_minutes)).toBe(Number(svc.hours_left_minutes));
    expect(s.hours_left_minutes).toBe(0);
    expect(s.hours_worked_not_billable_minutes).toBe(50);
  });
});

describe("a visit's own tenant: another agency's records never enter a figure", () => {
  it("the breakdown is internal: the application role cannot call it directly", async () => {
    await expect(q(w.managerA, "select * from ogevia.hours_breakdown($1, $2::date)", [w.orgA, await monthStart()])).rejects.toThrow();
  });
});
