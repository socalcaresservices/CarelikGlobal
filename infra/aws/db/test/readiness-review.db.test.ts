// PR #76 follow-up. Real database and application role; synthetic records only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, setBaselineAvailability, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let rec: string;
let today: string;
let fx: { client: string; service: string; auth: string };
let tag: string;
const call = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows);
const day = async (n: number) => (await db.admin.query("select to_char($1::date+$2::int,'YYYY-MM-DD') d", [today, n])).rows[0].d as string;
const shift = async (n: number) => call(w.ownerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',$5,null)", [w.orgA, fx.client, fx.service, await day(n), rec]);
async function requirements(mandatory: boolean) {
  await call(w.ownerA, "select ogevia_api.set_client_experience_requirements($1,$2,$3::jsonb,'Owner reviewed requirements')", [w.orgA, fx.client, JSON.stringify([{ tagId: tag, mandatory }])]);
}
beforeAll(async () => {
  db = await createTestDb(); w = await seedWorld(db, 100000); today = await orgToday(db);
  rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1", [w.caregiverA1.userId])).rows[0].id;
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 90 });
  tag = (await call(w.ownerA, "select ogevia_api.create_experience_tag($1,'Synthetic ABA experience') id", [w.orgA]))[0].id;
  await setBaselineAvailability(db, w.orgA, w.caregiverA1, [0,1,2,3,4,5,6].map((weekday) => ({ weekday, start_local: "00:00", end_local: "23:59" })));
  for (const kind of ["cpr", "tb"]) {
    const type = (await call(w.ownerA, "select ogevia_api.create_document_type($1,$2,true,null) id", [w.orgA, `Synthetic ${kind.toUpperCase()}`]))[0].id;
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,$2,$3,'Owner policy')", [w.orgA, kind, type]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,$2,'document_expiry',null,'Owner policy')", [w.orgA, kind]);
    const doc = (await call(w.ownerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) id", [w.orgA, rec, type]))[0].id;
    const version = randomUUID();
    const row = (await call(w.caregiverA1, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',123,$4,$5::date,$6::date,null)", [doc, version, `${w.orgA}/documents/${doc}/${version}`, "c".repeat(64), await day(-1), await day(100)]))[0];
    await expectPgError(call(w.managerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]), "OGA03", /administrator/);
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
  }
  const report = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) s", [w.orgA]))[0].s;
  await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Ready for synthetic tests',$2)", [w.orgA, report.affectedShiftsCount]);
});
afterAll(async () => db?.drop());

describe("manual selection stays separate from optional ranking", () => {
  it("missing ZIP/distance and unreviewed optional experience do not block manual work", async () => {
    await requirements(false);
    const intervals = [{ starts_at: `${await day(3)}T09:00:00-07:00`, ends_at: `${await day(3)}T11:00:00-07:00` }];
    const matches = (await call(w.ownerA, "select ogevia_api.match_caregivers($1,$2,$3,$4::jsonb,null,null) r", [w.orgA, fx.service, fx.client, JSON.stringify(intervals)]))[0].r;
    const candidate = matches.candidates.find((c: { caregiverRecordId: string }) => c.caregiverRecordId === rec);
    expect(candidate.score).toMatchObject({ complete: false, total: null });
    expect(await shift(3)).toHaveLength(1);
  });
  it("an administrator can manually assign outside availability with an audited override; overlap still blocks", async () => {
    await setBaselineAvailability(db, w.orgA, w.caregiverA1, []);
    const intervals = [{ starts_at: `${await day(4)}T09:00:00-07:00`, ends_at: `${await day(4)}T11:00:00-07:00` }];
    const matches = (await call(w.ownerA, "select ogevia_api.match_caregivers($1,$2,$3,$4::jsonb,null,null) r", [w.orgA, fx.service, fx.client, JSON.stringify(intervals)]))[0].r;
    expect(matches.candidates.find((c: { caregiverRecordId: string }) => c.caregiverRecordId === rec).eligibility).toBe('not_eligible');
    await expectPgError(shift(4), "OGR30", /Availability not provided/);
    await call(w.ownerA, "select ogevia_api.authorize_availability_override($1,$2,($3::date+'09:00'::time) at time zone 'America/Los_Angeles',($3::date+'11:00'::time) at time zone 'America/Los_Angeles','Caregiver agreed by phone',$4)", [w.orgA, rec, await day(4), fx.client]);
    expect(await shift(4)).toHaveLength(1);
    await expectPgError(shift(4), "OGC09", /already has a shift/);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action='availability.override_used'")).rows[0].n).toBeGreaterThan(0);
    await setBaselineAvailability(db, w.orgA, w.caregiverA1, [0,1,2,3,4,5,6].map((weekday) => ({ weekday, start_local: "00:00", end_local: "23:59" })));
  });
});

describe("mandatory requirements are checked at final commitment", () => {
  it("report-only still requires a Care Team profile for a manager doing real work", async () => {
    const other = await freshClient(db, w, w.caregiverB1, 100000, w.orgB);
    await expectPgError(call(w.managerB, "select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null)", [w.orgB, other.client, other.service]), "OGR30", /Care Team profile/);
  });
  it("direct creation, rescheduling, reassignment and standing relationships cannot bypass mandatory experience", async () => {
    await requirements(false);
    const existing = (await shift(5))[0].shift_id;
    const unassigned = (await call(w.ownerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','11:00',null,null)", [w.orgA, fx.client, fx.service, await day(6)]))[0].shift_id;
    await requirements(true);
    await db.admin.query("update ogevia.caregiver_assignments set is_active=false where client_id=$1", [fx.client]);
    await expectPgError(shift(7), "OGR30", /Required experience not confirmed/);
    const weekday = (await db.admin.query("select extract(dow from $1::date)::int n", [await day(8)])).rows[0].n;
    await expectPgError(call(w.ownerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,$5::smallint[],'09:00','11:00',$6::date,$6::date,'refuse',null)", [w.orgA, fx.client, fx.service, rec, [weekday], await day(8)]), "OGR30", /Required experience not confirmed/);
    await expectPgError(call(w.ownerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'12:00','14:00','Client request',null)", [w.orgA, existing, await day(5)]), "OGR30", /Required experience not confirmed/);
    await expectPgError(call(w.ownerA, "select ogevia_api.assign_shift_caregiver($1,$2,$3,'Manual cover',null)", [w.orgA, unassigned, rec]), "OGR30", /Required experience not confirmed/);
    await expectPgError(call(w.ownerA, "select * from ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null,null)", [w.orgA, rec, fx.client, fx.service, await day(8)]), "OGR30", /Required experience not confirmed/);
    expect((await db.admin.query("select caregiver_record_id from ogevia.shifts where id=$1", [unassigned])).rows[0].caregiver_record_id).toBeNull();
    await requirements(false);
  });
  it("a new manager-started visit cannot bypass the active Care Team/document checks", async () => {
    const before = (await db.admin.query("select count(*)::int n from ogevia.service_visits")).rows[0].n;
    await expectPgError(call(w.managerA, "select ogevia_api.start_ad_hoc_service_visit($1,$2,$3,'{}',null,null)", [w.orgA, fx.client, fx.service]), "OGR30", /Care Team profile/);
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits")).rows[0].n).toBe(before);
  });
  it("changing mandatory preferences cannot race a final commitment check", async () => {
    await requirements(false);
    const setter = await db.admin.connect();
    await setter.query("begin"); await setter.query("set local role ogevia_app"); await setter.query("select ogevia_api.begin_request($1,$2)", [w.ownerA.sub, randomUUID()]);
    await setter.query("select ogevia_api.set_client_experience_requirements($1,$2,$3::jsonb,'New mandatory requirement')", [w.orgA, fx.client, JSON.stringify([{ tagId: tag, mandatory: true }])]);
    const pending = shift(9);
    // The blocked assignment must observe the newly committed requirement.
    await setter.query("commit"); setter.release();
    await expectPgError(pending, "OGR30", /Required experience not confirmed/);
    await requirements(false);
  });
});

describe("ZIP read permissions", () => {
  it("returns current values only for authorised staff in the correct agency", async () => {
    await call(w.ownerA, "select ogevia_api.set_caregiver_zip($1,$2,'92592')", [w.orgA, rec]);
    expect((await call(w.ownerA, "select ogevia_api.get_matching_zip($1,$2,'caregiver') z", [w.orgA, rec]))[0].z).toEqual({ zip: "92592" });
    await expectPgError(call(w.caregiverA1, "select ogevia_api.get_matching_zip($1,$2,'caregiver')", [w.orgA, rec]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.get_matching_zip($1,$2,'caregiver')", [w.orgA, rec]), "OGN04");
    await expectPgError(call(w.managerB, "select ogevia_api.get_matching_zip($1,$2,'caregiver')", [w.orgB, rec]), "OGN04");
  });
});
