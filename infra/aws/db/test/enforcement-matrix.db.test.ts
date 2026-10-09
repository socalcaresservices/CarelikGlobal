// The enforcement matrix: for each readiness condition, is ASSIGNMENT and a caregiver's NEW VISIT START blocked
// in report-only mode, after activation, and after activation with Service checks On? The expected table below is
// the same table published in docs/releases/caregiver-readiness/ENFORCEMENT_MATRIX.md.
// SYNTHETIC data only. Dates are computed from the agency-local "today".
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let recA3: string;
let cpr: string;
let tb: string;
let fx: { client: string; service: string; auth: string };
const LA = "America/Los_Angeles";
const sha = "c".repeat(64);

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const dowOf = async (d: string) => (await db.admin.query<{ n: number }>("select extract(dow from $1::date)::int n", [d])).rows[0]!.n;
const recOf = async (a: Actor) => (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;

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
});
afterAll(async () => db?.drop());

/** Gives a caregiver verified CPR and TB valid far into the future. */
async function makeDocsCurrent(rec: string, owner: Actor) {
  for (const [type, expires] of [[cpr, await add(400)], [tb, null]] as const) {
    let doc = (await db.admin.query("select id from ogevia.staff_documents where caregiver_record_id=$1 and document_type_id=$2 and closed_at is null", [rec, type])).rows[0]?.id as string | undefined;
    if (!doc) doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
    const version = randomUUID();
    const row = (await call(owner, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
      doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(-5), expires]))[0];
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
  }
}
async function resetCaregiverDocs(rec: string) {
  await db.admin.query("update ogevia.staff_documents set closed_at = now() where caregiver_record_id = $1 and closed_at is null", [rec]);
}
async function baseline(a: Actor, windows: { weekday: number; start_local: string; end_local: string }[]) {
  const rec = await recOf(a);
  await db.admin.query("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [rec]);
  await db.admin.query("delete from ogevia.caregiver_unavailable_dates where caregiver_record_id = $1", [rec]);
  for (const x of windows) await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,$4,$5)", [w.orgA, rec, x.weekday, x.start_local, x.end_local]);
}
const allWeek = (s = "00:00", e = "23:59") => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, start_local: s, end_local: e }));
const reset = async () => {
  await db.admin.query("delete from ogevia.assignment_readiness_flags; delete from ogevia.shift_readiness_flags;");
  await db.admin.query("delete from ogevia.authorization_reservations where shift_id is not null");
  await db.admin.query("delete from ogevia.shift_coverage_events;");
  await db.admin.query("delete from ogevia.care_request_events; delete from ogevia.care_notifications; delete from ogevia.care_request_offers; delete from ogevia.care_requests");
  await db.admin.query("delete from ogevia.shifts where not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = shifts.id)");
};
const createShift = (a: Actor, day: string, start: string, end: string, rec: string | null, service = fx.service, client = fx.client) =>
  call(a, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [w.orgA, client, service, day, start, end, rec]);

async function configureDocumentRules() {
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
}
const status = (a: Actor = w.ownerA) => call(a, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]).then((r) => r[0].s);
const activate = (a: Actor = w.ownerA, count?: number) =>
  status().then((s) => call(a, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2) as s", [w.orgA, count ?? s.affectedShiftsCount])).then((r) => r[0].s);
const serviceChecks = (a: Actor, on: boolean, reason = "Review complete") => call(a, "select ogevia_api.set_service_checks($1,$2,$3) as s", [w.orgA, on, reason]).then((r) => r[0].s);
const evaluate = (rec: string, svc: string | null, from: string, to: string, ctx = "shift", client: string | null = null) =>
  call(w.managerA, "select ogevia_api.evaluate_assignment_readiness($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,null,$7) as r", [w.orgA, rec, svc, from, to, ctx, client]).then((r) => r[0].r);
const at = (day: string, time: string) => `${day} ${time}-08`;
const approveService = (rec: string, svc: string, reason = "Observed visit completed") =>
  call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,$5)", [w.orgA, rec, svc, today, reason]);


type Cond = "missing CPR" | "expired CPR" | "missing TB" | "unverified TB" | "missing service approval" | "unavailable caregiver" | "overlap";
type Phase = "report-only" | "active" | "active + service checks on";
type Result = { assignment: "blocked" | "allowed"; visitStart: "blocked" | "allowed" };

/** The published matrix. "blocked" means the commit is refused (OGR30, or OGC09 for double-booking). */
const EXPECTED: Record<Cond, Record<Phase, Result>> = {
  "missing CPR":              { "report-only": { assignment: "allowed", visitStart: "allowed" }, active: { assignment: "blocked", visitStart: "blocked" }, "active + service checks on": { assignment: "blocked", visitStart: "blocked" } },
  "expired CPR":              { "report-only": { assignment: "allowed", visitStart: "allowed" }, active: { assignment: "blocked", visitStart: "blocked" }, "active + service checks on": { assignment: "blocked", visitStart: "blocked" } },
  "missing TB":               { "report-only": { assignment: "allowed", visitStart: "allowed" }, active: { assignment: "blocked", visitStart: "blocked" }, "active + service checks on": { assignment: "blocked", visitStart: "blocked" } },
  "unverified TB":            { "report-only": { assignment: "allowed", visitStart: "allowed" }, active: { assignment: "blocked", visitStart: "blocked" }, "active + service checks on": { assignment: "blocked", visitStart: "blocked" } },
  "missing service approval": { "report-only": { assignment: "allowed", visitStart: "allowed" }, active: { assignment: "allowed", visitStart: "allowed" }, "active + service checks on": { assignment: "blocked", visitStart: "blocked" } },
  "unavailable caregiver":    { "report-only": { assignment: "allowed", visitStart: "allowed" }, active: { assignment: "blocked", visitStart: "allowed" }, "active + service checks on": { assignment: "blocked", visitStart: "allowed" } },
  overlap:                    { "report-only": { assignment: "blocked", visitStart: "blocked" }, active: { assignment: "blocked", visitStart: "blocked" }, "active + service checks on": { assignment: "blocked", visitStart: "blocked" } },
};
const CONDS = Object.keys(EXPECTED) as Cond[];
const observed: Record<string, Record<string, Result>> = {};

async function setDocs(rec: string, cprState: "current" | "missing" | "expired", tbState: "current" | "missing" | "unverified") {
  await resetCaregiverDocs(rec);
  const mk = async (type: string, expires: string | null, issued: string, review: boolean) => {
    const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
    const version = randomUUID();
    const row = (await call(w.caregiverA1, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
      doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, issued, expires]))[0];
    if (review) await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
  };
  if (cprState === "current") await mk(cpr, await add(400), await add(-5), true);
  if (cprState === "expired") await mk(cpr, await add(-1), await add(-400), true);
  if (tbState === "current") await mk(tb, null, await add(-5), true);
  if (tbState === "unverified") await mk(tb, null, await add(-5), false);
}

async function arrange(c: Cond, day: string) {
  await reset();
  await db.admin.query("delete from ogevia.caregiver_service_approvals where caregiver_record_id = $1", [recA1]);
  const ok = async () => { await setDocs(recA1, "current", "current"); await baseline(w.caregiverA1, allWeek()); await approveService(recA1, fx.service); };
  await ok();
  if (c === "missing CPR") await setDocs(recA1, "missing", "current");
  if (c === "expired CPR") await setDocs(recA1, "expired", "current");
  if (c === "missing TB") await setDocs(recA1, "current", "missing");
  if (c === "unverified TB") await setDocs(recA1, "current", "unverified");
  if (c === "missing service approval") await db.admin.query("delete from ogevia.caregiver_service_approvals where caregiver_record_id = $1", [recA1]);
  if (c === "unavailable caregiver") await baseline(w.caregiverA1, []);
  if (c === "overlap") {
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, ($6 || ' 09:00')::timestamp at time zone $7, ($6 || ' 11:00')::timestamp at time zone $7, 'scheduled')`,
      [w.orgA, fx.client, fx.service, w.caregiverA1.userId, recA1, day, LA]);
  }
}

async function probe(c: Cond, day: string): Promise<Result> {
  await arrange(c, day);
  let assignment: Result["assignment"] = "allowed";
  try { await createShift(w.managerA, day, "09:00", "11:00", recA1); } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "OGR30" && code !== "OGC09") throw e;
    assignment = "blocked";
  }
  // A caregiver starting a NEW visit, on a client the caregiver is assigned to. (Overlap and availability are about schedules; they are
  // not checked at the moment of starting a visit, which is why the only visit-start blocks are CPR/TB and an enforced service approval.)
  const f2 = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  if (c === "overlap") {
    // The caregiver is already booked on a shift that is happening now (another client): a new visit cannot start (PR #76: new_live_visit_readiness).
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, now() - interval '30 minutes', now() + interval '90 minutes', 'scheduled')`, [w.orgA, fx.client, fx.service, w.caregiverA1.userId, recA1]);
  }
  await db.admin.query("delete from ogevia.caregiver_service_approvals where caregiver_record_id = $1 and service_id = $2", [recA1, f2.service]);
  if (c !== "missing service approval") await approveService(recA1, f2.service);
  let visitStart: Result["visitStart"] = "allowed";
  try {
    const id = (await call(w.caregiverA1, "select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null) as id", [w.orgA, f2.client, f2.service]))[0].id as string;
    const cl = await db.admin.connect();
    try { await cl.query("set session_replication_role = replica"); await cl.query("delete from ogevia.service_visits where id = $1", [id]); } finally { await cl.query("reset session_replication_role"); cl.release(); }
  } catch (e) {
    if ((e as { code?: string }).code !== "OGR30") throw e;
    visitStart = "blocked";
  }
  if (c === "overlap") await db.admin.query("delete from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled' and starts_at < now() + interval '1 day'", [recA1]);
  return { assignment, visitStart };
}

async function runPhase(phase: Phase) {
  observed[phase] = {};
  let n = 30;
  for (const c of CONDS) observed[phase]![c] = await probe(c, await add(n++));
}

describe("enforcement matrix", () => {
  it("setup: document types and validity rules are set, but enforcement is NOT active", async () => {
    await configureDocumentRules();
    expect((await status()).enforcementActive).toBe(false);
  });
  it("report-only: only overlap is refused; every missing or expired document is allowed (and reported as 'would block')", async () => {
    await runPhase("report-only");
    for (const c of CONDS) expect(observed["report-only"]![c], c).toEqual(EXPECTED[c]["report-only"]);
  });
  it("report-only is reported as NOT satisfying the CPR/TB requirement", async () => {
    await arrange("missing CPR", await add(60));
    const ev = await evaluate(recA1, fx.service, at(await add(61), "09:00"), at(await add(61), "11:00"));
    expect(ev.ready).toBe(true); // nothing is refused yet...
    expect(ev.wouldBlockAfterActivation).toBe(true); // ...but this caregiver does not have current verified CPR
    const st = await status();
    expect(st.enforcementActive).toBe(false);
  });
  it("active: CPR and TB are refused at assignment and at visit start; service approval and visit-time availability are not", async () => {
    await arrange("missing CPR", await add(62));
    await activate();
    expect((await status()).enforcementActive).toBe(true);
    await runPhase("active");
    for (const c of CONDS) expect(observed.active![c], c).toEqual(EXPECTED[c].active);
  });
  it("active + Service checks On: a missing service approval is refused too; CPR/TB stay refused", async () => {
    await serviceChecks(w.ownerA, true);
    await runPhase("active + service checks on");
    for (const c of CONDS) expect(observed["active + service checks on"]![c], c).toEqual(EXPECTED[c]["active + service checks on"]);
    await serviceChecks(w.ownerA, false); // switching Off again never disables CPR/TB
    await arrange("missing CPR", await add(63));
    await expectPgError(createShift(w.managerA, await add(64), "09:00", "11:00", recA1), "OGR30", /CPR missing\./);
  });
});
