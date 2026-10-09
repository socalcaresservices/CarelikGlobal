// 0041 Required work documents (CPR and TB): explicit agency rules, verified-and-current only. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let recA1: string;
let recA2: string;
let cpr: string;
let tb: string;
const LA = "America/Los_Angeles";
const sha = "b".repeat(64);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  recA1 = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
  recA2 = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].id;
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
});
afterAll(async () => db?.drop());

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;

const designate = (a: Actor, requirement: string, type: string | null, reason = "Agency policy") =>
  call(a, "select ogevia_api.set_document_work_requirement($1,$2,$3,$4)", [w.orgA, requirement, type, reason]);
const policy = (a: Actor, requirement: string, basis: string, days: number | null = null, reason = "Per agency policy") =>
  call(a, "select ogevia_api.set_requirement_policy($1,$2,$3,$4,$5)", [w.orgA, requirement, basis, days, reason]);
const setup = (a: Actor, org = w.orgA) => call(a, "select ogevia_api.get_work_requirement_setup($1) as s", [org]).then((r) => r[0].s);
const readiness = (a: Actor, rec: string | null = null, from: string | null = null, to: string | null = null, org = w.orgA) =>
  call(a, "select ogevia_api.get_document_readiness($1,$2,$3::timestamptz,$4::timestamptz) as r", [org, rec, from, to]).then((r) => r[0].r);
const status = async (rec: string, requirement: string, from: string | null = null, to: string | null = null) =>
  (await db.admin.query("select status, valid_until::text u from ogevia.document_readiness($1,$2,$3::timestamptz,$4::timestamptz) where requirement = $5", [w.orgA, rec, from, to, requirement])).rows[0];
const at = (day: string, time: string) => `${day} ${time}-07`; // October/November offsets are irrelevant to date-level checks below

async function deliver(rec: string, type: string, owner: Actor, opts: { issued?: string | null; expires?: string | null; verify?: "verified" | "rejected" | null; by?: Actor }) {
  const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
  return { doc, ...(await addVersion(doc, owner, opts)) };
}
async function addVersion(doc: string, owner: Actor, opts: { issued?: string | null; expires?: string | null; verify?: "verified" | "rejected" | null; by?: Actor }) {
  const version = randomUUID();
  const row = (await call(owner, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
    doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, opts.issued ?? null, opts.expires ?? null,
  ]))[0];
  if (opts.verify) await call(opts.by ?? w.managerA, "select ogevia_api.review_document_version($1,$2,$3,null)", [row.document_version_id, opts.verify, opts.verify === "rejected" ? "Image unreadable" : null]);
  return { version: row.document_version_id as string };
}
const resetDocs = async () => {
  await db.admin.query("delete from ogevia.assignment_readiness_flags; delete from ogevia.shift_readiness_flags; delete from ogevia.shifts where status = 'scheduled'");
  await db.admin.query("update ogevia.staff_documents set closed_at = now() where closed_at is null");
};

describe("setup: nothing is invented", () => {
  it("until the agency designates the types and sets the rules, CPR and TB are 'incomplete setup' and nobody is current", async () => {
    expect(await setup(w.ownerA)).toMatchObject({ incomplete: true });
    expect((await setup(w.ownerA)).requirements.map((r: any) => [r.requirement, r.gap])).toEqual([["cpr", "type_not_set"], ["tb", "type_not_set"]]);
    expect(await status(recA1, "cpr")).toMatchObject({ status: "type_not_set" });
    await designate(w.ownerA, "cpr", cpr);
    await designate(w.ownerA, "tb", tb);
    expect(await status(recA1, "cpr")).toMatchObject({ status: "policy_not_set" });
    expect((await setup(w.ownerA)).requirements.map((r: any) => r.gap)).toEqual(["policy_not_set", "policy_not_set"]);
    await policy(w.ownerA, "cpr", "document_expiry");
    expect((await setup(w.ownerA)).incomplete).toBe(true); // TB rule still unset
    await policy(w.ownerA, "tb", "issue_plus_days", 365);
    expect((await setup(w.ownerA)).incomplete).toBe(false);
  });

  it("only an administrator changes the rules; a manager can read them; other agencies and caregivers cannot", async () => {
    await expectPgError(designate(w.managerA, "cpr", cpr), "OGA03");
    await expectPgError(policy(w.managerA, "cpr", "document_expiry"), "OGA03");
    await expectPgError(designate(w.caregiverA1, "cpr", cpr), "OGA03");
    await expectPgError(designate(w.managerB, "cpr", cpr), "OGN04");
    await expect(setup(w.managerA)).resolves.toMatchObject({ incomplete: false });
    await expectPgError(setup(w.caregiverA1), "OGA03");
    await expectPgError(setup(w.managerB), "OGN04");
    await expectPgError(designate(w.ownerA, "cpr", cpr, " "), "OGV22", /reason/i);
    await expectPgError(policy(w.ownerA, "tb", "issue_plus_days", null), "OGV22", /number of days/i);
    await expectPgError(policy(w.ownerA, "tb", "document_expiry", 30), "OGV22", /only when validity is counted/i);
    await expectPgError(policy(w.ownerA, "tb", "issue_plus_days", 0), "OGV22");
    const audit = (await db.admin.query("select action from ogevia.audit_events where action like 'document_requirement.%' order by id")).rows.map((r) => r.action);
    expect(audit).toEqual(["document_requirement.type_set", "document_requirement.type_set", "document_requirement.policy_set", "document_requirement.policy_set"]);
  });
});

describe("verified and current only", () => {
  it("missing -> uploaded (awaiting review) -> verified; an upload alone is never verified; rejection is reported as such", async () => {
    await resetDocs();
    expect(await status(recA1, "cpr")).toMatchObject({ status: "missing" });
    const { doc, version } = await deliver(recA1, cpr, w.caregiverA1, { issued: await add(-30), expires: await add(300) });
    expect(await status(recA1, "cpr")).toMatchObject({ status: "awaiting_review" });
    await call(w.managerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [version]);
    expect(await status(recA1, "cpr")).toMatchObject({ status: "ok", u: await add(300) });
    // A replacement that is still awaiting review does not void a verified, unexpired record.
    await addVersion(doc, w.caregiverA1, { issued: await add(-1), expires: await add(400) });
    expect(await status(recA1, "cpr")).toMatchObject({ status: "ok", u: await add(300) });
    // A different caregiver with only a rejected upload.
    await deliver(recA2, cpr, w.caregiverA2, { issued: await add(-3), expires: await add(300), verify: "rejected" });
    expect(await status(recA2, "cpr")).toMatchObject({ status: "rejected" });
    expect(await status(recA2, "tb")).toMatchObject({ status: "missing" });
  });

  it("an expired record is not current; a record that ends before the work ends does not cover it", async () => {
    await resetDocs();
    await deliver(recA1, cpr, w.caregiverA1, { issued: await add(-400), expires: await add(-1), verify: "verified" });
    expect(await status(recA1, "cpr")).toMatchObject({ status: "expired", u: await add(-1) });
    await resetDocs();
    await deliver(recA1, cpr, w.caregiverA1, { issued: await add(-10), expires: await add(5), verify: "verified" });
    const d5 = await add(5);
    const d6 = await add(6);
    expect(await status(recA1, "cpr", at(d5, "09:00"), at(d5, "17:00"))).toMatchObject({ status: "ok" }); // valid through its expiry date
    expect(await status(recA1, "cpr", at(d5, "20:00"), at(d6, "04:00"))).toMatchObject({ status: "expires_during" }); // overnight runs past it
    expect(await status(recA1, "cpr", at(d6, "09:00"), at(d6, "10:00"))).toMatchObject({ status: "expired" });
  });

  it("TB validity follows the agency's rule, not the certificate's own expiry; a missing issue date is reported", async () => {
    await resetDocs();
    // Certificate says it expires in a year, but the agency counts 365 days from the issue date, and issued 400 days ago.
    await deliver(recA1, tb, w.caregiverA1, { issued: await add(-400), expires: await add(300), verify: "verified" });
    expect(await status(recA1, "tb")).toMatchObject({ status: "expired", u: await add(-35) });
    await policy(w.ownerA, "tb", "document_expiry", null, "Switching to the certificate date");
    expect(await status(recA1, "tb")).toMatchObject({ status: "ok", u: await add(300) });
    await policy(w.ownerA, "tb", "issue_plus_days", 365, "Back to 365 days from issue");
    await resetDocs();
    await deliver(recA1, tb, w.caregiverA1, { issued: null, expires: null, verify: "verified" });
    expect(await status(recA1, "tb")).toMatchObject({ status: "expiry_missing" });
    const hist = (await db.admin.query("select requirement, validity_basis from ogevia.document_requirement_policy_history order by replaced_at")).rows;
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist.every((h) => h.requirement === "tb" || h.requirement === "cpr")).toBe(true);
  });

  it("CPR and TB are separate: a current CPR never makes up for an expired TB", async () => {
    await resetDocs();
    await deliver(recA1, cpr, w.caregiverA1, { issued: await add(-5), expires: await add(300), verify: "verified" });
    await deliver(recA1, tb, w.caregiverA1, { issued: await add(-500), expires: null, verify: "verified" });
    const r = await readiness(w.managerA, recA1);
    expect(r.requirements.map((x: any) => [x.requirement, x.status])).toEqual([["cpr", "ok"], ["tb", "expired"]]);
  });
});

describe("visibility and flags", () => {
  it("a caregiver sees their own status only; staff see the list; other agencies see nothing", async () => {
    await resetDocs();
    await deliver(recA1, cpr, w.caregiverA1, { issued: await add(-5), expires: await add(300), verify: "verified" });
    expect((await readiness(w.caregiverA1)).caregiverRecordId).toBe(recA1);
    await expectPgError(readiness(w.caregiverA1, recA2), "OGA03");
    await expectPgError(readiness(w.managerB, recA1), "OGN04");
    await expectPgError(readiness(w.schedulerA, recA1), "OGA03");
    const rows = await call(w.managerA, "select * from ogevia_api.list_document_readiness($1)", [w.orgA]);
    expect(rows.find((r) => r.caregiver_record_id === recA1)).toMatchObject({ cpr_status: "ok", tb_status: "missing" });
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_document_readiness($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select * from ogevia_api.list_document_readiness($1)", [w.orgA]), "OGN04");
  });

  it("verification flags a future shift that outlasts the record; the shift and an in-progress visit are untouched", async () => {
    await resetDocs();
    const later = await add(12);
    const shiftId = (await db.admin.query<{ id: string }>(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status)
       values ($1,$2,$3,$4,$5, ($6 || ' 09:00')::timestamp at time zone $7, ($6 || ' 11:00')::timestamp at time zone $7, 'scheduled') returning id`,
      [w.orgA, w.clientA1, w.serviceA, w.caregiverA1.userId, recA1, later, LA],
    )).rows[0]!.id;
    const { version } = await deliver(recA1, cpr, w.caregiverA1, { issued: await add(-5), expires: await add(5) });
    await call(w.managerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [version]);
    const flag = (await db.admin.query("select kind, reason_code, resolved_at from ogevia.shift_readiness_flags where shift_id = $1", [shiftId])).rows;
    expect(flag).toMatchObject([{ kind: "document", reason_code: "documents_cpr_expired,tb_missing", resolved_at: null }]);
    expect((await db.admin.query("select status::text s from ogevia.shifts where id = $1", [shiftId])).rows[0].s).toBe("scheduled");
    // Renewing the record clears the document flag for the CPR part once TB is also current.
    await deliver(recA1, tb, w.caregiverA1, { issued: await add(-5), expires: null, verify: "verified" });
    const doc = (await db.admin.query("select id from ogevia.staff_documents where caregiver_record_id = $1 and document_type_id = $2 and closed_at is null", [recA1, cpr])).rows[0].id;
    const { version: v2 } = await addVersion(doc, w.caregiverA1, { issued: await add(-1), expires: await add(400) });
    await call(w.managerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [v2]);
    expect((await db.admin.query("select resolved_at is not null r from ogevia.shift_readiness_flags where shift_id = $1", [shiftId])).rows[0].r).toBe(true);
  });
});
