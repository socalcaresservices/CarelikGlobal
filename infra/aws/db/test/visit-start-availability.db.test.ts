// 0046: approved availability is checked when a NEW visit starts (caregiver-started and manager-started), after activation.
// Only a recorded administrator override lifts it, and only it. SYNTHETIC data only.
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


async function setDocs(rec: string, cprState: "current" | "missing" | "expired", tbState: "current" | "missing" | "unverified", uploader: Actor = w.caregiverA1) {
  await resetCaregiverDocs(rec);
  const mk = async (type: string, expires: string | null, issued: string, review: boolean) => {
    const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
    const version = randomUUID();
    const row = (await call(uploader, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
      doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, issued, expires]))[0];
    if (review) await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
  };
  if (cprState === "current") await mk(cpr, await add(400), await add(-5), true);
  if (cprState === "expired") await mk(cpr, await add(-1), await add(-400), true);
  if (tbState === "current") await mk(tb, null, await add(-5), true);
  if (tbState === "unverified") await mk(tb, null, await add(-5), false);
}


const DAY_WINDOWS = allWeek;
let mgrRec: string;
const startVisit = async (actor: Actor, f: { client: string; service: string }) => {
  const id = (await call(actor, "select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null,'Synthetic unscheduled test visit') as id", [w.orgA, f.client, f.service]))[0].id as string;
  return id;
};
/** Removes a visit the test started so the next start is not refused by the one-open-visit rule (test cleanup only). */
const dropVisit = async (id: string) => {
  const c = await db.admin.connect();
  try { await c.query("set session_replication_role = replica"); await c.query("delete from ogevia.service_visits where id = $1", [id]); } finally { await c.query("reset session_replication_role"); c.release(); }
};
const overrideNow = (rec: string, client: string, from = "now() - interval '5 minutes'", to = "now() + interval '3 hours'") =>
  db.admin.query(`select 1`).then(() => call(w.ownerA, `select ogevia_api.authorize_availability_override($1,$2,${from},${to},'Agency asked for this worker today',$3) as id`, [w.orgA, rec, client])).then((r) => r[0].id as string);
/** 0047: an override is single-use, so each attempt that must be lifted gets a fresh one for this caregiver and client. */
const attemptOv = async (actor: Actor, f: { client: string; service: string }, rec: string) => {
  await db.admin.query("delete from ogevia.availability_overrides where consumed_at is null");
  try { await overrideNow(rec, f.client); } catch (e) { if (!/nothing to override/.test(String((e as Error).message))) throw e; } // already available: no override needed
  return attempt(actor, f);
};
const attempt = async (actor: Actor, f: { client: string; service: string }) => {
  try { const id = await startVisit(actor, f); await dropVisit(id); return "allowed"; } catch (e) { return `${(e as { code?: string }).code}: ${(e as Error).message}`; }
};
const ensureApproval = (rec: string, svc: string) => approveService(rec, svc).catch((e) => { if (!/already has an approval/.test(String(e.message))) throw e; });
const fresh = (a: Actor) => freshClient(db, w, a, 100000, w.orgA, { before: 5, after: 120 });


describe("report-only: availability is not required at visit start", () => {
  it("setup and a worker with no approved hours can still start a visit before activation", async () => {
    await configureDocumentRules();
    await reset();
    await setDocs(recA1, "current", "current");
    await baseline(w.caregiverA1, []);
    const f = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f.service);
    expect(await attempt(w.caregiverA1, f)).toBe("allowed");
    expect((await status()).enforcementActive).toBe(false);
  });
});

describe("after activation: new visit starts need approved availability", () => {
  it("activate; manager-worker record is created for the manager-started cases", async () => {
    await activate();
    expect((await status()).enforcementActive).toBe(true);
    mgrRec = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1,$2,'CG-MGR','Synthetic','Manager','active') returning id", [w.orgA, w.managerA.userId])).rows[0].id as string;
    await db.admin.query("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','approved','Synthetic fixture clearance',$3,now())", [mgrRec, w.orgA, w.ownerA.userId]);
    await setDocs(mgrRec, "current", "current", w.managerA);
  });

  it("no approved hours: a caregiver-started and a manager-started visit are both refused, with the availability message", async () => {
    await baseline(w.caregiverA1, []);
    await db.admin.query("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [mgrRec]);
    const f = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f.service);
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Availability not provided\.$/);
    expect(await attempt(w.managerA, f)).toMatch(/^OGR30: Availability not provided\./);
  });

  it("hours that do not cover the moment of the start are refused ('Outside approved hours')", async () => {
    const dow = (await db.admin.query("select extract(dow from (now() at time zone 'America/Los_Angeles'))::int d")).rows[0].d as number;
    await baseline(w.caregiverA1, [{ weekday: (dow + 1) % 7, start_local: "00:00", end_local: "23:59" }]); // only tomorrow
    const f = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f.service);
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Outside approved hours\.$/);
  });

  it("approved hours covering the start: allowed for both a caregiver and a manager-worker", async () => {
    await baseline(w.caregiverA1, DAY_WINDOWS());
    await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) select $1,$2,d,'00:00','23:59' from generate_series(0,6) d", [w.orgA, mgrRec]);
    const f = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f.service);
    expect(await attempt(w.caregiverA1, f)).toBe("allowed");
    expect(await attempt(w.managerA, f)).toBe("allowed");
  });

  it("a recorded administrator override covering the interval allows the start once, is counted and audited, and expires", async () => {
    await baseline(w.caregiverA1, []);
    const f = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f.service);
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Availability not provided\./);
    await expectPgError(call(w.managerA, "select ogevia_api.authorize_availability_override($1,$2,now(),now() + interval '1 hour','Because',$3)", [w.orgA, recA1, f.client]), "OGA03"); // administrators only
    const id = await overrideNow(recA1, f.client);
    expect(await attempt(w.caregiverA1, f)).toBe("allowed");
    const ov = (await db.admin.query("select used_count, reason, consumed_at from ogevia.availability_overrides where id = $1", [id])).rows[0];
    expect(ov.used_count).toBe(1);
    expect(ov.consumed_at).not.toBeNull();
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'availability.override_used' and entity_id = $1", [id])).rows[0].n).toBe(1);
    // One use only: the next start is refused again.
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Availability not provided\./);
    // An override that has expired, does not cover now, belongs to another caregiver or to another client does nothing.
    const expired = await overrideNow(recA1, f.client);
    await db.admin.query("update ogevia.availability_overrides set expires_at = now() - interval '1 minute' where id = $1", [expired]);
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Availability not provided\./);
    await db.admin.query("delete from ogevia.availability_overrides");
    await overrideNow(recA2, f.client);
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Availability not provided\./);
    await db.admin.query("delete from ogevia.availability_overrides");
    await overrideNow(recA1, f.client, "now() + interval '1 hour'", "now() + interval '3 hours'"); // starts later: does not cover this start
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Availability not provided\./);
    await db.admin.query("delete from ogevia.availability_overrides");
    const elsewhere = await fresh(w.caregiverA1);
    await ensureApproval(recA1, elsewhere.service);
    await overrideNow(recA1, elsewhere.client); // approved for a different client
    expect(await attempt(w.caregiverA1, f)).toMatch(/^OGR30: Availability not provided\./);
    await db.admin.query("delete from ogevia.availability_overrides");
  });

  it("an override never bypasses another mandatory check: CPR/TB, status, overlap, service approval (when On), mandatory client requirement", async () => {
    await baseline(w.caregiverA1, []);
    const f = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f.service);
    // CPR/TB
    await setDocs(recA1, "missing", "missing");
    const m = await attemptOv(w.caregiverA1, f, recA1);
    expect(m).toMatch(/^OGR30: CPR missing\./);
    expect(m).not.toMatch(/Availability/);
    await setDocs(recA1, "current", "current");
    expect(await attemptOv(w.caregiverA1, f, recA1)).toBe("allowed"); // control: the override does work when everything else is fine
    // Overlap
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, now() - interval '30 minutes', now() + interval '90 minutes', 'scheduled')`, [w.orgA, fx.client, fx.service, w.caregiverA1.userId, recA1]);
    const f2 = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f2.service);
    expect(await attemptOv(w.caregiverA1, f2, recA1)).toMatch(/^OGR30: Already booked\./);
    await db.admin.query("delete from ogevia.shifts where caregiver_record_id = $1 and status = 'scheduled'", [recA1]);
    // Mandatory client requirement
    const tag = (await call(w.managerA, "select ogevia_api.create_experience_tag($1,'Dementia care') as id", [w.orgA]))[0].id;
    await call(w.managerA, "select ogevia_api.set_client_experience_requirements($1,$2,$3::jsonb,'Medical need')", [w.orgA, f2.client, JSON.stringify([{ tagId: tag, mandatory: true }])]);
    expect(await attemptOv(w.caregiverA1, f2, recA1)).toMatch(/Required experience not confirmed: Dementia care\./);
    await db.admin.query("delete from ogevia.client_experience_requirements");
    // Enforced service approval
    await serviceChecks(w.ownerA, true);
    await db.admin.query("delete from ogevia.caregiver_service_approvals where caregiver_record_id = $1 and service_id = $2", [recA1, f2.service]);
    expect(await attemptOv(w.caregiverA1, f2, recA1)).toMatch(/^OGR30: Service not approved/);
    await serviceChecks(w.ownerA, false);
    // Caregiver status
    await db.admin.query("delete from ogevia.availability_overrides where consumed_at is null");
    await overrideNow(recA1, f2.client);
    await db.admin.query("update ogevia.caregiver_records set status = 'inactive' where id = $1", [recA1]);
    expect(await attempt(w.caregiverA1, f2)).not.toBe("allowed");
    await db.admin.query("update ogevia.caregiver_records set status = 'active' where id = $1", [recA1]);
    // A manager-worker with an override still needs CPR/TB.
    await setDocs(mgrRec, "missing", "current", w.managerA);
    expect(await attemptOv(w.managerA, f2, mgrRec)).toMatch(/CPR missing\./);
    await db.admin.query("delete from ogevia.availability_overrides");
  });

  it("another agency's override or caregiver never helps; the new check does not touch a visit already in progress, a historical visit, or an update to either", async () => {
    await baseline(w.caregiverA1, DAY_WINDOWS());
    await setDocs(recA1, "current", "current");
    const f = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f.service);
    const running = await startVisit(w.caregiverA1, f);          // started while available
    await baseline(w.caregiverA1, []);                            // hours are withdrawn afterwards
    await db.admin.query("delete from ogevia.availability_overrides");
    // The running visit is untouched and can be updated; only a NEW start is refused.
    expect((await db.admin.query("select status::text s from ogevia.service_visits where id = $1", [running])).rows[0].s).toBe("draft");
    // ...and it can still be ended after the hours were withdrawn (ending a visit is not a new start); an ended visit is no longer a draft, i.e. it is history.
    { const c = await db.admin.connect(); try { await c.query("set session_replication_role = replica"); await c.query("update ogevia.service_visits set time_in = time_in - interval '10 minutes' where id = $1", [running]); } finally { await c.query("reset session_replication_role"); c.release(); } }
    const ended = await call(w.caregiverA1, "select * from ogevia_api.end_service_visit($1)", [running]);
    expect(ended).toHaveLength(1);
    expect((await db.admin.query("select status::text s from ogevia.service_visits where id = $1", [running])).rows[0].s).not.toBe("draft");
    await dropVisit(running);
    const f2 = await fresh(w.caregiverA1);
    await ensureApproval(recA1, f2.service);
    expect(await attempt(w.caregiverA1, f2)).toMatch(/^OGR30: Availability not provided\./);
  });

  it("0046 ships with a classified rollback that restores the previous behaviour", () => {
    const down = readFileSync(new URL("../rollback/0046_visit_start_availability.down.sql", import.meta.url), "utf8");
    expect(down).toMatch(/CLASS: SAFE AUTOMATED/);
    expect(down).not.toMatch(/'visit_start'\) then/);
  });
});
