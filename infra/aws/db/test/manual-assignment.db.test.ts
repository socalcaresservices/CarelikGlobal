// Manual assignment: a caregiver the Matches list excludes can still be assigned by an administrator.
// Missing score data, distance or optional experience never blocks; mandatory requirements still do.
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


const authOverride = (rec: string, from: string, to: string, reason = "Agency asked for this caregiver") =>
  call(w.ownerA, "select ogevia_api.authorize_availability_override($1,$2,$3::timestamptz,$4::timestamptz,$5) as id", [w.orgA, rec, from, to, reason]).then((r) => r[0].id as string);
const matchFor = (day: string) =>
  call(w.managerA, "select ogevia_api.match_caregivers($1,$2,$3,$4::jsonb,null,null) as r", [w.orgA, fx.service, fx.client,
    JSON.stringify([{ starts_at: `${day}T09:00:00-07:00`, ends_at: `${day}T11:00:00-07:00` }])]).then((r) => r[0].r);
const cand = (r: any, code: string) => r.candidates.find((c: any) => c.caregiverCode === code);
const mkRequest = async (day: string) => (await db.admin.query<{ id: string }>(
  `insert into ogevia.care_requests(organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key, status)
   values ($1,$2,$3,$4, ($5 || ' 09:00')::timestamp at time zone $6, ($5 || ' 12:30')::timestamp at time zone $6, 210, gen_random_uuid(), 'requested') returning id`,
  [w.orgA, fx.client, fx.service, fx.auth, day, LA])).rows[0]!.id;
const offerTo = (req: string, rec: string) =>
  call(w.managerA, "select ogevia_api.send_care_offer($1,$2,$3,$4) as id", [w.orgA, req, rec, randomBytes(32).toString("hex")]).then((r) => r[0].id as string);
const accept = (offer: string) => db.admin.query("update ogevia.care_request_offers set status='available', responded_at=now() where id=$1", [offer]);

describe("report-only: a caregiver with no score data is not blocked from manual assignment", () => {
  it("no ZIP, no experience and no approved hours: Matches marks the score incomplete / excludes them, and the administrator can still assign by hand", async () => {
    await reset();
    await baseline(w.caregiverA1, allWeek());
    await baseline(w.caregiverA2, []);
    const day = await add(3);
    const m = await matchFor(day);
    expect(cand(m, "CG-A1").eligibility).toBe("eligible");
    expect(cand(m, "CG-A1").score.complete).toBe(false); // location is missing: never fabricated
    expect(cand(m, "CG-A2").eligibility).toBe("not_eligible"); // excluded from Matches
    expect(await createShift(w.managerA, day, "09:00", "11:00", recA2)).toHaveLength(1); // report-only: nothing is enforced yet
    expect(await createShift(w.managerA, day, "13:00", "15:00", recA1)).toHaveLength(1); // incomplete score does not block
  });
});

describe("after activation: Matches exclusion is not an assignment block, but mandatory checks are", () => {
  it("set-up: CPR and TB rules, current documents for A1 and A2 only, activation", async () => {
    await reset();
    await configureDocumentRules();
    await makeDocsCurrent(recA1, w.ownerA);
    await makeDocsCurrent(recA2, w.ownerA);
    await baseline(w.caregiverA1, allWeek());
    await baseline(w.caregiverA2, []);
    await baseline(w.caregiverA3, allWeek());
    await resetCaregiverDocs(recA3);
    await activate();
    expect((await status()).enforcementActive).toBe(true);
  });

  it("a caregiver with no ZIP and no experience data (incomplete score) is assigned by hand", async () => {
    const day = await add(4);
    const m = await matchFor(day);
    expect(cand(m, "CG-A1")).toMatchObject({ eligibility: "eligible" });
    expect(cand(m, "CG-A1").score.complete).toBe(false);
    expect(await createShift(w.managerA, day, "09:00", "11:00", recA1)).toHaveLength(1);
  });

  it("excluded for availability: blocked without an override; assigned with a recorded, reasoned, audited override (shift)", async () => {
    const day = await add(5);
    expect(cand(await matchFor(day), "CG-A2").eligibility).toBe("not_eligible");
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA2), "OGR30", /^Availability not provided\.$/);
    await expectPgError(call(w.managerA, "select ogevia_api.authorize_availability_override($1,$2,now(),now() + interval '30 days','Because')", [w.orgA, recA2]), "OGA03"); // administrators only
    const id = await authOverride(recA2, at(day, "00:00"), at(await add(6), "00:00"));
    expect(await createShift(w.managerA, day, "09:00", "11:00", recA2)).toHaveLength(1);
    const ov = (await db.admin.query("select reason, authorised_by, used_count from ogevia.availability_overrides where id = $1", [id])).rows[0];
    expect(ov).toMatchObject({ reason: "Agency asked for this caregiver", used_count: 1 });
    expect(ov.authorised_by).toBeTruthy();
    const audit = await db.admin.query("select 1 from ogevia.audit_events where action in ('availability.override_authorized','availability.override_used') and entity_id = $1", [id]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(2);
  });

  it("the override lifts availability ONLY: missing CPR/TB, overlap, caregiver status and mandatory client requirements still block", async () => {
    const day = await add(7);
    const from = at(day, "00:00"), to = at(await add(8), "00:00");
    // A3 has no CPR/TB and no approved hours; override covers the hours but not the documents.
    await authOverride(recA3, from, to);
    await baseline(w.caregiverA3, []);
    await expectPgError(createShift(w.managerA, day, "09:00", "11:00", recA3), "OGR30", /CPR missing\.\s+TB missing\./);
    // Overlap with the override in place for A2.
    await authOverride(recA2, from, to);
    expect(await createShift(w.managerA, day, "09:00", "11:00", recA2)).toHaveLength(1);
    await expectPgError(createShift(w.managerA, day, "10:00", "12:00", recA2), "OGC09", /already has a shift/);
    // Mandatory client experience that A2 has not had confirmed.
    const tag = (await call(w.managerA, "select ogevia_api.create_experience_tag($1,'Dementia care') as id", [w.orgA]))[0].id;
    await call(w.managerA, "select ogevia_api.set_client_experience_requirements($1,$2,$3::jsonb,'Medical need')", [w.orgA, fx.client, JSON.stringify([{ tagId: tag, mandatory: true }])]);
    await expectPgError(createShift(w.managerA, day, "13:00", "15:00", recA2), "OGR30", /Required experience not confirmed: Dementia care\./);
    await call(w.managerA, "select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],null)", [w.orgA, recA2, `{${tag}}`]);
    expect(await createShift(w.managerA, day, "13:00", "15:00", recA2)).toHaveLength(1);
    await db.admin.query("delete from ogevia.client_experience_requirements");
    // An inactive caregiver cannot be assigned.
    await db.admin.query("update ogevia.caregiver_records set status = 'inactive' where id = $1", [recA2]);
    await expectPgError(createShift(w.managerA, day, "16:00", "17:00", recA2), "OGV22");
    await db.admin.query("update ogevia.caregiver_records set status = 'active' where id = $1", [recA2]);
  });

  it("tenant access: another agency's administrator cannot assign this agency's caregiver, and an administrator cannot assign another agency's caregiver", async () => {
    const day = await add(9);
    await expect(call(w.managerB, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, fx.client, fx.service, day, recA1])).rejects.toBeTruthy();
    const recB = (await db.admin.query("select id from ogevia.caregiver_records where organization_id = $1 limit 1", [w.orgB])).rows[0]?.id as string | undefined;
    if (recB) await expect(createShift(w.managerA, day, "09:00", "11:00", recB)).rejects.toBeTruthy();
  });

  it("a care-request offer can be sent to a caregiver Matches excludes; the gate decides at assignment (override lifts hours only)", async () => {
    await reset();
    await baseline(w.caregiverA2, []);
    const day = await add(10);
    const req = await mkRequest(day);
    const list = await call(w.managerA, "select * from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, req]);
    expect(list.map((x) => x.caregiver_name.split(" ").pop())).not.toContain("CG-A2"); // excluded from Matches
    const offer = await offerTo(req, recA2); // manual offer is allowed
    expect(offer).toBeTruthy();
    await accept(offer);
    await expectPgError(call(w.managerA, "select ogevia_api.assign_care_request($1,$2,$3)", [w.orgA, req, offer]), "OGR30", /^Availability not provided\.$/);
    await authOverride(recA2, at(day, "00:00"), at(await add(11), "00:00"));
    const assigned = await call(w.managerA, "select ogevia_api.assign_care_request($1,$2,$3) as id", [w.orgA, req, offer]);
    expect(assigned[0].id).toBeTruthy();
  });

  it("a care-request offer to a caregiver without CPR/TB can be sent but never assigned; offers need an active caregiver of this agency and an open request", async () => {
    await reset();
    const day = await add(12);
    const req = await mkRequest(day);
    await baseline(w.caregiverA3, allWeek()); // hours fine; documents missing
    const offer = await offerTo(req, recA3);
    await accept(offer);
    await expectPgError(call(w.managerA, "select ogevia_api.assign_care_request($1,$2,$3)", [w.orgA, req, offer]), "OGR30", /CPR missing\./);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.send_care_offer($1,$2,$3,$4)", [w.orgA, req, recA1, "e".repeat(64)]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.send_care_offer($1,$2,$3,$4)", [w.orgA, req, recA1, "e".repeat(64)]), "OGA03");
    await db.admin.query("update ogevia.caregiver_records set status='inactive' where id=$1", [recA1]);
    await expectPgError(call(w.managerA, "select ogevia_api.send_care_offer($1,$2,$3,$4)", [w.orgA, req, recA1, "e".repeat(64)]), "OGV22");
    await db.admin.query("update ogevia.caregiver_records set status='active' where id=$1", [recA1]);
    await db.admin.query("update ogevia.care_requests set status='client_cancelled' where id=$1", [req]);
    await expectPgError(call(w.managerA, "select ogevia_api.send_care_offer($1,$2,$3,$4)", [w.orgA, req, recA1, "e".repeat(64)]), "OGN04");
  });
});
