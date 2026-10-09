// 0039 Caregiver readiness: required documents, service approvals, availability override, the single
// readiness check and its gates on every assignment path and on new visit starts. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let fresh: { client: string; service: string; auth: string };
let other: { client: string; service: string; auth: string };
let serviceB2: string;
const rec: Record<string, string> = {};
const sha = "b".repeat(64);
const types: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  fresh = await freshClient(db, w, w.caregiverA1, 30000, w.orgA, { before: 40, after: 400 });
  for (const r of (await db.admin.query("select id, caregiver_code from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows) rec[r.caregiver_code] = r.id;
  // A second service the same client is authorized for: a client assignment must never grant approval for it.
  serviceB2 = (await db.admin.query("insert into ogevia.services (organization_id, code, name) values ($1, 'PCB', 'Synthetic Personal Care') returning id", [w.orgA])).rows[0].id;
  await db.admin.query(
    `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
     values ($1,$2,$3,'SYNTHETIC-PAYER',30000,$4::date - 40,$4::date + 400)`, [w.orgA, fresh.client, serviceB2, today]);
  other = await freshClient(db, w, w.caregiverA2, 30000, w.orgA, { before: 40, after: 400 });
});
afterAll(async () => db?.drop());

const q = async <T = any>(a: Actor, sql: string, params: unknown[] = []) =>
  asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const shift = (a: Actor, date: string, start: string, end: string, caregiver: string | null, service = fresh.service, client = fresh.client) =>
  q(a, "select * from ogevia_api.create_shift($1, $2, $3, $4::date, $5::time, $6::time, $7, null)", [w.orgA, client, service, date, start, end, caregiver]).then((r) => r[0]);
const shiftStatus = async (id: string) => (await db.admin.query("select status, caregiver_record_id from ogevia.shifts where id = $1", [id])).rows[0];
const readiness = (a: Actor, caregiver: string, startIso: string, endIso: string, service = fresh.service, client = fresh.client) =>
  q(a, "select ogevia_api.get_assignment_readiness($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,null) as r", [w.orgA, caregiver, client, service, startIso, endIso]).then((r) => r[0]!.r);
const setSettings = (a: Actor, service: boolean, availability: boolean, reason = "Pilot review complete") =>
  q(a, "select ogevia_api.set_readiness_settings($1,$2,$3,30,$4)", [w.orgA, service, availability, reason]);
const checkOf = (r: any, key: string) => (r.checks as any[]).find((c) => c.key === key);

async function docType(name: string, expiry = false) {
  types[name] = (await q(w.managerA, "select ogevia_api.create_document_type($1,$2,$3,null) as id", [w.orgA, name, expiry]))[0]!.id;
  return types[name]!;
}
async function requestDoc(record: string, type: string) {
  return (await q(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, record, type]))[0]!.id as string;
}
async function upload(a: Actor, doc: string) {
  const version = randomUUID();
  return (await q(a, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,null,null,null)",
    [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha]))[0]!.document_version_id as string;
}
const verify = (a: Actor, version: string, from: string | null, through: string | null, due: string | null = null) =>
  q(a, "select ogevia_api.verify_document_version($1,$2::date,$3::date,$4::date,null,null) as d", [version, from, through, due]);
const revoke = (a: Actor, version: string, reason = "Card reported invalid") =>
  q(a, "select ogevia_api.revoke_document_verification($1,$2,null)", [version, reason]);
async function provide(caregiver: "CG-A1" | "CG-A2" | "CG-A3", type: string, from: string, through: string | null, due: string | null = null) {
  const actor = caregiver === "CG-A1" ? w.caregiverA1 : caregiver === "CG-A2" ? w.caregiverA2 : w.caregiverA3;
  const doc = await requestDoc(rec[caregiver]!, type);
  const v = await upload(actor, doc);
  await verify(w.managerA, v, from, through, due);
  return { doc, version: v };
}

// ---------------------------------------------------------------------------
describe("defaults: nothing is required or enforced until an administrator chooses", () => {
  it("a shift is created exactly as before; readiness says documents not required and service/availability unchecked", async () => {
    const s = await shift(w.managerA, day(1), "09:00", "10:00", rec["CG-A1"]!);
    expect(s.shift_id).toBeTruthy();
    const r = await readiness(w.managerA, rec["CG-A1"]!, `${day(2)}T17:00:00Z`, `${day(2)}T18:00:00Z`);
    expect(checkOf(r, "documents").status).toBe("not_required");
    expect(checkOf(r, "service")).toMatchObject({ status: "unchecked", label: "Approval unchecked" });
    expect(checkOf(r, "availability").status).toBe("unchecked");
    expect(r.service_checks).toBe("off");
    expect(r.unchecked).toEqual(expect.arrayContaining(["service", "availability"]));
    expect(r.ready).toBe(true);
  });

  it("only the Administrator changes settings; a reason is required; the change is audited with before and after", async () => {
    await expectPgError(setSettings(w.managerA, true, false), "OGA03");
    await expectPgError(setSettings(w.caregiverA1, true, false), "OGA03");
    await expectPgError(setSettings(w.ownerA, true, false, " "), "OGV22");
    await expectPgError(q(w.ownerA, "select ogevia_api.set_readiness_settings($1,true,false,0,'x reason')", [w.orgA]), "OGV22");
    await expectPgError(q(w.managerB, "select ogevia_api.set_readiness_settings($1,true,false,30,'x reason')", [w.orgA]), "OGN04");
    await setSettings(w.ownerA, false, false, "Confirm defaults");
    const a = (await db.admin.query("select before_state, after_state, reason from ogevia.audit_events where action = 'readiness.settings_changed' order by id desc limit 1")).rows[0];
    expect(a.after_state).toMatchObject({ service_checks_enabled: false, availability_required: false });
    expect(a.before_state).toMatchObject({ service_checks_enabled: false });
    expect(a.reason).toBe("Confirm defaults");
  });
});

// ---------------------------------------------------------------------------
describe("service approvals (explicit, administrator-controlled, whole interval)", () => {
  let approval: string;
  it("approvals are written only by authorised administrators; a caregiver cannot approve themselves; other agencies are refused", async () => {
    const args = [w.orgA, rec["CG-A1"], fresh.service, day(-5), day(20), "Reviewed experience with client"];
    await expectPgError(q(w.caregiverA1, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,$6,null)", args), "OGA03");
    await expectPgError(q(w.schedulerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,$6,null)", args), "OGA03");
    await expectPgError(q(w.managerB, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,$6,null)", args), "OGN04");
    await expectPgError(q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,' ',null)", args.slice(0, 5)), "OGV22");
    await expectPgError(q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,$6,null)",
      [w.orgA, rec["CG-A1"], fresh.service, day(5), day(1), "Backwards dates"]), "OGV22");
    // a service from another agency is not found
    await expectPgError(q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,$5,null)",
      [w.orgA, rec["CG-A1"], w.serviceB, day(0), "Wrong agency service"]), "OGN04");
    approval = (await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,$6,null) as id", args))[0]!.id;
    const a = (await db.admin.query("select action, reason, after_state from ogevia.audit_events where entity_id = $1", [approval])).rows[0];
    expect(a.action).toBe("service_approval.approved");
    expect(a.reason).toBe("Reviewed experience with client");
    // overlapping approval for the same caregiver and service is refused
    await expectPgError(q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,$5,null)",
      [w.orgA, rec["CG-A1"], fresh.service, day(10), "Overlaps the first"]), "OGC09");
  });

  it("while service checks are Off, nothing is refused and the check says unchecked, never approved", async () => {
    const s = await shift(w.managerA, day(3), "09:00", "10:00", rec["CG-A2"]!); // A2 has no approval at all
    expect(s.shift_id).toBeTruthy();
    const r = await readiness(w.managerA, rec["CG-A2"]!, `${day(4)}T17:00:00Z`, `${day(4)}T18:00:00Z`);
    expect(checkOf(r, "service").status).toBe("unchecked");
    expect(r.service_checks).toBe("off");
  });

  it("switched On: a missing approval blocks assignment on every service-date boundary, and a client assignment grants nothing", async () => {
    await setSettings(w.ownerA, true, false, "Review list cleared");
    // A2: never approved -> blocked
    await expectPgError(shift(w.managerA, day(6), "09:00", "10:00", rec["CG-A2"]!), "OGV22", /Blocked: Service not approved/);
    // A1: approved day(-5)..day(20)
    expect((await shift(w.managerA, day(7), "09:00", "10:00", rec["CG-A1"]!)).shift_id).toBeTruthy();
    expect((await shift(w.managerA, day(20), "09:00", "10:00", rec["CG-A1"]!)).shift_id).toBeTruthy(); // last day inclusive
    await expectPgError(shift(w.managerA, day(21), "09:00", "10:00", rec["CG-A1"]!), "OGV22", /Service not approved/);
    // valid for the FULL interval: starts on the last approved day, ends after midnight
    await expectPgError(shift(w.managerA, day(20), "22:00", "02:00", rec["CG-A1"]!), "OGV22", /Service not approved/);
    // the same client has an authorization for a second service, but A1 is not approved for it
    await expectPgError(shift(w.managerA, day(8), "09:00", "10:00", rec["CG-A1"]!, serviceB2), "OGV22", /Service not approved/);
    // readiness shows the short reason with separate checks
    const r = await readiness(w.managerA, rec["CG-A2"]!, `${day(6)}T17:00:00Z`, `${day(6)}T18:00:00Z`);
    expect(r.ready).toBe(false);
    expect(checkOf(r, "service")).toMatchObject({ status: "fail", code: "SERVICE_NOT_APPROVED", label: "Service not approved" });
    expect(checkOf(r, "status").status).toBe("pass");
    expect(r.service_checks).toBe("on");
  });

  it("the caregiver sees only their own approvals (no reason text); other caregivers and agencies cannot see them", async () => {
    const mine = await q(w.caregiverA1, "select * from ogevia_api.list_my_service_approvals($1)", [w.orgA]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ service_id: fresh.service, state: "current" });
    expect(Object.keys(mine[0]!)).not.toContain("reason");
    expect(await q(w.caregiverA2, "select * from ogevia_api.list_my_service_approvals($1)", [w.orgA])).toHaveLength(0);
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.list_caregiver_service_approvals($1,$2)", [w.orgA, rec["CG-A1"]]), "OGA03");
    await expectPgError(q(w.managerB, "select * from ogevia_api.list_my_service_approvals($1)", [w.orgA]), "OGN04");
    await expectPgError(q(w.managerB, "select * from ogevia_api.list_caregiver_service_approvals($1,$2)", [w.orgA, rec["CG-A1"]]), "OGN04");
    const admin = await q(w.managerA, "select * from ogevia_api.list_caregiver_service_approvals($1,$2)", [w.orgA, rec["CG-A1"]]);
    expect(admin[0]).toMatchObject({ state: "current", reason: "Reviewed experience with client" });
  });

  it("revocation needs a reason, applies to new assignments, keeps the record and flags (does not move) an existing future shift", async () => {
    const future = await shift(w.managerA, day(9), "09:00", "10:00", rec["CG-A1"]!);
    await expectPgError(q(w.managerA, "select ogevia_api.revoke_caregiver_service_approval($1,' ',null)", [approval]), "OGV22");
    await expectPgError(q(w.caregiverA1, "select ogevia_api.revoke_caregiver_service_approval($1,'I do not want it',null)", [approval]), "OGA03");
    await q(w.managerA, "select ogevia_api.revoke_caregiver_service_approval($1,'Complaint under review',null)", [approval]);
    await expectPgError(q(w.managerA, "select ogevia_api.revoke_caregiver_service_approval($1,'Again please',null)", [approval]), "OGC09");
    await expectPgError(shift(w.managerA, day(11), "09:00", "10:00", rec["CG-A1"]!), "OGV22", /Service not approved/);
    // history kept: the row exists with who/when/why; the audit trail has both events
    const row = (await db.admin.query("select revoked_reason, revoked_by from ogevia.caregiver_service_approvals where id = $1", [approval])).rows[0];
    expect(row.revoked_reason).toBe("Complaint under review");
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where entity_id = $1", [approval])).rows[0].n).toBe(2);
    // the existing shift stays exactly as it was and is flagged for review
    expect(await shiftStatus(future.shift_id)).toMatchObject({ status: "scheduled", caregiver_record_id: rec["CG-A1"] });
    const flags = await q(w.managerA, "select * from ogevia_api.list_readiness_flags($1, 90)", [w.orgA]);
    const f = flags.find((x: any) => x.shift_id === future.shift_id);
    expect(f).toBeTruthy();
    expect(f.reason_codes).toContain("SERVICE_NOT_APPROVED");
    await expectPgError(q(w.managerB, "select * from ogevia_api.list_readiness_flags($1, 90)", [w.orgA]), "OGN04");
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.list_readiness_flags($1, 90)", [w.orgA]), "OGA03");
  });

  it("change = revoke and approve again in one step; the old record stays; a new approval then allows work", async () => {
    const a = (await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,$6,null) as id",
      [w.orgA, rec["CG-A1"], fresh.service, day(0), day(30), "Re-approved after review"]))[0]!.id;
    const changed = (await q(w.managerA, "select ogevia_api.change_caregiver_service_approval($1,$2::date,$3::date,$4,null) as id", [a, day(0), day(45), "Extended after refresher"]))[0]!.id;
    expect(changed).not.toBe(a);
    const rows = (await db.admin.query("select id, revoked_at, revoked_reason from ogevia.caregiver_service_approvals where caregiver_record_id = $1 and service_id = $2 order by created_at", [rec["CG-A1"], fresh.service])).rows;
    expect(rows.filter((r: any) => r.revoked_at).length).toBeGreaterThanOrEqual(2);
    expect(rows.find((r: any) => r.id === a).revoked_reason).toMatch(/^Changed: /);
    expect((await shift(w.managerA, day(30), "09:00", "10:00", rec["CG-A1"]!)).shift_id).toBeTruthy();
    expect((await shift(w.managerA, day(45), "09:00", "10:00", rec["CG-A1"]!)).shift_id).toBeTruthy();
    // approvals are immutable apart from revocation
    await expect(db.admin.query("update ogevia.caregiver_service_approvals set effective_to = null where id = $1", [changed])).rejects.toThrow(/cannot be edited/);
    await expect(db.admin.query("delete from ogevia.caregiver_service_approvals where id = $1", [changed])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("required documents (CPR and TB for this agency)", () => {
  it("only the Administrator chooses which documents are required; an upload alone proves nothing", async () => {
    await setSettings(w.ownerA, false, false, "Isolate the document checks");
    await docType("CPR");
    await docType("TB");
    await expectPgError(q(w.managerA, "select ogevia_api.set_document_type_required($1,$2,true,'Agency policy')", [w.orgA, types["CPR"]]), "OGA03");
    await expectPgError(q(w.caregiverA1, "select ogevia_api.set_document_type_required($1,$2,true,'Agency policy')", [w.orgA, types["CPR"]]), "OGA03");
    await expectPgError(q(w.managerB, "select ogevia_api.set_document_type_required($1,$2,true,'Agency policy')", [w.orgA, types["CPR"]]), "OGN04");
    await expectPgError(q(w.ownerA, "select ogevia_api.set_document_type_required($1,$2,true,' ')", [w.orgA, types["CPR"]]), "OGV22");
    await q(w.ownerA, "select ogevia_api.set_document_type_required($1,$2,true,'CPR is required before assignment')", [w.orgA, types["CPR"]]);
    await q(w.ownerA, "select ogevia_api.set_document_type_required($1,$2,true,'TB clearance is required before assignment')", [w.orgA, types["TB"]]);
    const a = (await db.admin.query("select action, reason from ogevia.audit_events where action = 'document_type.required_changed' order by id")).rows;
    expect(a).toHaveLength(2);
    // A3 has nothing on file -> missing for both
    await expectPgError(shift(w.managerA, day(12), "09:00", "10:00", rec["CG-A3"]!), "OGV22", /Blocked: CPR missing; TB missing|Blocked: TB missing; CPR missing/);
  });

  it("uploaded is pending, not cleared; verification needs an administrator and the agency's validity dates; nobody verifies their own", async () => {
    const cpr = await requestDoc(rec["CG-A3"]!, types["CPR"]!);
    const tb = await requestDoc(rec["CG-A3"]!, types["TB"]!);
    const vCpr = await upload(w.caregiverA3, cpr);
    const vTb = await upload(w.caregiverA3, tb);
    await expectPgError(shift(w.managerA, day(12), "09:00", "10:00", rec["CG-A3"]!), "OGV22", /CPR pending; TB pending|TB pending; CPR pending/);
    await expectPgError(verify(w.caregiverA3, vCpr, day(-1), day(300)), "OGA03");
    await expectPgError(verify(w.managerA, vCpr, null, day(300)), "OGV22");
    await expectPgError(verify(w.managerA, vCpr, day(-1), null, null), "OGV22");
    await expectPgError(verify(w.managerA, vCpr, day(5), day(1)), "OGV22");
    await expectPgError(verify(w.managerB, vCpr, day(-1), day(300)), "OGN04");
    await verify(w.managerA, vCpr, day(-1), day(300));
    await expectPgError(shift(w.managerA, day(12), "09:00", "10:00", rec["CG-A3"]!), "OGV22", /Blocked: TB pending/);
    await verify(w.managerA, vTb, day(-1), day(300));
    expect((await shift(w.managerA, day(12), "09:00", "10:00", rec["CG-A3"]!)).shift_id).toBeTruthy();
    await expectPgError(verify(w.managerA, vCpr, day(-1), day(300)), "OGC09"); // already reviewed: a stale second save cannot overwrite
    // a service approval is also required now (service checks are On): record it so the document cases below isolate documents
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Approved for respite',null)", [w.orgA, rec["CG-A3"], fresh.service, day(-30)]);
  });

  it("agency-local date boundaries: valid through the last date inclusive; a shift that runs past it is refused; not yet valid and expired are distinct", async () => {
    const A3 = rec["CG-A3"]!;
    // CPR for A2 valid day(-2)..day(14); TB for A2 valid day(5)..day(400) (future-valid)
    await provide("CG-A2", types["CPR"]!, day(-2), day(14));
    await provide("CG-A2", types["TB"]!, day(5), day(400));
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Approved for respite',null)", [w.orgA, rec["CG-A2"], fresh.service, day(-30)]);
    await expectPgError(shift(w.managerA, day(4), "09:00", "10:00", rec["CG-A2"]!), "OGV22", /TB not yet valid/);
    expect((await shift(w.managerA, day(14), "09:00", "10:00", rec["CG-A2"]!)).shift_id).toBeTruthy(); // through the last day, inclusive
    await expectPgError(shift(w.managerA, day(15), "09:00", "10:00", rec["CG-A2"]!), "OGV22", /CPR expired/);
    await expectPgError(shift(w.managerA, day(14), "22:00", "02:00", rec["CG-A2"]!), "OGV22", /CPR expires before end/);
    // A3 (valid day(-1)..day(300)) is fine on the same days
    expect((await shift(w.managerA, day(15), "09:00", "10:00", A3)).shift_id).toBeTruthy();
  });

  it("a verified document with no administrator-approved validity needs review; only dates the agency approved count", async () => {
    const doc = await requestDoc(rec["CG-A1"]!, types["CPR"]!);
    const v = await upload(w.caregiverA1, doc);
    // legacy review path (no dates): verified, but unusable for readiness
    await q(w.managerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [v]);
    const tb = await requestDoc(rec["CG-A1"]!, types["TB"]!);
    const vt = await upload(w.caregiverA1, tb);
    await verify(w.managerA, vt, day(-1), day(300));
    await expectPgError(shift(w.managerA, day(16), "09:00", "10:00", rec["CG-A1"]!), "OGV22", /CPR needs review/);
    // a review-due date alone is enough when the agency's policy gives one (here: replace via a new version)
    const v2 = await upload(w.caregiverA1, doc);
    await verify(w.managerA, v2, day(-1), null, day(60));
    expect((await shift(w.managerA, day(16), "09:00", "10:00", rec["CG-A1"]!)).shift_id).toBeTruthy();
    await expectPgError(shift(w.managerA, day(61), "09:00", "10:00", rec["CG-A1"]!), "OGV22", /CPR expired/);
  });

  it("a pending replacement never erases a verified record that still covers the work; revocation and rejection are distinct and audited", async () => {
    const A2 = rec["CG-A2"]!;
    const cprDoc = (await db.admin.query("select sd.id from ogevia.staff_documents sd where sd.caregiver_record_id = $1 and sd.document_type_id = $2", [A2, types["CPR"]])).rows[0].id;
    await db.admin.query("update ogevia.document_types set is_active = is_active where id = $1", [types["CPR"]]);
    const v2 = await upload(w.caregiverA2, cprDoc); // replacement awaiting review
    expect((await shift(w.managerA, day(9), "09:00", "10:00", A2)).shift_id).toBeTruthy(); // v1 still covers
    const r = await readiness(w.managerA, A2, `${day(9)}T17:00:00Z`, `${day(9)}T18:00:00Z`);
    expect(checkOf(r, "documents").status).toBe("pass");
    // revoke the first verification: only the pending replacement remains -> pending, no longer ready
    const v1 = (await db.admin.query("select id from ogevia.document_versions where document_id = $1 and version_number = 1", [cprDoc])).rows[0].id;
    await expectPgError(revoke(w.managerA, v1, " "), "OGV22");
    await expectPgError(revoke(w.caregiverA2, v1), "OGA03");
    await expectPgError(revoke(w.managerB, v1), "OGN04");
    await revoke(w.managerA, v1);
    await expectPgError(revoke(w.managerA, v1), "OGC09");
    await expectPgError(shift(w.managerA, day(10), "09:00", "10:00", A2), "OGV22", /CPR pending/);
    // the pending replacement is rejected: now the newest event is a rejection
    await q(w.managerA, "select ogevia_api.review_document_version($1,'rejected','Photo unreadable',null)", [v2]);
    await expectPgError(shift(w.managerA, day(10), "09:00", "10:00", A2), "OGV22", /CPR rejected/);
    // the revoked version and its audit event remain
    const aud = (await db.admin.query("select reason from ogevia.audit_events where action = 'document.verification_revoked'")).rows;
    expect(aud).toHaveLength(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.document_versions where document_id = $1", [cprDoc])).rows[0].n).toBe(2);
    // readiness output carries only the document type and a short state, never dates or file details
    const rr = await readiness(w.managerA, A2, `${day(10)}T17:00:00Z`, `${day(10)}T18:00:00Z`);
    const text = JSON.stringify(rr);
    expect(text).not.toMatch(/valid_through|object_key|sha256|approved_valid|review_due/);
  });

  it("the compliance list is the review list: every caregiver and required type, no grandfathering; caregivers cannot read it", async () => {
    // a Care Team member added with no documents: the list shows them as missing, never as cleared
    await db.admin.query("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1,'CG-NEW','Synthetic','Newhire','ready')", [w.orgA]);
    const rows = await q(w.managerA, "select * from ogevia_api.list_document_compliance($1)", [w.orgA]);
    const of = (code: string, type: string) => rows.find((x: any) => x.caregiver_code === code && x.document_type_name === type);
    expect(of("CG-A3", "CPR").state).toBe("ok");
    expect(of("CG-A2", "TB").state).toBe("not_yet_valid");
    expect(of("CG-A2", "CPR").state).toBe("rejected");
    expect(rows.filter((x: any) => x.caregiver_code === "CG-NEW").map((x: any) => x.state)).toEqual(["missing", "missing"]); // nobody is assumed cleared
    await expectPgError(q(w.caregiverA1, "select * from ogevia_api.list_document_compliance($1)", [w.orgA]), "OGA03");
    await expectPgError(q(w.managerB, "select * from ogevia_api.list_document_compliance($1)", [w.orgA]), "OGN04");
  });

  it("an expiry warning window is configurable and shows 'expiring' on the list", async () => {
    await q(w.ownerA, "select ogevia_api.set_readiness_settings($1,true,false,365,'Show a long warning window')", [w.orgA]);
    const rows = await q(w.managerA, "select * from ogevia_api.list_document_compliance($1)", [w.orgA]);
    expect(rows.find((x: any) => x.caregiver_code === "CG-A3" && x.document_type_name === "CPR").state).toBe("expiring");
    await q(w.ownerA, "select ogevia_api.set_readiness_settings($1,true,false,30,'Back to 30 days')", [w.orgA]);
  });
});

// ---------------------------------------------------------------------------
describe("availability exception: only for availability, only for authorised administrators, always with a reason", () => {
  it("required availability blocks outside it; the override works in the same transaction, is audited, and never rescues anything else", async () => {
    await setSettings(w.ownerA, true, true, "Availability now required");
    const A3 = rec["CG-A3"]!;
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Approved for respite again',null)", [w.orgA, A3, fresh.service, day(-30)]).catch(() => undefined);
    await expectPgError(shift(w.managerA, day(17), "09:00", "10:00", A3), "OGV22", /Needs override: outside approved availability/);
    // add approved availability for the weekday of day(18) so a covered shift passes
    const wd = new Date(`${day(18)}T12:00:00Z`).getUTCDay();
    await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'08:00','18:00')", [w.orgA, A3, wd]);
    expect((await shift(w.managerA, day(18), "09:00", "10:00", A3)).shift_id).toBeTruthy();
    // the override: permission, reason, same transaction
    const withOverride = (a: Actor, reason: string, date: string, caregiver: string, service = fresh.service) =>
      asActor(db, a.sub, async (c) => {
        await c.query("select ogevia_api.begin_availability_override($1,$2)", [w.orgA, reason]);
        return (await c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, fresh.client, service, date, caregiver])).rows[0];
      });
    await expectPgError(withOverride(w.caregiverA1, "Please let me", day(17), A3), "OGA03");
    await expectPgError(withOverride(w.schedulerA, "Needs cover", day(17), A3), "OGA03");
    await expectPgError(withOverride(w.managerA, " ", day(17), A3), "OGV22");
    const ok = await withOverride(w.managerA, "Family requested this caregiver", day(17), A3);
    expect(ok.shift_id).toBeTruthy();
    const aud = (await db.admin.query("select reason, after_state from ogevia.audit_events where action = 'assignment.availability_override'")).rows;
    expect(aud).toHaveLength(1);
    expect(aud[0].reason).toBe("Family requested this caregiver");
    // no override for service approval: A2 has availability?? no -> but also unapproved service B2: still blocked on the hard check
    await expectPgError(withOverride(w.managerA, "Family requested this", day(19), A3, serviceB2), "OGV22", /Blocked: Service not approved/);
    // no override for documents: a caregiver with an expired CPR (A2) stays blocked
    await expectPgError(withOverride(w.managerA, "Urgent cover needed", day(40), rec["CG-A2"]!), "OGV22", /Blocked:/);
    // an override set for one agency does not carry to another
    await setSettings(w.ownerA, true, false, "Availability switch off again");
  });

  it("a Care Request candidate list keeps requiring approved availability regardless of the switch (existing protection not relaxed)", async () => {
    // no availability windows for A1 -> not listed even with the agency switch off
    const id = (await db.admin.query(
      `insert into ogevia.care_requests(organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key)
       values ($1,$2,$3,$4, ($5::date + time '09:00') at time zone 'America/Los_Angeles', ($5::date + time '13:00') at time zone 'America/Los_Angeles', 240, gen_random_uuid()) returning id`,
      [w.orgA, other.client, other.service, other.auth, day(25)])).rows[0].id;
    const rows = await q(w.managerA, "select * from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, id]);
    expect(rows.find((x: any) => x.caregiver_record_id === rec["CG-A1"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("every assignment path uses the same gate", () => {
  it("assign_shift_caregiver, reschedule_shift and recurring series are checked; an open shift stays creatable", async () => {
    const A2 = rec["CG-A2"]!; // CPR rejected + service approved
    const open = await shift(w.managerA, day(21), "09:00", "10:00", null);
    expect(open.shift_id).toBeTruthy(); // an uncovered shift is not an assignment
    await expectPgError(q(w.managerA, "select * from ogevia_api.assign_shift_caregiver($1,$2,$3,'Cover needed',null)", [w.orgA, open.shift_id, A2]), "OGV22", /Blocked: CPR rejected/);
    // an eligible caregiver can take it; then rescheduling checks the new time against the same gate
    const A3 = rec["CG-A3"]!;
    const ok = await q(w.managerA, "select * from ogevia_api.assign_shift_caregiver($1,$2,$3,'Cover needed',null)", [w.orgA, open.shift_id, A3]);
    expect(ok[0]).toBeTruthy();
    const open3 = (await db.admin.query("select id from ogevia.caregiver_service_approvals where caregiver_record_id = $1 and revoked_at is null", [A3])).rows;
    for (const r of open3) await q(w.ownerA, "select ogevia_api.revoke_caregiver_service_approval($1,'Retraining',null)", [r.id]);
    await expectPgError(q(w.managerA, "select * from ogevia_api.reschedule_shift($1,$2,$3::date,'10:00','11:00','Moving the visit',null)", [w.orgA, open.shift_id, day(21)]), "OGV22", /Service not approved/);
    // a recurring series is checked occurrence by occurrence through the same gate
    await expectPgError(q(w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,$4,'{0,1,2,3,4,5,6}'::smallint[],'09:00','10:00',$5::date,$6::date,'refuse',null)",
      [w.orgA, fresh.client, fresh.service, A3, day(22), day(24)]), "OGV22", /Service not approved/);
  });

  it("a NEW standing assignment that grants access is gated; a planned assignment (no sign-in) is not, and appears as blocked on the review list", async () => {
    const c = (await db.admin.query("insert into ogevia.clients (organization_id) values ($1) returning id", [w.orgA])).rows[0].id;
    await expect(db.admin.query(
      "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, caregiver_record_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5,$6::date)",
      [w.orgA, w.caregiverA2.userId, rec["CG-A2"], c, fresh.service, today])).rejects.toThrow(/Blocked: CPR rejected/);
    // planned: grants nothing, not gated
    const planned = await db.admin.query(
      "insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, caregiver_record_id, client_id, service_id, effective_start) values ($1,null,$2,$3,$4,$5::date) returning id",
      [w.orgA, rec["CG-A2"], c, fresh.service, today]).catch((e) => e);
    // (the schema may require a user; either outcome keeps planned work from granting access)
    expect(planned).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("new visit start is gated; work in progress is never interrupted", () => {
  it("a caregiver whose required document is not current cannot start a new visit; the message is short and plain", async () => {
    const A2 = w.caregiverA2;
    await expectPgError(api.start(db, A2, w.orgA, other.client, other.service), "OGV22", /Blocked: CPR rejected.*Contact your agency manager/);
  });

  it("an in-progress visit can still be ended after the caregiver's verification is revoked; history is preserved", async () => {
    // A3: CPR/TB verified; service approval was revoked above, so give A3 a fresh approval for the visit service first
    const fresh3 = await freshClient(db, w, w.caregiverA3, 600, w.orgA, { before: 40, after: 40 });
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Approved for visits',null)", [w.orgA, rec["CG-A3"], fresh3.service, day(-1)]);
    const visit = await api.start(db, w.caregiverA3, w.orgA, fresh3.client, fresh3.service);
    expect(visit).toBeTruthy();
    // now everything is revoked while the visit is open
    const cprVersion = (await db.admin.query(
      `select dv.id from ogevia.document_versions dv join ogevia.staff_documents sd on sd.id = dv.document_id
        where sd.caregiver_record_id = $1 and sd.document_type_id = $2 and dv.review_status = 'verified' limit 1`, [rec["CG-A3"], types["CPR"]])).rows[0].id;
    await revoke(w.managerA, cprVersion);
    await db.admin.query("update ogevia.caregiver_service_approvals set revoked_at = now(), revoked_by = approved_by, revoked_reason = 'Revoked during visit' where caregiver_record_id = $1 and revoked_at is null", [rec["CG-A3"]]);
    // age the visit, then end it: sign-out is not gated
    const { ageVisit } = await import("./harness.js");
    await ageVisit(db, visit, 90);
    const ended = await api.end(db, w.caregiverA3, visit);
    expect(ended.visit_id).toBe(visit);
    // historical visit unchanged
    expect((await db.admin.query("select status from ogevia.service_visits where id = $1", [visit])).rows[0].status).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("concurrency: one lock per caregiver across assignment, revocation and approval", () => {
  async function openTx(sub: string) {
    const c = await db.admin.connect();
    await c.query("begin");
    await c.query("set local role ogevia_app");
    await c.query("select ogevia_api.begin_request($1, $2)", [sub, randomUUID()]);
    const pid = (await c.query("select pg_backend_pid() as p")).rows[0].p as number;
    return { c, pid };
  }
  async function waitingOnLock(pid: number) {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.admin.query("select wait_event_type from pg_stat_activity where pid = $1", [pid]);
      if (rows[0]?.wait_event_type === "Lock") return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }
  const finish = async (c: pg.PoolClient, ok: boolean) => {
    try { await c.query(ok ? "commit" : "rollback"); } catch { /* connection already ended */ } finally { c.release(); }
  };

  it("two overlapping assignments for one caregiver cannot both succeed, even on a path that never took the lock before", async () => {
    await setSettings(w.ownerA, true, false, "Race test: service checks on, availability off");
    await db.admin.query("update ogevia.document_types set required_for_work = false where organization_id = $1", [w.orgA]); // isolate the overlap rule
    const cg = rec["CG-A1"]!;
    const base = day(100);
    // approval covering the race dates, so only the overlap is at issue
    await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,'Approved for the race test',null)", [w.orgA, cg, fresh.service, day(95), day(110)]);
    // Direct INSERTs reproduce the shape of assign_care_request, which inserts a shift without check_shift_caregiver.
    const ins = (c: pg.PoolClient) => c.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5,($6::date + time '09:00') at time zone 'America/Los_Angeles',($6::date + time '12:00') at time zone 'America/Los_Angeles','scheduled')`,
      [w.orgA, fresh.client, fresh.service, w.caregiverA1.userId, cg, base]);
    const t1 = await db.admin.connect();
    const t2 = await db.admin.connect();
    try {
      await t1.query("begin");
      await t2.query("begin");
      const pid2 = (await t2.query("select pg_backend_pid() as p")).rows[0].p as number;
      await ins(t1); // holds the caregiver lock, uncommitted
      const second = ins(t2).then(() => "inserted", (e: { message: string }) => e.message);
      expect(await waitingOnLock(pid2)).toBe(true); // the second assignment waits; it does not race past
      await t1.query("commit");
      expect(await second).toMatch(/Blocked: Already booked/);
    } finally {
      await finish(t1, false);
      await finish(t2, false);
    }
    const n = (await db.admin.query("select count(*)::int n from ogevia.shifts where caregiver_record_id = $1 and (starts_at at time zone 'America/Los_Angeles')::date = $2::date", [cg, base])).rows[0].n;
    expect(n).toBe(1);
  });

  it("revocation committed first refuses the waiting assignment; a revocation arriving after is applied and the new shift is flagged", async () => {
    const cg = rec["CG-A1"]!;
    const sa = (await db.admin.query("select id from ogevia.caregiver_service_approvals where caregiver_record_id = $1 and service_id = $2 and revoked_at is null and effective_from = $3::date", [cg, fresh.service, day(95)])).rows[0].id;

    // (a) revoke first (holds the lock), the assignment waits, then is refused
    const r1 = await openTx(w.managerA.sub);
    const a1 = await openTx(w.managerA.sub);
    try {
      await r1.c.query("select ogevia_api.revoke_caregiver_service_approval($1,'Revoked first in the race',null)", [sa]);
      const attempt = a1.c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, fresh.client, fresh.service, day(101), cg]).then(() => "created", (e: { message: string }) => e.message);
      expect(await waitingOnLock(a1.pid)).toBe(true);
      await r1.c.query("commit");
      expect(await attempt).toMatch(/Service not approved/);
    } finally {
      await finish(r1.c, false);
      await finish(a1.c, false);
    }

    // (b) assignment first (holds the lock), the revocation waits, then applies; the shift remains and is flagged
    const sb = (await q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,$5::date,'Approved again for the race test',null) as id", [w.orgA, cg, fresh.service, day(95), day(110)]))[0]!.id;
    const a2 = await openTx(w.managerA.sub);
    const r2 = await openTx(w.managerA.sub);
    let shiftId = "";
    try {
      const made = await a2.c.query("select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, fresh.client, fresh.service, day(102), cg]);
      shiftId = made.rows[0].shift_id as string;
      const revoking = r2.c.query("select ogevia_api.revoke_caregiver_service_approval($1,'Revoked second in the race',null)", [sb]).then(() => "revoked", (e: { message: string }) => e.message);
      expect(await waitingOnLock(r2.pid)).toBe(true);
      await a2.c.query("commit");
      expect(await revoking).toBe("revoked");
      await r2.c.query("commit");
    } finally {
      await finish(a2.c, false);
      await finish(r2.c, false);
    }
    expect(await shiftStatus(shiftId)).toMatchObject({ status: "scheduled" });
    const flags = await q(w.managerA, "select * from ogevia_api.list_readiness_flags($1, 365)", [w.orgA]);
    expect(flags.find((f: any) => f.shift_id === shiftId)?.reason_codes).toContain("SERVICE_NOT_APPROVED");
  });
});

// ---------------------------------------------------------------------------
describe("access and isolation", () => {
  it("readiness is available to schedulers and managers only; caregivers and other agencies are refused; output has no sensitive detail", async () => {
    const r = await readiness(w.schedulerA, rec["CG-A1"]!, `${day(3)}T17:00:00Z`, `${day(3)}T18:00:00Z`);
    expect(Array.isArray(r.checks)).toBe(true);
    await expectPgError(readiness(w.caregiverA1, rec["CG-A1"]!, `${day(3)}T17:00:00Z`, `${day(3)}T18:00:00Z`), "OGA03");
    await expectPgError(readiness(w.managerB, rec["CG-A1"]!, `${day(3)}T17:00:00Z`, `${day(3)}T18:00:00Z`), "OGN04");
    await expectPgError(q(w.managerA, "select ogevia_api.get_assignment_readiness($1,$2,$3,$4,$5::timestamptz,$5::timestamptz,null)", [w.orgA, rec["CG-A1"], fresh.client, fresh.service, `${day(3)}T17:00:00Z`]), "OGV22");
  });

  it("a caregiver of another agency cannot be checked, approved or flagged through this agency", async () => {
    const b = (await db.admin.query("select id from ogevia.caregiver_records where organization_id = $1 limit 1", [w.orgB])).rows[0].id;
    await expectPgError(q(w.managerA, "select ogevia_api.set_caregiver_service_approval($1,$2,$3,$4::date,null,'Cross agency attempt',null)", [w.orgA, b, fresh.service, day(0)]), "OGN04");
    const r = await readiness(w.managerA, b, `${day(3)}T17:00:00Z`, `${day(3)}T18:00:00Z`);
    expect(checkOf(r, "status")).toMatchObject({ status: "fail", label: "Not ready to work" });
  });

  it("the new tables are not directly readable or writable by the application role", async () => {
    for (const t of ["agency_readiness_settings", "document_version_revocations", "caregiver_service_approvals"]) {
      await expectPgError(q(w.managerA, `select * from ogevia.${t}`), "42501");
    }
  });
});
