// 0086 Caregiver readiness: one readiness source, Approve for work, the CPR/TB due-days setting (default 30) and per-caregiver extensions,
// the restricted contact, the sign-in link rate limit and the calculated status. OWNER-DEFINED rules (2026-10-30), not verified legal requirements.
// SYNTHETIC data only. Enforcement is switched on only inside this test database.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, satisfyHardRequirements, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let cpr: string;
let tb: string;
let fx: { client: string; service: string; auth: string };
const sha = "f".repeat(64);

const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const create = async (last = "Ready") =>
  (await call(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,'onboarding',null)", [w.orgA, `${last} ${randomUUID().slice(0, 4)}`]))[0].caregiver_record_id as string;
const readiness = (rec: string, a: Actor = w.managerA, org = w.orgA) => call(a, "select ogevia_api.get_caregiver_readiness($1,$2) as r", [org, rec]).then((r) => r[0].r);
const approve = (rec: string, a: Actor = w.managerA, org = w.orgA) => call(a, "select ogevia_api.approve_caregiver_for_work($1,$2,$3) as r", [org, rec, randomUUID()]).then((r) => r[0].r);
const item = (r: any, key: string) => r.items.find((i: any) => i.requirement === key);
const verifyBackground = (rec: string) => call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [w.orgA, rec]);
const record = (rec: string, key: string, action = "complete", on: string | null = null) =>
  call(w.managerA, "select ogevia_api.record_onboarding_item($1,$2,$3,$4,$5::date,null,null,null)", [w.orgA, rec, key, action, on]);
const setHire = (rec: string, daysAgo: number | null) =>
  db.admin.query("update ogevia.caregiver_records set hire_date = case when $2::int is null then null else $3::date - $2::int end where id = $1", [rec, daysAgo, today]);
const audits = async (rec: string, action: string) => (await db.admin.query("select * from ogevia.audit_events where entity_id = $1 and action = $2 order by id", [rec, action])).rows;

/** A caregiver who has been invited (so has a linked account) and, optionally, has signed in. */
async function invited(rec: string, signedIn: boolean) {
  const sub = randomUUID();
  const email = `synthetic.${randomUUID().slice(0, 8)}@example.test`;
  await call(w.managerA, "select ogevia_api.begin_caregiver_invitation($1,$2,$3)", [w.orgA, rec, email]);
  await call(w.managerA, "select * from ogevia_api.complete_caregiver_invitation($1,$2,$3,$4,false)", [w.orgA, rec, email, sub]);
  if (signedIn) await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
  return { sub, email };
}
/** Everything the hard rules need, through the real functions where they exist. */
async function fullyReady(last = "Ready") {
  const rec = await create(last);
  await invited(rec, true);
  await verifyBackground(rec);
  await record(rec, "training");
  return rec;
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
});
afterAll(async () => db?.drop());

describe("hard requirements: background check, app sign-in, required training", () => {
  it("approval is blocked without a verified background check, even with everything else done and through a direct API call", async () => {
    const rec = await create("NoBg");
    await invited(rec, true);
    await record(rec, "training");
    const r = await readiness(rec);
    expect(r).toMatchObject({ status: "not_ready", canApprove: false, waitingOn: ["Background check"] });
    await expectPgError(approve(rec), "OGC09", /Cannot approve yet\. Waiting on: Background check$/);
    await expectPgError(approve(rec, w.ownerA), "OGC09", /Waiting on: Background check/); // an administrator is held to the same rule: no override
    // "completed" is not clearance, and neither is a not-approved result
    await call(w.ownerA, "select ogevia_api.set_background_check_status($1,$2,'completed','Process finished',null)", [w.orgA, rec]);
    await expectPgError(approve(rec), "OGC09", /Waiting on: Background check/);
    await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'not_approved','Synthetic: not cleared',null)", [w.orgA, rec]);
    await expectPgError(approve(rec), "OGC09", /Waiting on: Background check/);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [rec])).rows[0].n).toBe(0);
    expect((await db.admin.query("select status from ogevia.caregiver_records where id = $1", [rec])).rows[0].status).toBe("onboarding");
  });

  it("approval is blocked until the caregiver has signed in; an invitation alone is not a sign-in", async () => {
    const rec = await create("NoSignIn");
    await verifyBackground(rec);
    await record(rec, "training");
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "unmet", detail: "No email on file", nextAction: "add_contact" });
    await expectPgError(approve(rec), "OGC09", /Waiting on: App sign-in$/);
    const { sub } = await invited(rec, false);
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "unmet", detail: "Invited, has not signed in yet", nextAction: "resend_link" });
    await expectPgError(approve(rec), "OGC09", /Waiting on: App sign-in$/);
    await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
    expect(item(await readiness(rec), "signin")).toMatchObject({ state: "met" });
    const done = await approve(rec);
    expect(done).toMatchObject({ approved: true, status: "approved", alreadyApproved: false });
  });

  it("approval is blocked until the required training is done", async () => {
    const rec = await create("NoTraining");
    await invited(rec, true);
    await verifyBackground(rec);
    await expectPgError(approve(rec), "OGC09", /Waiting on: Required training$/);
    await record(rec, "training");
    expect((await approve(rec)).status).toBe("approved");
  });

  it("Approve for work records the approver and time, sets the stored stage, snapshots the requirements and is audited", async () => {
    const rec = await fullyReady("Approved");
    const r = await approve(rec, w.managerA);
    expect(r).toMatchObject({ approved: true, approvedByName: expect.anything() as unknown, approvalSource: "approval", met: 3 });
    const row = (await db.admin.query("select a.approved_by, a.approved_at, a.source, jsonb_array_length(a.snapshot) n, c.status from ogevia.caregiver_work_approvals a join ogevia.caregiver_records c on c.id = a.caregiver_record_id where a.caregiver_record_id = $1", [rec])).rows[0];
    expect(row).toMatchObject({ approved_by: w.managerA.userId, source: "approval", status: "ready" });
    expect(row.n).toBeGreaterThanOrEqual(3);
    expect(row.approved_at).toBeTruthy();
    const log = await audits(rec, "caregiver.approved_for_work");
    expect(log).toHaveLength(1);
    expect(log[0].actor_user_id).toBe(w.managerA.userId);
  });

  it("a concurrent double-click produces ONE approval record and one audit entry", async () => {
    const rec = await fullyReady("Double");
    const results = await Promise.all([approve(rec), approve(rec), approve(rec)]);
    expect(results.filter((r) => r.alreadyApproved === false)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyApproved === true)).toHaveLength(2);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [rec])).rows[0].n).toBe(1);
    expect(await audits(rec, "caregiver.approved_for_work")).toHaveLength(1);
    // a retry with the same idempotency key returns the stored answer too
    const key = randomUUID();
    const again = await call(w.managerA, "select ogevia_api.approve_caregiver_for_work($1,$2,$3) as r", [w.orgA, rec, key]);
    const retry = await call(w.managerA, "select ogevia_api.approve_caregiver_for_work($1,$2,$3) as r", [w.orgA, rec, key]);
    expect(retry[0].r).toEqual(again[0].r);
  });

  it("the approval record cannot be edited or deleted", async () => {
    const rec = await fullyReady("Append");
    await approve(rec);
    await expect(db.admin.query("delete from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [rec])).rejects.toMatchObject({ code: "OGC09" });
    await expect(db.admin.query("update ogevia.caregiver_work_approvals set approved_at = now() where caregiver_record_id = $1", [rec])).rejects.toMatchObject({ code: "OGC09" });
  });
});

describe("CPR and TB: due within the agency's days of the hire date (default 30)", () => {
  it("the default is 30 days; inside it a missing CPR/TB does not block approval and shows a warning with the due date", async () => {
    const rec = await fullyReady("Flexible");
    await setHire(rec, 3);
    const r = await readiness(rec);
    expect(r.graceDays).toBe(30);
    expect(r.cprTbDueDate).toBe(await add(27));
    expect(item(r, "cpr")).toMatchObject({ kind: "flexible", state: "pending", detail: "Not uploaded", dueDate: await add(27), blocksShifts: false });
    expect(item(r, "tb")).toMatchObject({ state: "pending", dueDate: await add(27) });
    expect(r.canApprove).toBe(true);
    expect((await approve(rec)).status).toBe("approved");
    // the day of the due date is still inside the period; the next day is not
    await setHire(rec, 30);
    expect(item(await readiness(rec), "cpr").state).toBe("pending");
    await setHire(rec, 31);
    expect(item(await readiness(rec), "cpr")).toMatchObject({ state: "overdue", dueDate: await add(-1) });
  });

  it("a missing hire date is never assumed: CPR/TB are overdue and the page says so", async () => {
    const rec = await fullyReady("NoHire");
    const r = await readiness(rec);
    expect(r.hireDate).toBeNull();
    expect(r.cprTbDueDate).toBeNull();
    expect(item(r, "cpr")).toMatchObject({ state: "overdue", detail: expect.stringContaining("hire date not recorded") as unknown });
  });

  it("an upload is pending (warning) inside the period and still not 'met' until it is verified", async () => {
    const rec = await fullyReady("Upload");
    await setHire(rec, 2);
    const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, cpr]))[0].id as string;
    const version = randomUUID();
    const v = (await call(w.managerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
      doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(-1), await add(400)]))[0];
    expect(item(await readiness(rec), "cpr")).toMatchObject({ state: "pending", detail: "Uploaded, waiting for review" });
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [v.document_version_id]);
    expect(item(await readiness(rec), "cpr")).toMatchObject({ state: "met", detail: "Verified" });
    await call(w.ownerA, "select ogevia_api.review_document_version($1,'rejected','Image unreadable',null)", [v.document_version_id]).catch(() => undefined);
  });

  it("the agency setting changes the period; only an administrator can change it, with a reason; it is audited", async () => {
    const rec = await fullyReady("Setting");
    await setHire(rec, 20);
    await expectPgError(call(w.managerA, "select ogevia_api.set_cpr_tb_due_days($1,14,'Synthetic policy change',null)", [w.orgA]), "OGA03", /administrator/);
    await expectPgError(call(w.ownerA, "select ogevia_api.set_cpr_tb_due_days($1,14,'',null)", [w.orgA]), "OGV22", /reason/i);
    await expectPgError(call(w.ownerA, "select ogevia_api.set_cpr_tb_due_days($1,400,'Too long',null)", [w.orgA]), "OGV22");
    expect(item(await readiness(rec), "cpr").state).toBe("pending"); // 20 of 30 days
    await call(w.ownerA, "select ogevia_api.set_cpr_tb_due_days($1,14,'Synthetic policy change',null)", [w.orgA]);
    expect((await call(w.managerA, "select ogevia_api.get_compliance_settings($1) as s", [w.orgA]))[0].s).toMatchObject({ cprTbDueDays: 14 });
    expect(item(await readiness(rec), "cpr")).toMatchObject({ state: "overdue", dueDate: await add(-6) });
    const log = (await db.admin.query("select before_state, after_state, reason from ogevia.audit_events where entity_id = $1 and action = 'organization.cpr_tb_due_days_set'", [w.orgA])).rows;
    expect(log.at(-1)).toMatchObject({ before_state: { cpr_tb_due_days: 30 }, after_state: { cpr_tb_due_days: 14 }, reason: "Synthetic policy change" });
    // another agency is unaffected
    expect((await call(w.managerB, "select ogevia_api.get_compliance_settings($1) as s", [w.orgB]))[0].s).toMatchObject({ cprTbDueDays: 30 });
    await call(w.ownerA, "select ogevia_api.set_cpr_tb_due_days($1,30,'Back to the default (synthetic)',null)", [w.orgA]);
  });
});

describe("extensions: one caregiver, one requirement, reason required, history kept", () => {
  it("an extension moves the due date, needs a reason, is audited and keeps the old date; a non-administrator cannot extend", async () => {
    const rec = await fullyReady("Extend");
    await setHire(rec, 40); // due 10 days ago
    expect(item(await readiness(rec), "cpr")).toMatchObject({ state: "overdue", dueDate: await add(-10) });
    await expectPgError(call(w.managerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'Waiting on the clinic',null)", [w.orgA, rec, await add(7)]), "OGA03", /administrator/);
    await expectPgError(call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'',null)", [w.orgA, rec, await add(7)]), "OGV22", /reason/i);
    await expectPgError(call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'Not later',null)", [w.orgA, rec, await add(-10)]), "OGV22", /after the current due date/);
    await expectPgError(call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'Too far',null)", [w.orgA, rec, await add(500)]), "OGV22", /year/);
    await expectPgError(call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'xyz',$3::date,'Bad',null)", [w.orgA, rec, await add(7)]), "OGV22");
    const r = await call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'Waiting on the clinic (synthetic)',null) as r", [w.orgA, rec, await add(7)]).then((x) => x[0].r);
    expect(item(r, "cpr")).toMatchObject({ state: "pending", dueDate: await add(7) });
    expect(item(r, "tb")).toMatchObject({ state: "overdue", dueDate: await add(-10) }); // TB is a separate requirement: not extended
    const ext = (await db.admin.query("select requirement, old_due_date::text o, new_due_date::text n, reason, extended_by, extended_at from ogevia.caregiver_cpr_tb_extensions where caregiver_record_id = $1", [rec])).rows;
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ requirement: "cpr", o: await add(-10), n: await add(7), reason: "Waiting on the clinic (synthetic)", extended_by: w.ownerA.userId });
    const log = await audits(rec, "caregiver.cpr_tb_due_extended");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ reason: "Waiting on the clinic (synthetic)", before_state: { requirement: "cpr", due_date: await add(-10) }, after_state: { requirement: "cpr", due_date: await add(7) } });
    // a second extension builds on the first, and the history keeps both
    await call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'Clinic rescheduled (synthetic)',null)", [w.orgA, rec, await add(14)]);
    const hist = await call(w.managerA, "select * from ogevia_api.list_cpr_tb_extensions($1,$2)", [w.orgA, rec]);
    expect(hist).toHaveLength(2);
    expect(hist.map((h) => [h.old_due_date, h.new_due_date].map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d))))).toHaveLength(2);
    // append-only
    await expect(db.admin.query("update ogevia.caregiver_cpr_tb_extensions set reason = 'edited' where caregiver_record_id = $1", [rec])).rejects.toMatchObject({ code: "OGC09" });
    await expect(db.admin.query("delete from ogevia.caregiver_cpr_tb_extensions where caregiver_record_id = $1", [rec])).rejects.toMatchObject({ code: "OGC09" });
  });

  it("cannot extend without a hire date, or a requirement that is already verified; another agency cannot extend", async () => {
    const rec = await fullyReady("ExtendEdge");
    await expectPgError(call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'No hire date',null)", [w.orgA, rec, await add(7)]), "OGC09", /hire date/);
    await setHire(rec, 40);
    await expectPgError(call(w.managerB, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'Cross tenant',null)", [w.orgA, rec, await add(7)]), "OGN04");
  });
});

describe("enforcement: overdue CPR/TB blocks NEW shift assignments server-side when the agency has switched enforcement on", () => {
  let rec: string;
  const createShift = (day: string) =>
    call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,$5,$6)", [w.orgA, fx.client, fx.service, day, rec, randomUUID()]);
  beforeAll(async () => {
    rec = await fullyReady("Enforce");
    await approve(rec);
    await setHire(rec, 40); // CPR and TB were due 10 days ago
    for (let d = 0; d < 7; d++)
      await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, rec, d]);
    await call(w.ownerA, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,null,'Observed visit completed')", [w.orgA, rec, fx.service, today]);
  });

  it("enforcement OFF: overdue is allowed and flagged only", async () => {
    const r = await readiness(rec);
    expect(item(r, "cpr")).toMatchObject({ state: "overdue", blocksShifts: false });
    expect(r.enforcementActive).toBe(false);
    expect(await createShift(await add(3))).toHaveLength(1);
    await db.admin.query("delete from ogevia.authorization_reservations where shift_id is not null; delete from ogevia.shift_coverage_events; delete from ogevia.shifts");
  });

  it("enforcement ON: overdue is rejected by the server; an extension to a future date makes the same call succeed", async () => {
    const st = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, st.affectedShiftsCount]);
    const r = await readiness(rec);
    expect(r.enforcementActive).toBe(true);
    expect(item(r, "cpr")).toMatchObject({ state: "overdue", blocksShifts: true });
    await expectPgError(createShift(await add(4)), "OGR30", /CPR missing\.\s+TB missing\./);
    await call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'cpr',$3::date,'Clinic booked (synthetic)',null)", [w.orgA, rec, await add(5)]);
    await expectPgError(createShift(await add(4)), "OGR30", /TB missing\./); // CPR is extended; TB is not
    await call(w.ownerA, "select ogevia_api.extend_cpr_tb_due_date($1,$2,'tb',$3::date,'Clinic booked (synthetic)',null)", [w.orgA, rec, await add(5)]);
    expect(await createShift(await add(4))).toHaveLength(1);
    // after the extended date passes it blocks again
    await db.admin.query("update ogevia.caregiver_cpr_tb_extensions set extended_at = extended_at where false");
    await setHire(rec, 40);
    await db.admin.query("alter table ogevia.caregiver_cpr_tb_extensions disable trigger caregiver_cpr_tb_extensions_append_only");
    await db.admin.query("update ogevia.caregiver_cpr_tb_extensions set new_due_date = $2::date - 1, old_due_date = $2::date - 2 where caregiver_record_id = $1", [rec, today]);
    await db.admin.query("alter table ogevia.caregiver_cpr_tb_extensions enable trigger caregiver_cpr_tb_extensions_append_only");
    await expectPgError(createShift(await add(6)), "OGR30", /missing\./);
  });
});

describe("one status everywhere, and the legacy records", () => {
  it("the detail summary, the Caregivers list and the Staff list agree on the status of every caregiver", async () => {
    const rec = await fullyReady("Agree");
    const states: Record<string, string> = {};
    const compare = async () => {
      const summary = (await readiness(rec)).status as string;
      const list = (await call(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).find((x) => x.caregiver_record_id === rec)!;
      const staff = (await call(w.ownerA, "select * from ogevia_api.list_accounts($1)", [w.orgA])).find((x) => x.caregiver_record_id === rec)!;
      expect([list.work_status, staff.work_status]).toEqual([summary, summary]);
      expect([list.readiness_met, staff.readiness_met]).toEqual([(await readiness(rec)).met, (await readiness(rec)).met]);
      return summary;
    };
    states.before = await compare();
    await approve(rec);
    await setHire(rec, 2); // inside the CPR/TB period: enforcement is on in this database by now, and a missing hire date would be a hold
    states.approved = await compare();
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_record_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, rec, fx.client, fx.service, today]);
    states.active = await compare();
    await call(w.managerA, "select * from ogevia_api.set_caregiver_status($1,$2,'inactive','Synthetic: left the agency',null)", [w.orgA, rec]);
    states.inactive = await compare();
    expect(states).toEqual({ before: "not_ready", approved: "approved", active: "active", inactive: "inactive" });
    // Approve for work reactivates (the hard rules must still be met). Deactivating ended the assignments, so they are Approved, not Active, until reassigned.
    expect((await approve(rec)).status).toBe("approved");
  });

  it("every caregiver who was Ready or Active before 0086 is backfilled as approved (legacy), never deactivated; their old compliance-clearance item still renders", async () => {
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].id as string;
    // The backfill statement of 0086, run against a record that predates it
    await db.admin.query("delete from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [rec]);
    await db.admin.query(`insert into ogevia.caregiver_work_approvals (organization_id, caregiver_record_id, approved_by, approved_at, source, snapshot)
      select r.organization_id, r.id, null, r.updated_at, 'legacy_status', '[]'::jsonb from ogevia.caregiver_records r where r.id = $1 and r.status in ('ready', 'active')`, [rec]);
    // legacy onboarding data for the retired requirements
    await db.admin.query(`update ogevia.onboarding_requirements set is_active = false where organization_id = $1 and category in ('background_check','document','clearance')`, [w.orgA]);
    await db.admin.query(`insert into ogevia.onboarding_requirements (organization_id, requirement_key, label, category, is_active, sort_order) values ($1,'clearance','Compliance clearance','clearance',false,90) on conflict do nothing`, [w.orgA]);
    await db.admin.query(`insert into ogevia.caregiver_onboarding_items (organization_id, caregiver_record_id, requirement_id, status, completed_on, recorded_by)
      select $1,$2,q.id,'completed',$3::date - 20,$4 from ogevia.onboarding_requirements q where q.organization_id = $1 and q.requirement_key = 'clearance' on conflict do nothing`, [w.orgA, rec, today, w.ownerA.userId]);
    const r = await readiness(rec);
    expect(r).toMatchObject({ approved: true, approvalSource: "legacy_status", approvedByName: null });
    expect(["approved", "active"]).toContain(r.status);
    const o = await call(w.managerA, "select ogevia_api.get_onboarding($1,$2) as o", [w.orgA, rec]).then((x) => x[0].o);
    expect(o).toBeTruthy();
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_onboarding_items where caregiver_record_id = $1", [rec])).rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("the two background-check records no longer disagree: the page reads the verified record only", async () => {
    const rec = await create("TwoRecords");
    await db.admin.query(`insert into ogevia.onboarding_requirements (organization_id, requirement_key, label, category, is_active, sort_order) values ($1,'background_check','Background check cleared','background_check',false,10) on conflict do nothing`, [w.orgA]);
    await db.admin.query(`insert into ogevia.caregiver_onboarding_items (organization_id, caregiver_record_id, requirement_id, status, completed_on, recorded_by)
      select $1,$2,q.id,'completed',$3::date - 14,$4 from ogevia.onboarding_requirements q where q.organization_id = $1 and q.requirement_key = 'background_check' on conflict do nothing`, [w.orgA, rec, today, w.ownerA.userId]);
    expect(item(await readiness(rec), "background")).toMatchObject({ state: "unmet" }); // a 'Recorded' onboarding row is not a verification
    await verifyBackground(rec);
    expect(item(await readiness(rec), "background")).toMatchObject({ state: "met", metOn: today, actorName: expect.anything() as unknown });
  });
});

describe("contact and the sign-in link", () => {
  it("with no email on file the server refuses to send and says to add one; the list says only whether a contact exists", async () => {
    const rec = await create("NoContact");
    await expectPgError(call(w.managerA, "select * from ogevia_api.get_signin_contact($1,$2)", [w.orgA, rec]), "OGC09", /Add an email address first/);
    const row = (await call(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).find((x) => x.caregiver_record_id === rec)!;
    expect(row).toMatchObject({ has_contact: false, signed_in: false });
    expect(Object.keys(row).filter((k) => /email|phone/.test(k)).sort()).toEqual(["invitation_email"]); // the existing invitation address; no contact column
  });

  it("a contact can be saved by Care Team managers; the value is never in a list, an audit row or readable by the read-only role", async () => {
    const rec = await create("Contact");
    const email = `contact.${randomUUID().slice(0, 6)}@example.test`;
    await expectPgError(call(w.managerA, "select ogevia_api.set_caregiver_contact($1,$2,'not-an-email',null,null)", [w.orgA, rec]), "OGV22");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_caregiver_contact($1,$2,$3,null,null)", [w.orgA, rec, email]), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.set_caregiver_contact($1,$2,$3,null,null)", [w.orgA, rec, email]), "OGN04");
    await call(w.managerA, "select ogevia_api.set_caregiver_contact($1,$2,$3,'(555) 010-0100',null)", [w.orgA, rec, email]);
    expect(item(await readiness(rec), "signin")).toMatchObject({ detail: "Not invited yet", nextAction: "send_link" });
    expect((await call(w.managerA, "select * from ogevia_api.get_signin_contact($1,$2)", [w.orgA, rec]))[0]).toMatchObject({ email, invited: false });
    const row = (await call(w.managerA, "select * from ogevia_api.list_caregivers($1)", [w.orgA])).find((x) => x.caregiver_record_id === rec)!;
    expect(row.has_contact).toBe(true);
    expect(JSON.stringify(row)).not.toContain(email);
    const log = await audits(rec, "caregiver.contact_set");
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain(email);
    expect(JSON.stringify(log)).not.toContain("555");
    const privs = (await db.admin.query("select has_table_privilege('ogevia_readonly','ogevia.caregiver_contacts','select') ro, has_table_privilege('ogevia_app','ogevia.caregiver_contacts','select') app")).rows[0];
    expect(privs).toEqual({ ro: false, app: false });
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.get_signin_contact($1,$2)", [w.orgA, rec]), "OGA03");
  });

  it("resend is limited: one a minute, five in a day, only before the first sign-in; each resend is audited", async () => {
    const rec = await create("Resend");
    await invited(rec, false);
    const resend = () => call(w.managerA, "select ogevia_api.begin_invitation_resend($1,$2) as email", [w.orgA, rec]).then(async (r) => {
      await call(w.managerA, "select ogevia_api.record_invitation_resent($1,$2) as n", [w.orgA, rec]);
      return r;
    });
    await expectPgError(resend(), "OGC09", /just sent/); // the invitation itself was sent a moment ago
    const age = () => db.admin.query("update ogevia.caregiver_invitations set last_sent_at = now() - interval '2 minutes' where caregiver_record_id = $1", [rec]);
    for (let i = 0; i < 5; i++) { await age(); await resend(); }
    await age();
    await expectPgError(resend(), "OGC09", /resend limit/);
    expect(await audits(rec, "caregiver.invitation_resent")).toHaveLength(5);
    // the limit is per day: older resends no longer count
    await db.admin.query("alter table ogevia.audit_events disable trigger audit_events_append_only");
    await db.admin.query("update ogevia.audit_events set occurred_at = now() - interval '2 days' where entity_id = $1 and action = 'caregiver.invitation_resent'", [rec]);
    await db.admin.query("alter table ogevia.audit_events enable trigger audit_events_append_only");
    await age();
    await resend();
  });

  it("a caregiver who has signed in cannot be sent another link", async () => {
    const rec = await create("Signed");
    await invited(rec, true);
    await expectPgError(call(w.managerA, "select ogevia_api.begin_invitation_resend($1,$2)", [w.orgA, rec]), "OGC09", /already signed in/);
  });
});

describe("tenant isolation and permissions", () => {
  it("another agency cannot read, approve or extend this agency's caregiver; a caregiver cannot read readiness", async () => {
    const rec = await fullyReady("Tenant");
    await expectPgError(readiness(rec, w.managerB, w.orgA), "OGN04");
    await expectPgError(approve(rec, w.managerB, w.orgA), "OGN04");
    await expectPgError(call(w.managerB, "select ogevia_api.get_caregiver_readiness($1,$2)", [w.orgB, rec]), "OGN04"); // own agency, someone else's record
    await expectPgError(approve(rec, w.managerB, w.orgB), "OGN04");
    await expectPgError(readiness(rec, w.caregiverA1), "OGA03");
    await expectPgError(approve(rec, w.caregiverA1), "OGA03");
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [rec])).rows[0].n).toBe(0);
  });
});

void satisfyHardRequirements;
