// 0054 Recruiting and onboarding: pipeline stages, the checklist (background check, training, CPR/TB documents, compliance
// clearance), the approval gate, the assignment gate, expiry blocking new scheduling, permissions, audit and tenant
// isolation. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let cprType: string;
let tbType: string;
const sha = "c".repeat(64);
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 950);
  today = await orgToday(db);
  cprType = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tbType = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
});
afterAll(async () => db?.drop());

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const create = async (status = "applicant", last = "Applicant") =>
  (await call(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,$3,null)", [w.orgA, `${last} ${randomUUID().slice(0, 4)}`, status]))[0].caregiver_record_id as string;
const setStatus = (a: Actor, id: string, status: string, org = w.orgA) => call(a, "select * from ogevia_api.set_caregiver_status($1,$2,$3,'Synthetic stage change',null)", [org, id, status]);
const onboarding = (a: Actor, id: string, org = w.orgA) => call(a, "select ogevia_api.get_onboarding($1,$2) as o", [org, id]).then((r) => r[0].o);
const record = (a: Actor, id: string, key: string, action = "complete", extra: { on?: string | null; exp?: string | null; note?: string | null; reason?: string | null } = {}, org = w.orgA) =>
  call(a, "select ogevia_api.record_onboarding_item($1,$2,$3,$4,$5::date,$6::date,$7,$8) as o", [org, id, key, action, extra.on ?? null, extra.exp ?? null, extra.note ?? null, extra.reason ?? null]).then((r) => r[0].o);
const stateOf = (o: any, key: string) => o.items.find((i: any) => i.key === key).state as string;
async function verifiedDocument(rec: string, type: string, expires: string) {
  const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
  const version = randomUUID();
  const row = (await call(w.managerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,null,$5::date,null)", [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, expires]))[0];
  await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null)", [row.document_version_id]);
}

describe("defaults and the pipeline", () => {
  it("every agency has the standard checklist; an applicant needs it, an existing caregiver does not", async () => {
    for (const org of [w.orgA, w.orgB]) {
      const keys = (await db.admin.query("select requirement_key from ogevia.onboarding_requirements where organization_id = $1 order by sort_order", [org])).rows.map((r) => r.requirement_key);
      expect(keys).toEqual(["background_check", "training", "cpr", "tb", "clearance"]);
    }
    const id = await create();
    const o = await onboarding(w.managerA, id);
    expect(o).toMatchObject({ status: "applicant", onboardingRequired: true, done: 0, total: 5, complete: false });
    expect(o.items.map((i: any) => [i.key, i.state])).toEqual([["background_check", "outstanding"], ["training", "outstanding"], ["cpr", "outstanding"], ["tb", "outstanding"], ["clearance", "outstanding"]]);
    const legacy = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
    expect(await onboarding(w.managerA, legacy)).toMatchObject({ onboardingRequired: false });
  });

  it("moves through the stages in order and is listed in the pipeline with exactly what is outstanding", async () => {
    const id = await create();
    for (const s of ["interview", "offer", "onboarding", "pending_documents"]) await setStatus(w.managerA, id, s);
    const row = (await call(w.managerA, "select * from ogevia_api.list_onboarding_overview($1)", [w.orgA])).find((r) => r.caregiver_record_id === id);
    expect(row).toMatchObject({ status: "pending_documents", onboarding_required: true, done: 0, total: 5 });
    expect(row.outstanding.map((x: any) => x.label)).toEqual(["Background check cleared", "Required training completed", "CPR certificate current", "TB clearance current", "Compliance clearance"]);
    const listed = (await call(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).find((r) => r.caregiver_record_id === id);
    expect(listed).toMatchObject({ status: "pending_documents", onboarding_required: true, onboarding_done: 0, onboarding_total: 5 });
  });

  it("someone returning from Inactive starts the checklist; an Approved or Active person moved back a stage does not", async () => {
    const legacy = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].id;
    await setStatus(w.managerA, legacy, "pending_documents");
    expect(await onboarding(w.managerA, legacy)).toMatchObject({ onboardingRequired: false });
    await setStatus(w.managerA, legacy, "active");
    await setStatus(w.managerA, legacy, "inactive");
    await setStatus(w.managerA, legacy, "onboarding");
    expect(await onboarding(w.managerA, legacy)).toMatchObject({ onboardingRequired: true, done: 0 });
    await expectPgError(setStatus(w.managerA, legacy, "ready"), "OGC09", /Onboarding is not complete/);
  });
});

describe("approval and assignment gates", () => {
  it("cannot be Approved or assigned until every required item is satisfied; the last step is compliance clearance", async () => {
    const id = await create("applicant", "Gate");
    await expectPgError(setStatus(w.managerA, id, "ready"), "OGC09", /Onboarding is not complete: Background check cleared, Required training completed, CPR certificate current, TB clearance current, Compliance clearance/);
    await expectPgError(setStatus(w.managerA, id, "active"), "OGC09", /Onboarding is not complete/);
    await expectPgError(call(w.ownerA, "select * from ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null,null)", [w.orgA, id, w.clientA1, w.serviceA, today]), "OGR30", /Onboarding is not complete/);

    const bg = await record(w.managerA, id, "background_check", "complete", { on: today, note: "Cleared (synthetic)" });
    expect(stateOf(bg, "background_check")).toBe("done");
    await record(w.managerA, id, "training", "complete", { on: today, exp: await add(365) });
    // clearance comes last
    await expectPgError(record(w.managerA, id, "clearance"), "OGC09", /comes last.*CPR certificate current, TB clearance current/);
    // documents are evaluated from the real records, not typed in
    await expectPgError(record(w.managerA, id, "cpr"), "OGV22", /uploading and approving/);
    expect((await onboarding(w.managerA, id)).items.find((i: any) => i.key === "cpr")).toMatchObject({ state: "outstanding", detail: "Document type not set up" });
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cprType]);
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tbType]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','document_expiry',null,'Per agency policy')", [w.orgA]);
    expect((await onboarding(w.managerA, id)).items.find((i: any) => i.key === "cpr")).toMatchObject({ state: "outstanding", detail: "No document uploaded" });
    await verifiedDocument(id, cprType, await add(400));
    await verifiedDocument(id, tbType, await add(20));
    const almost = await onboarding(w.managerA, id);
    expect(almost).toMatchObject({ done: 4, total: 5, complete: false });
    expect(almost.items.find((i: any) => i.key === "tb")).toMatchObject({ state: "done", expiringSoon: true });
    await record(w.managerA, id, "clearance", "complete", { on: today });
    expect(await onboarding(w.managerA, id)).toMatchObject({ done: 5, total: 5, complete: true });

    await call(w.ownerA, "select * from ogevia_api.create_assignment($1,$2,$3,$4,$5::date,null,null)", [w.orgA, id, w.clientA1, w.serviceA, today]);
    await setStatus(w.managerA, id, "ready");
    expect((await db.admin.query("select status from ogevia.caregiver_records where id = $1", [id])).rows[0].status).toBe("ready");
  });

  it("an expired item takes the caregiver out of new scheduling (shift, series), but never out of a visit already in progress", async () => {
    const id = await create("applicant", "Expiry");
    await record(w.managerA, id, "background_check", "complete", { on: today });
    await record(w.managerA, id, "training", "complete", { on: today, exp: await add(200) });
    for (const t of [cprType, tbType]) await verifiedDocument(id, t, await add(400));
    await record(w.managerA, id, "clearance", "complete", { on: today });
    await setStatus(w.managerA, id, "ready");
    const fresh = (await db.admin.query(`insert into ogevia.clients (organization_id) values ($1) returning id`, [w.orgA])).rows[0].id as string;
    await db.admin.query(`insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
      values ($1,$2,$3,'SYNTHETIC-PAYER',6000,$4::date - 30,$4::date + 400)`, [w.orgA, fresh, w.serviceA, today]);
    const day = await add(10);
    await call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'10:00'::time,$5,null)", [w.orgA, fresh, w.serviceA, day, id]);

    // the training certificate lapses
    await db.admin.query(`update ogevia.caregiver_onboarding_items set completed_on = $2::date - 300, expires_on = $2::date - 1
      where caregiver_record_id = $1 and requirement_id = (select id from ogevia.onboarding_requirements where organization_id = $3 and requirement_key = 'training')`, [id, today, w.orgA]);
    expect(stateOf(await onboarding(w.managerA, id), "training")).toBe("expired");
    const day2 = await add(11);
    await expectPgError(call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'10:00'::time,$5,null)", [w.orgA, fresh, w.serviceA, day2, id]),
      "OGR30", /Onboarding incomplete: Required training completed/);
    const rows = await call(w.managerA, "select outcome, local_date::text d from ogevia_api.preview_shift_series($1,$2,$3,$4,'{1,2,3,4,5}'::smallint[],'09:00'::time,'10:00'::time,$5::date,$6::date)", [w.orgA, fresh, w.serviceA, id, await add(12), await add(16)]);
    expect(rows.every((r) => r.outcome === "onboarding_incomplete")).toBe(true);
    // starting a visit that is already under way is not stopped by the check
    const atStart = await db.admin.query(`select check_name from ogevia.readiness_checks($1,$2,$3,now(),now() + interval '1 hour','visit_start',null,null,false)`, [w.orgA, id, w.serviceA]);
    expect(atStart.rows.map((r) => r.check_name)).not.toContain("onboarding");
    // renewing it clears the block
    await record(w.managerA, id, "training", "complete", { on: today, exp: await add(365) });
    await call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'10:00'::time,$5,null)", [w.orgA, fresh, w.serviceA, day2, id]);
  });
});

describe("recording rules, permissions, audit and isolation", () => {
  it("waiving and reopening need a reason; clearance cannot be waived; long notes and future dates are refused", async () => {
    const id = await create();
    await expectPgError(record(w.managerA, id, "training", "waive"), "OGV22", /reason/i);
    await expectPgError(record(w.managerA, id, "clearance", "waive", { reason: "Synthetic" }), "OGV22", /cannot be waived/);
    await expectPgError(record(w.managerA, id, "training", "complete", { note: "x".repeat(201) }), "OGV22", /200 characters/);
    await expectPgError(record(w.managerA, id, "training", "complete", { on: await add(3) }), "OGV22", /future/);
    await expectPgError(record(w.managerA, id, "training", "complete", { on: today, exp: await add(-10) }), "OGV22", /expiry/i);
    await expectPgError(record(w.managerA, id, "nonsense"), "OGN04");
    const waived = await record(w.managerA, id, "training", "waive", { reason: "Equivalent training on file (synthetic)" });
    expect(stateOf(waived, "training")).toBe("waived");
    expect(waived.done).toBe(1);
    const reopened = await record(w.managerA, id, "training", "reopen", { reason: "Waiver withdrawn (synthetic)" });
    expect(stateOf(reopened, "training")).toBe("outstanding");
    const audit = (await db.admin.query(`select action, reason from ogevia.audit_events where entity_id = $1 and action like 'caregiver.onboarding_item_%' order by id`, [id])).rows;
    expect(audit.map((a) => a.action)).toEqual(["caregiver.onboarding_item_waived", "caregiver.onboarding_item_reopened"]);
    expect(audit[0].reason).toMatch(/Equivalent training/);
  });

  it("caregivers cannot read or record onboarding; another agency cannot touch it; requirements can be added and switched off with a reason", async () => {
    const id = await create();
    await expectPgError(onboarding(w.caregiverA1, id), "OGA03");
    await expectPgError(record(w.caregiverA1, id, "training"), "OGA03");
    await expectPgError(onboarding(w.managerB, id), "OGN04");
    await expectPgError(record(w.managerB, id, "training", "complete", {}, w.orgA), "OGN04");
    await expectPgError(call(w.managerB, "select * from ogevia_api.list_onboarding_overview($1)", [w.orgA]), "OGN04");
    await call(w.managerA, "select ogevia_api.set_onboarding_requirement($1,'orientation','Agency orientation','training',true,null,null,true,'Agency policy (synthetic)')", [w.orgA]);
    expect((await onboarding(w.managerA, id)).total).toBe(6);
    await call(w.managerA, "select ogevia_api.set_onboarding_requirement($1,'orientation',null,null,false,null,null,true,'Optional for now (synthetic)')", [w.orgA]);
    expect((await onboarding(w.managerA, id)).total).toBe(5);
    await expectPgError(call(w.managerA, "select ogevia_api.set_onboarding_requirement($1,'orientation',null,null,false,null,null,true,'')", [w.orgA]), "OGV22", /reason/i);
    expect((await db.admin.query("select count(*)::int n from ogevia.onboarding_requirements where organization_id = $1 and requirement_key = 'orientation'", [w.orgB])).rows[0].n).toBe(0);
  });

  it("an existing caregiver can be switched onto the checklist with start_onboarding, once", async () => {
    const legacy = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA3.userId])).rows[0].id;
    expect(await onboarding(w.managerA, legacy)).toMatchObject({ onboardingRequired: false });
    await call(w.managerA, "select ogevia_api.start_onboarding($1,$2)", [w.orgA, legacy]);
    await call(w.managerA, "select ogevia_api.start_onboarding($1,$2)", [w.orgA, legacy]);
    expect(await onboarding(w.managerA, legacy)).toMatchObject({ onboardingRequired: true });
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'caregiver.onboarding_started'", [legacy])).rows[0].n).toBe(1);
  });
});
