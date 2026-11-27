// 0123 (PENDING): admin override of a CPR/TB document readiness block. Runs the REAL scheduling workflow (ogevia_api.create_shift) with readiness enforcement activated. SYNTHETIC data only.
// Scope: one caregiver, one requirement, one exact issue. The document keeps its status; the original work approval and every override are kept; other scheduling rules still apply.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const P = (n: string) => new URL(`../pending/${n}`, import.meta.url);
let db: TestDb; let w: World; let today: string; let fx: { client: string; service: string; auth: string }; let cpr: string; let tb: string;
const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows as any[];
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
let seq = 0; let dayN = 3;
const create = async (last: string) => (await call(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,'onboarding',null)", [w.orgA, `${last} ${++seq}`]))[0].caregiver_record_id as string;
async function invited(rec: string) {
  const sub = randomUUID(); const email = `synthetic.${randomUUID().slice(0, 8)}@example.test`;
  await call(w.managerA, "select ogevia_api.begin_caregiver_invitation($1,$2,$3)", [w.orgA, rec, email]);
  await call(w.managerA, "select * from ogevia_api.complete_caregiver_invitation($1,$2,$3,$4,false)", [w.orgA, rec, email, sub]);
  await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
}
/** Everything the hard rules need EXCEPT the work approval: background clear, training done, signed in, available every day. */
async function readyForApproval(last: string, hireDaysAgo = 5) {
  const rec = await create(last);
  await invited(rec);
  await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [w.orgA, rec]);
  await call(w.managerA, "select ogevia_api.record_onboarding_item($1,$2,'training','complete',$3::date,null,null,null)", [w.orgA, rec, today]);
  await q("update ogevia.caregiver_records set hire_date = $2::date - $3::int where id = $1", [rec, today, hireDaysAgo]);
  for (const d of [0, 1, 2, 3, 4, 5, 6]) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, rec, d]);
  return rec;
}
const workApprove = (rec: string) => call(w.ownerA, "select ogevia_api.approve_caregiver_for_work($1,$2,$3)", [w.orgA, rec, randomUUID()]);
const schedule = async (rec: string, start = "09:00", end = "10:00", day?: string) => { const d = day ?? (await add(dayN++)); return call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [w.orgA, fx.client, fx.service, d, start, end, rec]); };
const readiness = (rec: string) => call(w.ownerA, "select ogevia_api.get_caregiver_readiness($1,$2) as r", [w.orgA, rec]).then((r) => r[0].r);
const item = (r: any, k: string) => r.items.find((i: any) => i.requirement === k);
const evaluate = (rec: string) => q("select ogevia.compliance_evaluate($1,$2,null,now()) as r", [w.orgA, rec]);
const openHold = async (rec: string) => (await q("select count(*)::int n from ogevia.caregiver_compliance_holds where caregiver_record_id = $1 and released_at is null", [rec]))[0].n as number;
/** Simulates time passing: moves a document version's dates (the append-only guard is bypassed for this one statement; the application cannot do this). */
async function setDates(version: string, f: { expires?: number | null; issued?: number }) {
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local session_replication_role = replica");
    if (f.expires !== undefined) await c.query("update ogevia.document_versions set expires_on = $2::date where id = $1", [version, f.expires === null ? null : await add(f.expires)]);
    if (f.issued !== undefined) await c.query("update ogevia.document_versions set issued_on = $2::date where id = $1", [version, await add(f.issued)]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const sha = "c".repeat(64);
async function documentFor(rec: string, type: string, verdict: "verified" | "rejected", issued: number, expires: number | null) {
  let doc = (await q("select id from ogevia.staff_documents where caregiver_record_id=$1 and document_type_id=$2 and closed_at is null", [rec, type]))[0]?.id as string | undefined;
  if (!doc) doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
  const version = randomUUID();
  const row = (await call(w.ownerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(issued), expires === null ? null : await add(expires)]))[0];
  await call(w.ownerA, "select ogevia_api.review_document_version($1,$2,$3,$4)", [row.document_version_id, verdict, verdict === "rejected" ? "Synthetic: not legible" : null, null]);
  return row.document_version_id as string;
}
const approveOverride = (rec: string, req: string, key: string, reason = "Reviewed the card on file; renewal booked", a: Actor = w.ownerA) =>
  call(a, "select ogevia_api.approve_readiness_override($1,$2,$3,$4,$5,$6) as r", [w.orgA, rec, req, key, reason, randomUUID()]).then((r) => r[0].r);
const revokeOverride = (id: string, reason = "Renewal did not happen", a: Actor = w.ownerA, org = w.orgA) => call(a, "select ogevia_api.revoke_readiness_override($1,$2,$3,$4) as r", [org, id, reason, randomUUID()]).then((r) => r[0].r);
const overrides = (rec: string | null = null, activeOnly = false) => call(w.ownerA, "select ogevia_api.list_readiness_overrides($1,$2,$3) as r", [w.orgA, rec, activeOnly]).then((r) => r[0].r as any[]);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: process.env.OGEVIA_TEST_WITH_LIVE === "1" });   // also run with the live-test layers (0100 wraps action_issue_rows): OGEVIA_TEST_WITH_LIVE=1
  w = await seedWorld(db, 1500);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 300 });
  await run(P("migrations/0103_caregiver_signin_override.sql"));
  await run(P("migrations/0122_unset_cpr_tb_type_not_a_block.sql"));
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  const st = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
  await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, st.affectedShiftsCount]);
  await run(P("migrations/0123_readiness_override.sql"));
}, 180_000);
afterAll(async () => db?.drop());

describe("CASE 1 and 2: a previously approved caregiver's CPR expires", () => {
  let rec: string; let cprVersion: string; let key: string; let overrideId: string;
  it("1. the CPR expires after approval: the row says Expired Doc, scheduling is blocked and a compliance hold opens (enforcement on)", async () => {
    rec = await readyForApproval("Expiring");
    await documentFor(rec, tb, "verified", -5, null);
    cprVersion = await documentFor(rec, cpr, "verified", -30, 10);              // valid for 10 more days
    await workApprove(rec);
    expect(await schedule(rec)).toHaveLength(1);                                 // approved and current: schedulable
    await setDates(cprVersion, { expires: -1 });                                   // the calendar moves: the card has now expired
    await expectPgError(schedule(rec), "OGR30", /CPR/i);
    const r = await readiness(rec);
    expect(item(r, "cpr")).toMatchObject({ state: "problem", detail: "Expired", blocksShifts: true, extra: { issueStatus: "expired", issueLabel: "Expired Doc" } });
    expect(item(r, "cpr").extra.override).toBeUndefined();
    key = item(r, "cpr").extra.issueKey;
    await evaluate(rec);
    expect(await openHold(rec)).toBe(1);
  });
  it("a reason is required, an unauthorized user cannot approve, and a stale issue is refused", async () => {
    await expectPgError(approveOverride(rec, "cpr", key, "no"), "OGV22", /reason/i);
    await expectPgError(approveOverride(rec, "cpr", key, "A perfectly good reason", w.managerA), "OGA03");
    await expectPgError(approveOverride(rec, "cpr", key, "A perfectly good reason", w.caregiverA1), "OGA03");
    await expectPgError(call(w.managerB, "select ogevia_api.approve_readiness_override($1,$2,'cpr',$3,'A perfectly good reason',null)", [w.orgA, rec, key]), "OGN04");
    await expectPgError(approveOverride(rec, "cpr", "expired:" + randomUUID() + ":2020-01-01"), "OGC09", /changed since you opened/);
    await expectPgError(approveOverride(rec, "tb", key), "OGC09", /already verified/);
    expect(await overrides(rec)).toHaveLength(0);
  });
  it("2. the admin approves the override: scheduling succeeds, the row still says Expired Doc and now Admin Approved with who, when and why; the document stays Expired", async () => {
    const out = await approveOverride(rec, "cpr", key);
    overrideId = out.id;
    expect(out).toMatchObject({ requirement: "cpr", issueStatus: "expired", active: true });
    expect(await schedule(rec)).toHaveLength(1);
    const r = await readiness(rec);
    const row = item(r, "cpr");
    expect(row).toMatchObject({ state: "problem", detail: "Expired", blocksShifts: false, extra: { issueLabel: "Expired Doc", issueStatus: "expired" } });
    expect(row.extra.override).toMatchObject({ id: overrideId, reason: "Reviewed the card on file; renewal booked" });
    expect(row.extra.override.approvedByName).toBeTruthy();
    expect(row.extra.override.validUntil).toBe(await add(-1));
    expect((await q("select status from ogevia.document_requirement_check($1,$2,'cpr',null,null)", [w.orgA, rec]))[0].status).toBe("expired");   // never turned into current
    expect(r.approved).toBe(true);                                               // the original work approval is untouched
    expect(await openHold(rec)).toBe(0);                                         // no automatic hold while the override is in force
    const [o] = await overrides(rec);
    expect(o).toMatchObject({ active: true, stillApplies: true, issueLabel: "Expired Doc", requirement: "cpr", validUntil: await add(-1) });
    expect(o.caregiverCode).toMatch(/^CG-/);
    expect((await q("select count(*)::int n from ogevia.audit_events where action = 'caregiver.readiness_override_approved' and entity_id = $1", [overrideId]))[0].n).toBe(1);
  });
  it("approving the same issue again changes nothing (one override, one audit event)", async () => {
    const again = await approveOverride(rec, "cpr", key, "Second click, same issue");
    expect(again.id).toBe(overrideId);
    expect(await overrides(rec)).toHaveLength(1);
    expect((await q("select count(*)::int n from ogevia.audit_events where action = 'caregiver.readiness_override_approved' and entity_id = $1", [overrideId]))[0].n).toBe(1);
  });
  it("normal scheduling rules stay in force: an overlapping shift is still refused", async () => {
    const day = await add(40);
    expect(await schedule(rec, "09:00", "10:00", day)).toHaveLength(1);
    await expectPgError(schedule(rec, "09:30", "10:30", day), "OGC09", /already has a shift/i);
  });
  it("4. revoking restores the block (and the hold), keeps the history, and a re-approval is a new record", async () => {
    await expectPgError(revokeOverride(overrideId, "no"), "OGV22");
    await expectPgError(revokeOverride(overrideId, "Renewal did not happen", w.managerA), "OGA03");
    await expectPgError(revokeOverride(overrideId, "Renewal did not happen", w.caregiverA1), "OGA03");
    await expectPgError(revokeOverride(overrideId, "Renewal did not happen", w.managerB), "OGN04");
    const out = await revokeOverride(overrideId);
    expect(out).toMatchObject({ active: false });
    await expectPgError(schedule(rec), "OGR30", /CPR/i);
    expect(item(await readiness(rec), "cpr")).toMatchObject({ blocksShifts: true });
    expect(item(await readiness(rec), "cpr").extra.override).toBeUndefined();
    await evaluate(rec);
    expect(await openHold(rec)).toBe(1);
    const [h] = await overrides(rec);
    expect(h).toMatchObject({ active: false, revokeReason: "Renewal did not happen" });
    expect(h.revokedByName).toBeTruthy();
    const again = await approveOverride(rec, "cpr", key, "Approved again after review");
    expect(again.id).not.toBe(overrideId);
    expect((await overrides(rec)).map((x) => x.active)).toEqual([true, false]);
    expect(await schedule(rec)).toHaveLength(1);
  });
  it("the history is append-only: no delete, no edit of an approval", async () => {
    await expectPgError(db.admin.query("delete from ogevia.caregiver_readiness_overrides where id = $1", [overrideId]), "OGC09");
    await expectPgError(db.admin.query("update ogevia.caregiver_readiness_overrides set reason = 'changed after the fact' where id = $1", [overrideId]), "OGC09");
  });
  it("a different issue needs a new decision: a new upload, or a later expiry, is not covered; another requirement still blocks", async () => {
    // a NEW expired document (different version and expiry) for the same requirement
    await documentFor(rec, cpr, "verified", -60, -2);
    const r = await readiness(rec);
    expect(item(r, "cpr").extra.override).toBeUndefined();
    expect(item(r, "cpr").blocksShifts).toBe(true);
    await expectPgError(schedule(rec), "OGR30", /CPR/i);
    // and TB expiring is its own issue
    const other = await readyForApproval("TwoIssues");
    const cprV = await documentFor(other, cpr, "verified", -30, 10); const tbV = await documentFor(other, tb, "verified", -400, null);
    await workApprove(other);
    expect(cprV && tbV).toBeTruthy();
    await setDates(cprV, { expires: -1 }); await setDates(tbV, { issued: -500 });
    const ro = await readiness(other);
    await approveOverride(other, "cpr", item(ro, "cpr").extra.issueKey);
    await expectPgError(schedule(other), "OGR30", /TB/i);                         // CPR is overridden, TB still blocks
    expect(item(await readiness(other), "tb").blocksShifts).toBe(true);
  });
});

describe("CASE 3: a caregiver who has never been approved for work", () => {
  it("the admin records the work approval and explicitly overrides the readiness issue; both are kept", async () => {
    const rec = await readyForApproval("NeverApproved", 90);                       // hired long ago, no CPR or TB on file
    await documentFor(rec, tb, "verified", -5, null);
    await expectPgError(schedule(rec), "OGV22", /Ready to work or Active/);        // not approved yet
    expect(item(await readiness(rec), "cpr")).toMatchObject({ extra: { issueStatus: "missing", issueLabel: "Missing Doc" } });
    await workApprove(rec);
    expect((await q("select count(*)::int n from ogevia.caregiver_work_approvals where caregiver_record_id = $1", [rec]))[0].n).toBe(1);
    await expectPgError(schedule(rec), "OGR30", /CPR/i);                           // approval alone does not lift the document block
    const r = await readiness(rec);
    const out = await approveOverride(rec, "cpr", item(r, "cpr").extra.issueKey, "Card is being renewed; supervised first week");
    expect(out.issueStatus).toBe("missing");
    expect(await schedule(rec)).toHaveLength(1);
    expect(item(await readiness(rec), "cpr")).toMatchObject({ state: "overdue", detail: "Not uploaded", blocksShifts: false });
  });
  it("pending review and rejected documents can be overridden the same way, each for its own issue", async () => {
    const pend = await readyForApproval("Pending", 90); await documentFor(pend, tb, "verified", -5, null); await workApprove(pend);
    const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, pend, cpr]))[0].id;
    const v = randomUUID();
    await call(w.ownerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [doc, v, `${w.orgA}/documents/${doc}/${v}`, sha, await add(-2), await add(300)]);
    expect(item(await readiness(pend), "cpr").extra.issueStatus).toBe("awaiting_review");
    await expectPgError(schedule(pend), "OGR30", /CPR/i);
    await approveOverride(pend, "cpr", item(await readiness(pend), "cpr").extra.issueKey);
    expect(await schedule(pend)).toHaveLength(1);
    const rej = await readyForApproval("Rejected", 5); await documentFor(rej, tb, "verified", -5, null); await documentFor(rej, cpr, "rejected", -2, 300); await workApprove(rej);
    await expectPgError(schedule(rej), "OGR30");
    expect(item(await readiness(rej), "cpr").extra.issueLabel).toBe("Rejected Doc");
    await approveOverride(rej, "cpr", item(await readiness(rej), "cpr").extra.issueKey);
    expect(await schedule(rej)).toHaveLength(1);
  });
  it("an override cannot be used for what is not a document issue: a verified requirement, or an unset document type or rule", async () => {
    const ok = await readyForApproval("Fine"); await documentFor(ok, cpr, "verified", -5, 300); await documentFor(ok, tb, "verified", -5, null); await workApprove(ok);
    await expectPgError(approveOverride(ok, "cpr", "ok:none:"), "OGC09", /already verified/);
    await q("update ogevia.document_types set is_active = false where id = any($1::uuid[])", [[cpr, tb]]);
    try {
      const unset = await readyForApproval("Unset"); await workApprove(unset);
      await expectPgError(approveOverride(unset, "cpr", "type_not_set:none:"), "OGC09", /not finished the CPR and TB setup/i);
      expect(await schedule(unset)).toHaveLength(1);                                // 0122 is unchanged: an unset type does not block an approved caregiver
    } finally { await q("update ogevia.document_types set is_active = true where id = any($1::uuid[])", [[cpr, tb]]); }
  });
});

describe("compliance reports and the follow-up view keep the flag; the background check is not overridable", () => {
  it("the compliance read keeps a non-blocking, labelled row for an overridden issue, and the report lists it with who, why and whether it still applies", async () => {
    const rec = await readyForApproval("Report"); await documentFor(rec, tb, "verified", -5, null);
    const v = await documentFor(rec, cpr, "verified", -30, 10); await workApprove(rec);
    await setDates(v, { expires: -1 });
    await approveOverride(rec, "cpr", item(await readiness(rec), "cpr").extra.issueKey);
    const snap = (await call(w.ownerA, "select ogevia_api.get_caregiver_compliance($1,$2) as r", [w.orgA, rec]))[0].r;
    expect(snap.eligible).toBe(true);
    const cprRow = snap.requirements.find((x: any) => x.requirement === "cpr");
    expect(cprRow).toMatchObject({ documentStatus: "expired", blocking: false, pending: true, code: "overridden_expired", message: "Expired Doc: approved by an administrator" });
    const all = await overrides(null, true);
    expect(all.some((x) => x.caregiverRecordId === rec && x.stillApplies && x.reason)).toBe(true);
  });
  it("the follow-up queue (Action Needed, documents and compliance) lists the overridden issue while it is in force and the document is still not fixed, and drops it once the document is verified or the override is revoked", async () => {
    const rec = await readyForApproval("Queue"); await documentFor(rec, tb, "verified", -5, null);
    const v = await documentFor(rec, cpr, "verified", -30, 10); await workApprove(rec);
    await setDates(v, { expires: -1 });
    const issues = async () => (await call(w.ownerA, "select ogevia_api.list_action_issues($1,'documents_compliance',null,null,null,$2,null,50,0) as r", [w.orgA, rec]))[0].r.issues.filter((i: any) => i.reason === "readiness_override") as any[];
    const inQueue = async () => (await issues()).length;
    expect(await inQueue()).toBe(0);
    const out = await approveOverride(rec, "cpr", item(await readiness(rec), "cpr").extra.issueKey);
    expect(await inQueue()).toBe(1);
    expect((await issues())[0]).toMatchObject({ action: "review_readiness_override", queue: "documents_compliance", caregiverRecordId: rec });
    expect((await issues())[0].recommendedAction).toMatch(/not fixed/);
    await revokeOverride(out.id);
    expect(await inQueue()).toBe(0);
    const again = await approveOverride(rec, "cpr", item(await readiness(rec), "cpr").extra.issueKey);
    expect(again.id).toBeTruthy();
    expect(await inQueue()).toBe(1);
    await documentFor(rec, cpr, "verified", -2, 300);                                // the real fix: a verified, current card (a new version, so the old override no longer applies and nothing is left to follow up)
    expect(item(await readiness(rec), "cpr").state).toBe("met");
    expect(await inQueue()).toBe(0);
  });
  it("a not-approved background check is not overridable: no override API accepts it and scheduling stays blocked", async () => {
    const rec = await readyForApproval("Bg"); await documentFor(rec, cpr, "verified", -5, 300); await documentFor(rec, tb, "verified", -5, null); await workApprove(rec);
    await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'not_approved','Synthetic: not cleared',null)", [w.orgA, rec]);
    await expectPgError(schedule(rec), "OGR30", /background/i);
    await expectPgError(approveOverride(rec, "background", "x:none:"), "OGV22");
  });
});

const psql = (args: string[]) => spawnSync("psql", ["-X", "-At", "-F", "|", ...args, `postgres://postgres@127.0.0.1:5432/${db.name}`], { encoding: "utf8" });
const VERIFY = new URL("../../../../docs/releases/2026-11-20-test-plan/toolchain/VERIFY_PENDING.sql", import.meta.url).pathname;
describe("deployment check", () => {
  it("VERIFY_PENDING passes when present (only the ledger row is missing in a test database)", () => {
    const pres = psql(["-v", "mig=0123", "-v", "expect=present", "-f", VERIFY]);
    expect(pres.stderr).toBe("");
    expect(pres.stdout.split("\n").filter((l) => l.includes("|f|"))).toEqual(["ledger row 0123 present|f|"]);
  });
});

describe("rollback", () => {
  it("restores the 0122 behaviour (an expired document blocks again, overridden or not), drops the table and the API, and re-applying is safe", async () => {
    const rec = await readyForApproval("Back"); await documentFor(rec, tb, "verified", -5, null);
    const v = await documentFor(rec, cpr, "verified", -30, 10); await workApprove(rec);
    await setDates(v, { expires: -1 });
    await approveOverride(rec, "cpr", item(await readiness(rec), "cpr").extra.issueKey);
    expect(await schedule(rec)).toHaveLength(1);
    await run(P("rollback/0123_readiness_override.down.sql"));
    expect((await q("select to_regclass('ogevia.caregiver_readiness_overrides') is null as gone"))[0].gone).toBe(true);
    expect(psql(["-v", "mig=0123", "-v", "expect=absent", "-f", VERIFY]).stdout.split("\n").filter((l) => l.includes("|f|"))).toEqual([]);
    await expectPgError(schedule(rec), "OGR30", /CPR/i);
    await run(P("migrations/0123_readiness_override.sql"));
    expect(await overrides(rec)).toHaveLength(0);                                  // the table was dropped with its history (backup required, as the script says)
  });
});
