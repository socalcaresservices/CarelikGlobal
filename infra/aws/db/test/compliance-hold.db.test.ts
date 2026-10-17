// 0053 Caregiver compliance hold: approved background-check clearance and the 14-day CPR/TB period.
// These are OWNER-DEFINED rules, not verified legal requirements. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let recA3: string;
let cpr: string;
let tb: string;
let fx: { client: string; service: string; auth: string };
const sha = "d".repeat(64);

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const recOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

/** The scheduled run: the application role with NO signed-in person. */
async function asApp<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_app");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  recA1 = await recOf(w.caregiverA1);
  recA2 = await recOf(w.caregiverA2);
  recA3 = await recOf(w.caregiverA3);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await configureRules();
});
afterAll(async () => db?.drop());

// ------------------------------------------------------------------ helpers
async function deliver(rec: string, type: string, opts: { issued?: string | null; expires?: string | null; verify?: "verified" | "rejected" | null }) {
  let doc = (await q("select id from ogevia.staff_documents where caregiver_record_id=$1 and document_type_id=$2 and closed_at is null", [rec, type])).rows[0]?.id as string | undefined;
  if (!doc) doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
  const version = randomUUID();
  const row = (await call(w.managerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
    doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, opts.issued ?? null, opts.expires ?? null]))[0];
  if (opts.verify) await call(w.ownerA, "select ogevia_api.review_document_version($1,$2,$3,null)", [row.document_version_id, opts.verify, opts.verify === "rejected" ? "Image unreadable" : null]);
  return { doc, version: row.document_version_id as string };
}
const deliverCpr = async (rec: string, verify: "verified" | "rejected" | null = "verified", expires?: string) =>
  deliver(rec, cpr, { issued: await add(-5), expires: expires ?? (await add(400)), verify });
const deliverTb = async (rec: string, verify: "verified" | "rejected" | null = "verified") => deliver(rec, tb, { issued: await add(-5), expires: null, verify });
const clearDocs = (rec: string) => q("update ogevia.staff_documents set closed_at = now() where caregiver_record_id = $1 and closed_at is null", [rec]);
const hireDaysAgo = (rec: string, n: number | null) =>
  q("update ogevia.caregiver_records set hire_date = case when $2::int is null then null else $3::date - $2::int end where id = $1", [rec, n, today]);
const setBackground = (rec: string, state: "none" | "completed_only" | "not_approved" | "approved") =>
  q("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [rec]).then(() =>
    state === "none" ? null
    : state === "approved"
      ? q("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','approved','Synthetic fixture clearance',$3,now())", [rec, w.orgA, w.ownerA.userId])
      : state === "not_approved"
        ? q("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','not_approved','Synthetic fixture',$3,now())", [rec, w.orgA, w.ownerA.userId])
        : q("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status) values ($1,$2,'completed')", [rec, w.orgA]));
const allWeek = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: "00:00", end_local: "23:59" }));
async function baseline(rec: string) {
  await q("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [rec]);
  for (const x of allWeek) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,$4,$5)", [w.orgA, rec, x.weekday, x.start_local, x.end_local]);
}
const createShift = (a: Actor, day: string, start: string, end: string, rec: string | null) =>
  call(a, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [w.orgA, fx.client, fx.service, day, start, end, rec]);
const compliance = (rec: string, a: Actor = w.managerA) => call(a, "select ogevia_api.get_caregiver_compliance($1,$2) as c", [w.orgA, rec]).then((r) => r[0].c);
const holds = (a: Actor = w.managerA) => call(a, "select ogevia_api.list_compliance_holds($1) as h", [w.orgA]).then((r) => r[0].h);
/** The scheduled run exactly as the Lambda does it: no signed-in person; first the agencies with enforcement active, then one agency at a time. */
const sweep = async () => {
  const orgs = await asApp(async (c) => (await c.query("select ogevia_api.system_compliance_orgs() as id")).rows.map((r) => r.id as string));
  const total = { evaluated: 0, holdsOpened: 0, holdsReleased: 0 };
  for (const org of orgs) {
    const r = await asApp(async (c) => (await c.query("select ogevia_api.system_compliance_sweep_org($1) as r", [org])).rows[0].r);
    total.evaluated += r.evaluated; total.holdsOpened += r.holdsOpened; total.holdsReleased += r.holdsReleased;
  }
  return total;
};
const openHold = async (rec: string) => (await q("select * from ogevia.caregiver_compliance_holds where caregiver_record_id = $1 and released_at is null", [rec])).rows[0];
const openFlags = async (rec: string, table: "shift" | "assignment") =>
  (await q(`select * from ogevia.${table}_readiness_flags where caregiver_record_id = $1 and kind = 'compliance' and resolved_at is null`, [rec])).rows;
const grace = async (rec: string, asOf: string) =>
  (await q("select hire_date::text hire, due_date::text due, (grace_ends_at at time zone 'UTC')::text ends_utc, in_grace from ogevia.compliance_grace($1,$2,$3::timestamptz)", [w.orgA, rec, asOf])).rows[0];
const blockers = async (rec: string, asOf: string) =>
  (await q("select requirement, code, blocking, due_date::text due from ogevia.compliance_blockers($1,$2,$3::timestamptz) order by requirement", [w.orgA, rec, asOf])).rows;
const wipeShifts = async () => {
  await q("delete from ogevia.assignment_readiness_flags");
  await q("delete from ogevia.shift_readiness_flags");
  await q("delete from ogevia.authorization_reservations where shift_id is not null");
  await q("delete from ogevia.shift_coverage_events");
  await q("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};
const resetCaregiver = async (rec: string) => {
  await clearDocs(rec); // closing a document re-evaluates the caregiver, so clear the documents FIRST and the hold after
  await q("delete from ogevia.shift_readiness_flags where caregiver_record_id = $1", [rec]);
  await q("delete from ogevia.assignment_readiness_flags where caregiver_record_id = $1", [rec]);
  await q("delete from ogevia.caregiver_compliance_holds where caregiver_record_id = $1", [rec]);
};

async function configureRules() {
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
}
async function activate() {
  const s = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
  await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, s.affectedShiftsCount]);
}

// ------------------------------------------------------------------ 0. before activation
describe("report-only first: applying this release strands nobody", () => {
  it("a caregiver with no clearance and no hire date can still be scheduled; the report says who WOULD be held; no hold is created", async () => {
    await baseline(recA3);
    await setBackground(recA3, "none");
    await q("update ogevia.caregiver_records set hire_date = null");
    const made = await createShift(w.managerA, await add(3), "09:00", "11:00", recA3).catch((e) => e);
    // Report-only agencies still refuse a caregiver who is not Ready/Active only; the new checks report, they do not block.
    expect(Array.isArray(made) ? made : []).toHaveLength(1);
    const summary = (await call(w.managerA, "select ogevia_api.get_compliance_summary($1) as s", [w.orgA]))[0].s;
    expect(summary).toMatchObject({ enforcementActive: false, graceDays: 14 });
    expect(summary.wouldBeHeld).toBeGreaterThanOrEqual(1);
    expect(summary.withoutApprovedBackground).toBeGreaterThanOrEqual(1);
    expect(await sweep()).toMatchObject({ holdsOpened: 0 });
    expect(await openHold(recA3)).toBeUndefined();
    const snap = await compliance(recA3);
    expect(snap).toMatchObject({ enforcementActive: false, eligible: false });
    await wipeShifts();
  });
});

// ------------------------------------------------------------------ 1. the exact deadline
describe("the 14-day period: exact calculation (agency time zone America/Los_Angeles)", () => {
  it("hire date is day 0; the due date is hire + 14; the period ends at 00:00 local the next day (inclusive of the due date)", async () => {
    await q("update ogevia.caregiver_records set hire_date = '2026-10-01' where id = $1", [recA1]);
    expect(await grace(recA1, "2026-10-15 23:59:59-07")).toMatchObject({ hire: "2026-10-01", due: "2026-10-15", in_grace: true });
    expect(await grace(recA1, "2026-10-16 00:00:00-07")).toMatchObject({ due: "2026-10-15", in_grace: false });
    expect((await grace(recA1, "2026-10-01 00:00:00-07")).in_grace).toBe(true);
    expect((await grace(recA1, "2026-09-30 12:00:00-07")).in_grace).toBe(true); // a future hire date: the period has not started, nothing is owed yet
  });

  it("daylight saving: the boundary stays at local midnight on a 25-hour day (fall back) and a 23-hour day (spring forward)", async () => {
    await q("update ogevia.caregiver_records set hire_date = '2026-10-18' where id = $1", [recA1]); // due 2026-11-01, the 25-hour day
    expect(await grace(recA1, "2026-11-02 07:59:59+00")).toMatchObject({ due: "2026-11-01", ends_utc: "2026-11-02 08:00:00", in_grace: true });
    expect((await grace(recA1, "2026-11-02 08:00:00+00")).in_grace).toBe(false);
    await q("update ogevia.caregiver_records set hire_date = '2027-02-28' where id = $1", [recA1]); // due 2027-03-14, the 23-hour day
    expect(await grace(recA1, "2027-03-15 06:59:59+00")).toMatchObject({ due: "2027-03-14", ends_utc: "2027-03-15 07:00:00", in_grace: true });
    expect((await grace(recA1, "2027-03-15 07:00:00+00")).in_grace).toBe(false);
  });

  it("inside the period a missing or only-uploaded CPR/TB is PENDING with the due date; after it, blocking; a missing hire date is never a pass", async () => {
    await resetCaregiver(recA1);
    await q("update ogevia.caregiver_records set hire_date = '2026-10-01' where id = $1", [recA1]);
    expect(await blockers(recA1, "2026-10-15 23:59:59-07")).toEqual([
      { requirement: "cpr", code: "missing_pending", blocking: false, due: "2026-10-15" },
      { requirement: "tb", code: "missing_pending", blocking: false, due: "2026-10-15" },
    ]);
    expect(await blockers(recA1, "2026-10-16 00:00:00-07")).toEqual([
      { requirement: "cpr", code: "missing_after_deadline", blocking: true, due: "2026-10-15" },
      { requirement: "tb", code: "missing_after_deadline", blocking: true, due: "2026-10-15" },
    ]);
    await q("update ogevia.caregiver_records set hire_date = null where id = $1", [recA1]);
    expect((await blockers(recA1, "2026-10-10 12:00:00-07")).map((b) => [b.requirement, b.code, b.blocking])).toEqual([
      ["cpr", "missing_no_hire_date", true],
      ["tb", "missing_no_hire_date", true],
    ]);
  });

  it("CPR-only and TB-only gaps: only the missing requirement is listed", async () => {
    await resetCaregiver(recA1);
    await q("update ogevia.caregiver_records set hire_date = '2026-10-01' where id = $1", [recA1]);
    await deliverTb(recA1);
    expect(await blockers(recA1, "2026-10-20 12:00:00-07")).toEqual([{ requirement: "cpr", code: "missing_after_deadline", blocking: true, due: "2026-10-15" }]);
    await clearDocs(recA1);
    await deliverCpr(recA1);
    expect(await blockers(recA1, "2026-10-20 12:00:00-07")).toEqual([{ requirement: "tb", code: "missing_after_deadline", blocking: true, due: "2026-10-15" }]);
    await deliverTb(recA1);
    expect(await blockers(recA1, "2026-10-20 12:00:00-07")).toEqual([]); // both verified and current: no hire date needed
  });

  it("an uploaded but unverified record is pending inside the period and blocking after it; verification, not an upload, is what counts", async () => {
    await resetCaregiver(recA1);
    await q("update ogevia.caregiver_records set hire_date = '2026-10-01' where id = $1", [recA1]);
    await deliverCpr(recA1, null);
    await deliverTb(recA1, null);
    expect((await blockers(recA1, "2026-10-15 12:00:00-07")).map((b) => [b.code, b.blocking])).toEqual([["awaiting_review_pending", false], ["awaiting_review_pending", false]]);
    expect((await blockers(recA1, "2026-10-16 12:00:00-07")).map((b) => [b.code, b.blocking])).toEqual([["awaiting_review_after_deadline", true], ["awaiting_review_after_deadline", true]]);
  });

  it("stricter existing controls are NOT relaxed by the period: rejected and expired are blocking even on day 1", async () => {
    await resetCaregiver(recA1);
    await q("update ogevia.caregiver_records set hire_date = $2::date - 1 where id = $1", [recA1, today]);
    await deliverCpr(recA1, "rejected");
    await deliver(recA1, tb, { issued: await add(-800), expires: null, verify: "verified" }); // TB valid 365 days from issue: long expired
    const b = await q("select requirement, code, blocking from ogevia.compliance_blockers($1,$2) order by requirement", [w.orgA, recA1]);
    expect(b.rows).toEqual([
      { requirement: "cpr", code: "rejected", blocking: true },
      { requirement: "tb", code: "expired", blocking: true },
    ]);
  });
});

// ------------------------------------------------------------------ 2. enforcement on every backend path
describe("enforcement on the backend (after the owner activates it)", () => {
  beforeAll(async () => {
    for (const r of [recA1, recA2, recA3]) { await baseline(r); await setBackground(r, "approved"); await clearDocs(r); }
    await activate();
  });

  it("BACKGROUND: 'completed' alone does not qualify; a not-approved result does not; no record does not; only a verified approved result does", async () => {
    await hireDaysAgo(recA1, 3);
    for (const s of ["none", "completed_only", "not_approved"] as const) {
      await setBackground(recA1, s);
      await expectPgError(createShift(w.managerA, await add(3), "09:00", "11:00", recA1), "OGR30", /Background check/);
    }
    await setBackground(recA1, "approved"); // CPR/TB are pending inside the period, so approved clearance is the only thing needed
    expect(await createShift(w.managerA, await add(3), "09:00", "11:00", recA1)).toHaveLength(1);
    await wipeShifts();
  });

  it("a caregiver may be created before clearance: the record exists as Active/Ready with no clearance, and cannot be assigned", async () => {
    const sub = randomUUID();
    const user = (await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1,'NEW_HIRE') returning id", [sub])).rows[0].id as string;
    await q("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, user]);
    const rec = (await q("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1,$2,'CG-NEW','Synthetic','Newhire','ready') returning id", [w.orgA, user])).rows[0].id as string;
    await baseline(rec);
    await hireDaysAgo(rec, 1);
    await expectPgError(createShift(w.managerA, await add(4), "09:00", "11:00", rec), "OGR30", /Background check/);
    await expectPgError(call(w.managerA, "select ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null)", [w.orgA, rec, fx.client, fx.service, today]), "OGR30", /Background check/);
  });

  it("CPR/TB: assigned inside the 14 days, blocked from the day after the due date (day 14 inclusive); stricter statuses block at once", async () => {
    await setBackground(recA1, "approved");
    await clearDocs(recA1);
    await hireDaysAgo(recA1, 14); // today IS the due date
    const ok = await createShift(w.managerA, await add(3), "09:00", "11:00", recA1);
    expect(ok).toHaveLength(1);
    await wipeShifts();
    await hireDaysAgo(recA1, 15); // the period ended at 00:00 today
    await expectPgError(createShift(w.managerA, await add(3), "09:00", "11:00", recA1), "OGR30", /CPR missing\.\s+TB missing\./);
    await hireDaysAgo(recA1, null);
    await expectPgError(createShift(w.managerA, await add(3), "09:00", "11:00", recA1), "OGR30", /CPR missing\./);
    await hireDaysAgo(recA1, 2);
    await deliverCpr(recA1, "rejected");
    await expectPgError(createShift(w.managerA, await add(3), "09:00", "11:00", recA1), "OGR30", /CPR rejected\./);
  });

  it("every path refuses a caregiver on hold: manual assignment, reassignment, open-shift pickup, standing assignment, series, visit start", async () => {
    // A1: cleared background, hire date long past, no CPR/TB -> held.
    await resetCaregiver(recA1);
    await setBackground(recA1, "approved");
    await hireDaysAgo(recA1, 40);
    const day = await add(5);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA1), "OGR30", /CPR missing/);
    // reassignment of an existing shift (made for A2, who is current) onto A1
    await resetCaregiver(recA2); await setBackground(recA2, "approved"); await hireDaysAgo(recA2, 2);
    const s2 = (await createShift(w.managerA, await add(6), "09:00", "11:00", recA2))[0].shift_id ?? (await q("select id from ogevia.shifts where caregiver_record_id=$1 and status='scheduled'", [recA2])).rows[0].id;
    await expectPgError(call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Coverage')", [w.orgA, s2, recA1]), "OGR30", /CPR missing/);
    // open-shift pickup by the held caregiver themself
    const open = (await createShift(w.managerA, await add(7), "09:00", "11:00", null))[0];
    const openId = open.shift_id ?? (await q("select id from ogevia.shifts where caregiver_record_id is null and status='scheduled' order by created_at desc limit 1")).rows[0].id;
    await expectPgError(call(w.caregiverA1, "select ogevia_api.pickup_open_shift($1,$2,null)", [w.orgA, openId]), "OGR30", /CPR missing/);
    // a standing assignment
    await expectPgError(call(w.managerA, "select ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null)", [w.orgA, recA1, fx.client, fx.service, today]), "OGR30", /CPR missing/);
    // visit start (an unscheduled start; the shift-linked start uses the same function and trigger)
    await expectPgError(api.start(db, w.caregiverA1, w.orgA, fx.client, fx.service, null, "Synthetic: not on my schedule"), "OGR30", /CPR missing/);
    // direct write that skips every function: the database refuses it too
    await expect(q(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
                    values ($1,$2,$3,$4,$5, now() + interval '2 days', now() + interval '2 days 2 hours', 'scheduled')`, [w.orgA, fx.client, fx.service, w.caregiverA1.userId, recA1]))
      .rejects.toMatchObject({ code: "OGR30" });
    // release: once CPR and TB are verified, every path works again
    await deliverCpr(recA1);
    await deliverTb(recA1);
    expect(await createShift(w.managerA, day, "09:00", "11:00", recA1)).toHaveLength(1);
    await wipeShifts();
  });

  it("recurring series: occurrences are refused for a held caregiver; the skip reason for a background gap is 'compliance_hold'", async () => {
    await resetCaregiver(recA3); await setBackground(recA3, "none"); await hireDaysAgo(recA3, 2);
    const out = await q("select ogevia.readiness_outcome($1,$2,$3, now() + interval '3 days', now() + interval '3 days 2 hours') o", [w.orgA, recA3, fx.service]);
    expect(out.rows[0].o).toBe("compliance_hold");
    await setBackground(recA3, "approved"); await hireDaysAgo(recA3, 40);
    const out2 = await q("select ogevia.readiness_outcome($1,$2,$3, now() + interval '3 days', now() + interval '3 days 2 hours') o", [w.orgA, recA3, fx.service]);
    expect(out2.rows[0].o).toBe("documents_not_current");
    await expectPgError(call(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,'{1,2,3,4,5}'::smallint[],'09:00','11:00',$5::date,$6::date,'refuse')", [w.orgA, fx.client, fx.service, recA3, await add(7), await add(30)]), "OGC09", /documents not current/);
    await setBackground(recA3, "none");
    await expectPgError(call(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,'{1,2,3,4,5}'::smallint[],'09:00','11:00',$5::date,$6::date,'refuse')", [w.orgA, fx.client, fx.service, recA3, await add(7), await add(30)]), "OGC09", /compliance hold/);
  });
});

// ------------------------------------------------------------------ 3. the hold at the deadline, existing work, release
describe("the hold: automatic at the deadline, affects existing work, never changes history, released only when everything is resolved", () => {
  let standing: string;
  let futureShift: string;
  let seriesOccurrences: string[];
  let cancelled: string;
  let reassigned: string;
  let completedVisit: string;
  let inProgressVisit: string;
  let snapshotBefore: { coverage: number; assignmentActive: boolean; shiftCaregiver: string };

  beforeAll(async () => {
    await resetCaregiver(recA2); await resetCaregiver(recA3); await resetCaregiver(recA1);
    for (const r of [recA1, recA2, recA3]) await setBackground(r, "approved");
    await wipeShifts(); // earlier suites' scheduled work
    // Only A2 is meant to be held in this block: park the other fixtures (one is cleared and current, two extra records are inactive).
    await q("update ogevia.caregiver_records set status = 'inactive' where caregiver_code in ('CG-NEW', 'CG-OWNER')");
    await q("delete from ogevia.caregiver_compliance_holds");
    await deliverCpr(recA1); await deliverTb(recA1); await hireDaysAgo(recA1, 1);
    // A2 is two days into the period: assignable with no CPR/TB yet. A3 is fully current (the reassignment target).
    await hireDaysAgo(recA2, 2);
    await deliverCpr(recA3); await deliverTb(recA3); await hireDaysAgo(recA3, 1);
    standing = (await call(w.managerA, "select assignment_id as id from ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null)", [w.orgA, recA2, fx.client, fx.service, today]))[0].id;
    await createShift(w.managerA, await add(3), "09:00", "11:00", recA2);
    futureShift = (await q("select id from ogevia.shifts where caregiver_record_id = $1 and status='scheduled'", [recA2])).rows[0].id;
    await call(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,'{0,1,2,3,4,5,6}'::smallint[],'13:00','14:00',$5::date,$6::date,'refuse')", [w.orgA, fx.client, fx.service, recA2, await add(8), await add(21)]);
    seriesOccurrences = (await q("select id from ogevia.shifts where caregiver_record_id = $1 and series_id is not null and status='scheduled' order by starts_at", [recA2])).rows.map((r) => r.id);
    await createShift(w.managerA, await add(4), "09:00", "11:00", recA2);
    cancelled = (await q("select id from ogevia.shifts where caregiver_record_id = $1 and starts_at::date = ($2::date + 4) and series_id is null", [recA2, today])).rows[0].id;
    await call(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic: client unwell')", [w.orgA, cancelled]);
    await createShift(w.managerA, await add(5), "09:00", "11:00", recA2);
    reassigned = (await q("select id from ogevia.shifts where caregiver_record_id = $1 and starts_at::date = ($2::date + 5) and series_id is null and status='scheduled'", [recA2, today])).rows[0].id;
    await call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Covered by another caregiver')", [w.orgA, reassigned, recA3]);
    // a visit A2 completed before the hold, and one still in progress when it opens
    completedVisit = await api.start(db, w.caregiverA2, w.orgA, fx.client, fx.service, null, "Synthetic: not on my schedule");
    await ageVisit(db, completedVisit, 30);
    await api.end(db, w.caregiverA2, completedVisit);
    await api.confirm(db, w.caregiverA2, completedVisit, { evidence: await api.registerEvidence(db, w.caregiverA2, w.orgA, completedVisit) });
    inProgressVisit = await api.start(db, w.caregiverA2, w.orgA, fx.client, fx.service, null, "Synthetic: second visit");
    snapshotBefore = {
      coverage: (await q("select count(*)::int n from ogevia.shift_coverage_events")).rows[0].n,
      assignmentActive: (await q("select is_active from ogevia.caregiver_assignments where id=$1", [standing])).rows[0].is_active,
      shiftCaregiver: (await q("select caregiver_record_id from ogevia.shifts where id=$1", [reassigned])).rows[0].caregiver_record_id,
    };
  });

  it("while inside the period there is no hold, and nothing is flagged", async () => {
    expect(await sweep()).toMatchObject({ holdsOpened: 0 });
    expect(await openHold(recA2)).toBeUndefined();
    const snap = await compliance(recA2);
    expect(snap).toMatchObject({ inGrace: true, eligible: true, hold: null });
    expect(snap.requirements.map((r: any) => [r.requirement, r.pending, r.blocking, r.dueDate])).toEqual([["cpr", true, false, await add(12)], ["tb", true, false, await add(12)]]);
  });

  it("the deadline passes and NOBODY opens the profile: the gate already refuses at once, and the scheduled run opens the hold, flags the work and audits it", async () => {
    await hireDaysAgo(recA2, 15); // the period ended at 00:00 today (time passing; no profile was opened, no API call was made)
    // Enforcement does not wait for the run:
    await expectPgError(createShift(w.managerA, await add(9), "09:00", "11:00", recA2), "OGR30", /CPR missing/);
    expect(await openHold(recA2)).toBeUndefined(); // nothing materialised yet
    const result = await sweep(); // the application role, no signed-in person
    expect(result.holdsOpened).toBeGreaterThanOrEqual(1);
    const hold = await openHold(recA2);
    expect(hold).toMatchObject({ opened_by: null, grace_closed: true });
    expect((hold.reasons as any[]).map((r) => [r.requirement, r.code])).toEqual([["cpr", "missing_after_deadline"], ["tb", "missing_after_deadline"]]);
    expect((hold.reasons as any[])[0].message).toMatch(/CPR missing\. The 14-day period ended/);
    const audit = (await q("select actor_user_id, after_state from ogevia.audit_events where action = 'caregiver.compliance_hold_opened' and entity_id = $1", [hold.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBeNull();
    expect(audit[0].after_state).toMatchObject({ automatic: true, flaggedAssignments: 1, inProgressVisits: 1 });
  });

  it("flags every affected shift (each recurring occurrence) and the standing assignment; cancelled and reassigned shifts are not flagged", async () => {
    const flagged = (await openFlags(recA2, "shift")).map((f) => f.shift_id).sort();
    expect(flagged).toEqual([futureShift, ...seriesOccurrences].sort());
    expect(seriesOccurrences.length).toBeGreaterThanOrEqual(10);
    expect(flagged).not.toContain(cancelled);
    expect(flagged).not.toContain(reassigned);
    expect((await openFlags(recA2, "assignment")).map((f) => f.assignment_id)).toEqual([standing]);
    expect((await openFlags(recA2, "shift"))[0].reason_code).toBe("compliance_hold");
  });

  it("a visit in progress is NOT ended: the office is alerted instead, and the caregiver can still end it; history and completed visits are untouched", async () => {
    const v = (await q("select status::text s, time_out from ogevia.service_visits where id = $1", [inProgressVisit])).rows[0];
    expect(v).toMatchObject({ s: "draft", time_out: null });
    const list = await holds();
    const mine = list.holds.find((h: any) => h.caregiverRecordId === recA2);
    expect(mine.inProgressVisits.map((x: any) => x.visitId)).toEqual([inProgressVisit]);
    expect(list.totals).toMatchObject({ holds: 1, inProgressVisits: 1 });
    const attention = (await call(w.managerA, "select ogevia_api.get_compliance_attention($1) as a", [w.orgA]))[0].a;
    expect(attention).toMatchObject({ holds: 1, inProgressVisits: 1, affectedShifts: 1 + seriesOccurrences.length });
    await ageVisit(db, inProgressVisit, 20);
    await api.end(db, w.caregiverA2, inProgressVisit); // ending is never blocked
    expect((await q("select time_out is not null ended from ogevia.service_visits where id = $1", [inProgressVisit])).rows[0].ended).toBe(true);
    expect((await q("select status::text s from ogevia.service_visits where id = $1", [completedVisit])).rows[0].s).not.toBe("voided");
    // history preserved: nothing was cancelled, moved or reassigned by the hold
    expect((await q("select count(*)::int n from ogevia.shift_coverage_events")).rows[0].n).toBe(snapshotBefore.coverage);
    expect((await q("select is_active from ogevia.caregiver_assignments where id=$1", [standing])).rows[0].is_active).toBe(snapshotBefore.assignmentActive);
    expect((await q("select caregiver_record_id from ogevia.shifts where id=$1", [reassigned])).rows[0].caregiver_record_id).toBe(snapshotBefore.shiftCaregiver);
    expect((await q("select count(*)::int n from ogevia.shifts where caregiver_record_id=$1 and status='scheduled'", [recA2])).rows[0].n).toBe(1 + seriesOccurrences.length);
  });

  it("the office sees the exact reason, the affected shifts (with client code) and where to fix it", async () => {
    const mine = (await holds()).holds.find((h: any) => h.caregiverRecordId === recA2);
    expect(mine.reasons.map((r: any) => r.message).join(" ")).toMatch(/CPR missing\. The 14-day period ended .*TB missing\. The 14-day period ended/);
    expect(mine.affectedShifts).toHaveLength(1 + seriesOccurrences.length);
    expect(mine.affectedShifts[0]).toHaveProperty("clientCode");
    expect(mine.affectedAssignments).toHaveLength(1);
    const snap = await compliance(recA2);
    expect(snap).toMatchObject({ eligible: false, hold: { automatic: true, graceClosed: true } });
    expect(snap.requirements.every((r: any) => r.blocking && !r.pending)).toBe(true);
  });

  it("running it again changes nothing: no second hold, no duplicate flags, no second audit event", async () => {
    const flagsBefore = (await openFlags(recA2, "shift")).length;
    expect(await sweep()).toMatchObject({ holdsOpened: 0 });
    expect((await openFlags(recA2, "shift")).length).toBe(flagsBefore);
    expect((await q("select count(*)::int n from ogevia.audit_events where action = 'caregiver.compliance_hold_opened' and (after_state ->> 'caregiver_record_id')::uuid = $1", [recA2])).rows[0].n).toBe(1);
  });

  it("the hold is sticky: moving the hire date later does not reopen the period; only an administrator may change it while a hold is open", async () => {
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Corrected the date')", [w.orgA, recA2, today]), "OGA03");
    await call(w.ownerA, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Hire date was entered wrongly')", [w.orgA, recA2, today]);
    expect(await openHold(recA2)).toBeDefined(); // still held
    expect((await blockers(recA2, new Date().toISOString())).every((b) => b.blocking)).toBe(true);
    await expectPgError(createShift(w.managerA, await add(9), "09:00", "11:00", recA2), "OGR30", /CPR missing/);
    await hireDaysAgo(recA2, 15);
  });

  it("partial resolution keeps the hold, listing only what is left; the last verification releases it automatically and audits who did it", async () => {
    await deliverCpr(recA2); // CPR verified by an administrator
    const hold = await openHold(recA2);
    expect((hold.reasons as any[]).map((r) => r.requirement)).toEqual(["tb"]);
    expect(await openFlags(recA2, "shift")).not.toHaveLength(0); // still flagged
    await deliverTb(recA2); // the last blocking requirement
    expect(await openHold(recA2)).toBeUndefined();
    const released = (await q("select released_by, release_note from ogevia.caregiver_compliance_holds where caregiver_record_id = $1 and released_at is not null", [recA2])).rows[0];
    expect(released.released_by).toBe(w.ownerA.userId);
    expect(released.release_note).toMatch(/not restored/);
    expect(await openFlags(recA2, "shift")).toHaveLength(0);
    expect(await openFlags(recA2, "assignment")).toHaveLength(0);
    expect((await q("select count(*)::int n from ogevia.audit_events a join ogevia.caregiver_compliance_holds h on h.id = a.entity_id where a.action = 'caregiver.compliance_hold_released' and a.actor_user_id = $1 and h.caregiver_record_id = $2", [w.ownerA.userId, recA2])).rows[0].n).toBe(1);
    // eligibility is back for new work...
    expect(await createShift(w.managerA, await add(9), "09:00", "11:00", recA2)).toHaveLength(1);
    // ...but nothing that was cancelled or reassigned is resumed
    expect((await q("select status::text s from ogevia.shifts where id=$1", [cancelled])).rows[0].s).toBe("cancelled");
    expect((await q("select caregiver_record_id from ogevia.shifts where id=$1", [reassigned])).rows[0].caregiver_record_id).toBe(recA3);
  });

  it("a hold with several causes is released only when ALL are resolved (background and CPR/TB)", async () => {
    await resetCaregiver(recA2);
    await setBackground(recA2, "completed_only");
    await hireDaysAgo(recA2, 30);
    await sweep();
    expect(((await openHold(recA2)).reasons as any[]).map((r) => r.requirement)).toEqual(["background", "cpr", "tb"]);
    await deliverCpr(recA2); await deliverTb(recA2);
    expect(((await openHold(recA2)).reasons as any[]).map((r) => r.requirement)).toEqual(["background"]); // documents alone do not release it
    const out = await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Confirmed in the agency clearance record') as c", [w.orgA, recA2]);
    expect(out[0].c).toMatchObject({ eligible: true, hold: null, background: { qualifies: true, result: "approved" } });
    expect(await openHold(recA2)).toBeUndefined();
  });

  it("a flagged shift that was reassigned or cancelled while the hold was open has its flag resolved, and is not resumed", async () => {
    await resetCaregiver(recA2); await resetCaregiver(recA3);
    await wipeShifts();
    await setBackground(recA2, "approved"); await hireDaysAgo(recA2, 2);
    await createShift(w.managerA, await add(3), "09:00", "11:00", recA2);
    const sh = (await q("select id from ogevia.shifts where caregiver_record_id = $1", [recA2])).rows[0].id;
    await hireDaysAgo(recA2, 20);
    await sweep();
    expect(await openFlags(recA2, "shift")).toHaveLength(1);
    await deliverCpr(recA3); await deliverTb(recA3); await setBackground(recA3, "approved"); await hireDaysAgo(recA3, 1);
    await call(w.managerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Coverage while on hold')", [w.orgA, sh, recA3]);
    await sweep();
    expect(await openFlags(recA2, "shift")).toHaveLength(0);
    expect((await q("select caregiver_record_id from ogevia.shifts where id=$1", [sh])).rows[0].caregiver_record_id).toBe(recA3);
    await deliverCpr(recA2); await deliverTb(recA2);
    expect((await q("select caregiver_record_id from ogevia.shifts where id=$1", [sh])).rows[0].caregiver_record_id).toBe(recA3); // release does not hand it back
  });
});

// ------------------------------------------------------------------ 4. permissions, evidence and audit
describe("who may do what, evidence and audit", () => {
  beforeAll(async () => {
    await resetCaregiver(recA1);
    await q("update ogevia.caregiver_records set hire_date = null where id = $1", [recA1]);
    await setBackground(recA1, "none");
  });

  it("only an administrator can verify background clearance; managers, schedulers, caregivers and other agencies cannot", async () => {
    for (const a of [w.managerA, w.schedulerA, w.caregiverA2]) {
      await expectPgError(call(a, "select ogevia_api.verify_background_check($1,$2,'approved','Confirmed in the agency record')", [w.orgA, recA1]), "OGA03");
    }
    await expectPgError(call(w.managerB, "select ogevia_api.verify_background_check($1,$2,'approved','Confirmed in the agency record')", [w.orgA, recA1]), "OGN04");
    expect(await openHold(recA1)).toBeUndefined();
    expect((await compliance(recA1)).background).toMatchObject({ qualifies: false, state: "not_recorded" });
  });

  it("verification needs a valid result and an evidence note; nobody can verify their own check", async () => {
    await expectPgError(call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'completed','Confirmed in the agency record')", [w.orgA, recA1]), "OGV22");
    await expectPgError(call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','  ')", [w.orgA, recA1]), "OGV22");
    const rec = (await q("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1,$2,'CG-OWNER','Synthetic','Owner','ready') returning id", [w.orgA, w.ownerA.userId])).rows[0].id as string;
    await expectPgError(call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Confirmed in the agency record')", [w.orgA, rec]), "OGA03", /your own/);
  });

  it("a manager can track the check's status but never record a result; reopening an approved check withdraws the approval", async () => {
    const t = await call(w.managerA, "select ogevia_api.set_background_check_status($1,$2,'pending','Waiting for the agency to confirm') as c", [w.orgA, recA1]);
    expect(t[0].c.background).toMatchObject({ status: "pending", qualifies: false });
    await expectPgError(call(w.caregiverA2, "select ogevia_api.set_background_check_status($1,$2,'completed')", [w.orgA, recA1]), "OGA03");
    await expectPgError(call(w.managerA, "select ogevia_api.set_background_check_status($1,$2,'approved')", [w.orgA, recA1]), "OGV22");
    const done = await call(w.managerA, "select ogevia_api.set_background_check_status($1,$2,'completed') as c", [w.orgA, recA1]);
    expect(done[0].c.background).toMatchObject({ status: "completed", qualifies: false, state: "completed_not_approved" }); // completed is NOT clearance
    const v = await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Confirmed in the agency clearance record') as c", [w.orgA, recA1]);
    expect(v[0].c.background).toMatchObject({ qualifies: true, verifiedByName: "OWNER_A" });
    const reopened = await call(w.managerA, "select ogevia_api.set_background_check_status($1,$2,'needs_attention','Agency asked for a new report') as c", [w.orgA, recA1]);
    expect(reopened[0].c.background).toMatchObject({ qualifies: false, result: null });
    expect((await q("select verified_by, verified_at from ogevia.caregiver_background_checks where caregiver_record_id = $1", [recA1])).rows[0]).toEqual({ verified_by: null, verified_at: null });
  });

  it("hire date: the office may set one that is not recorded; changing a recorded one is administrator-only; a reason is required; every change is audited", async () => {
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,' ')", [w.orgA, recA1, today]), "OGV22");
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_hire_date($1,$2,'1990-01-01'::date,'Offer letter')", [w.orgA, recA1]), "OGV22");
    await expectPgError(call(w.schedulerA, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Offer letter')", [w.orgA, recA1, today]), "OGA03");
    await expectPgError(call(w.caregiverA2, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Offer letter')", [w.orgA, recA1, today]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Offer letter')", [w.orgA, recA1, today]), "OGN04");
    const first = await call(w.managerA, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Offer letter signed') as c", [w.orgA, recA1, await add(-3)]);
    expect(first[0].c).toMatchObject({ hireDate: await add(-3), dueDate: await add(11), inGrace: true });
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Moved it')", [w.orgA, recA1, await add(-1)]), "OGA03", /administrator/);
    await call(w.ownerA, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,'Start date corrected by the offer letter')", [w.orgA, recA1, await add(-5)]);
    const rows = (await q("select actor_user_id, reason, before_state, after_state, occurred_at from ogevia.audit_events where action = 'caregiver.hire_date_set' and entity_id = $1 order by id", [recA1])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_user_id: w.managerA.userId, reason: "Offer letter signed", before_state: { hire_date: null } });
    expect(rows[1]).toMatchObject({ actor_user_id: w.ownerA.userId, before_state: { hire_date: await add(-3) }, after_state: { hire_date: await add(-5) } });
    expect(rows[1].occurred_at).toBeInstanceOf(Date);
  });

  it("background changes are audited with who and when; a retried request with the same key returns the same answer", async () => {
    const key = randomUUID();
    const a = await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Confirmed in the agency clearance record',$3) as c", [w.orgA, recA1, key]);
    const b = await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Confirmed in the agency clearance record',$3) as c", [w.orgA, recA1, key]);
    expect(b[0].c).toEqual(a[0].c);
    const rows = (await q("select actor_user_id, action from ogevia.audit_events where entity_id = $1 and action like 'caregiver.background_%' order by id", [recA1])).rows;
    expect(rows.map((r) => r.action)).toEqual(["caregiver.background_status_set", "caregiver.background_status_set", "caregiver.background_verified", "caregiver.background_status_set", "caregiver.background_verified"]);
    expect(rows.at(-1)!.actor_user_id).toBe(w.ownerA.userId);
  });

  it("compliance is read by staff only; a caregiver and another agency are refused", async () => {
    await expectPgError(call(w.caregiverA2, "select ogevia_api.get_caregiver_compliance($1,$2)", [w.orgA, recA1]), "OGA03");
    await expectPgError(call(w.caregiverA2, "select ogevia_api.list_compliance_holds($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.get_caregiver_compliance($1,$2)", [w.orgA, recA1]), "OGN04");
    await expectPgError(call(w.managerB, "select ogevia_api.list_compliance_holds($1)", [w.orgA]), "OGN04");
    expect((await call(w.caregiverA2, "select ogevia_api.get_compliance_attention($1) as a", [w.orgA]))[0].a).toBeNull();
    expect((await call(w.managerB, "select ogevia_api.get_compliance_attention($1) as a", [w.orgA]))[0].a).toBeNull();
    // no signed-in person can start the all-agency run through the staff entry point
    await expectPgError(call(w.caregiverA2, "select ogevia_api.run_compliance_sweep($1)", [w.orgA]), "OGA03");
    // and the other agency's data is invisible to the run an agency's own staff can start
    await expect(call(w.managerA, "select ogevia_api.run_compliance_sweep($1) as r", [w.orgA])).resolves.toHaveLength(1);
  });
});
