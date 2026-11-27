// 0122 (PENDING): an unconfigured CPR or TB document TYPE no longer blocks scheduling a caregiver whose admin work approval is RECORDED; enforcement stays ON and every other rule is unchanged.
// Owner decision 2026-11-27. Runs the REAL scheduling workflow (ogevia_api.create_shift, the commit guards, the compliance sweep) with readiness enforcement activated. SYNTHETIC data only.
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
let seq = 0;
const create = async (last: string) =>
  (await call(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic',$2,null,'onboarding',null)", [w.orgA, `${last} ${++seq}`]))[0].caregiver_record_id as string;
async function invited(rec: string) {
  const sub = randomUUID(); const email = `synthetic.${randomUUID().slice(0, 8)}@example.test`;
  await call(w.managerA, "select ogevia_api.begin_caregiver_invitation($1,$2,$3)", [w.orgA, rec, email]);
  await call(w.managerA, "select * from ogevia_api.complete_caregiver_invitation($1,$2,$3,$4,false)", [w.orgA, rec, email, sub]);
  await asActor(db, sub, (c) => c.query("select ogevia_api.note_my_sign_in()"));
}
/** background clear, training done, signed in, availability every day, ADMIN-APPROVED for work (a recorded approval). */
async function approvedCaregiver(last: string, opts: { hireDaysAgo?: number } = {}) {
  const rec = await create(last);
  await invited(rec);
  await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [w.orgA, rec]);
  await call(w.managerA, "select ogevia_api.record_onboarding_item($1,$2,'training','complete',$3::date,null,null,null)", [w.orgA, rec, today]);
  await q("update ogevia.caregiver_records set hire_date = $2::date - $3::int where id = $1", [rec, today, opts.hireDaysAgo ?? 5]);
  for (const d of [0, 1, 2, 3, 4, 5, 6]) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, rec, d]);
  await call(w.managerA, "select ogevia_api.approve_caregiver_for_work($1,$2,$3)", [w.orgA, rec, randomUUID()]);
  return rec;
}
let dayN = 3;
const schedule = async (rec: string) => { const day = await add(dayN++); return call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00','10:00',$5,null)", [w.orgA, fx.client, fx.service, day, rec]); };
const readiness = (rec: string) => call(w.managerA, "select ogevia_api.get_caregiver_readiness($1,$2) as r", [w.orgA, rec]).then((r) => r[0].r);
const snapshot = (rec: string) => call(w.ownerA, "select ogevia_api.get_caregiver_compliance($1,$2) as r", [w.orgA, rec]).then((r) => r[0].r);
const item = (r: any, k: string) => r.items.find((i: any) => i.requirement === k);
const evaluate = (rec: string) => q("select ogevia.compliance_evaluate($1,$2,null,now()) as r", [w.orgA, rec]);
const openHold = async (rec: string) => (await q("select count(*)::int n from ogevia.caregiver_compliance_holds where caregiver_record_id = $1 and released_at is null", [rec]))[0].n as number;
const setTypesActive = (on: boolean) => q("update ogevia.document_types set is_active = $2 where id = any($1::uuid[])", [[cpr, tb], on]);
const sha = "c".repeat(64);
async function documentFor(rec: string, type: string, verdict: "verified" | "rejected", issued: number, expires: number | null) {
  const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
  const version = randomUUID();
  const row = (await call(w.ownerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(issued), expires === null ? null : await add(expires)]))[0];
  await call(w.ownerA, "select ogevia_api.review_document_version($1,$2,$3,$4)", [row.document_version_id, verdict, verdict === "rejected" ? "Synthetic: not legible" : null, null]);
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1400);
  today = await orgToday(db);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 200 });
  await run(P("migrations/0103_caregiver_signin_override.sql"));      // the live caregiver_readiness is the 0103 version
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  // enforcement is ACTIVATED through the real workflow (it refuses until CPR and TB are set up), then the types are retired to reach "document type not set up with enforcement on"
  const st = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
  await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, st.affectedShiftsCount]);
}, 180_000);
afterAll(async () => db?.drop());

describe("before 0122 (the 0088 rule): an unset type blocks even an approved caregiver", () => {
  it("with enforcement on, an approved caregiver cannot be scheduled while the CPR/TB document types are not set up, and an automatic compliance hold opens", async () => {
    await setTypesActive(false);
    const rec = await approvedCaregiver("Before");
    await expectPgError(schedule(rec), "OGR30");
    await evaluate(rec);
    expect(await openHold(rec)).toBe(1);
    await q("select 1");
    (globalThis as any).__before = rec;
  });
});

describe("0122 applied", () => {
  beforeAll(async () => { await run(P("migrations/0122_unset_cpr_tb_type_not_a_block.sql")); });

  it("the hold that existed only because of the unset type is released by the next evaluation, and the caregiver can then be scheduled", async () => {
    const rec = (globalThis as any).__before as string;
    await evaluate(rec);
    expect(await openHold(rec)).toBe(0);
    expect(await schedule(rec)).toHaveLength(1);
  });

  it("CASE 1: an admin-approved caregiver with CPR and TB unconfigured and no other hold can be scheduled with enforcement ON; the profile says Document type not set up and shows no block", async () => {
    const rec = await approvedCaregiver("Case1");
    expect((await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s.enforcementActive).toBe(true);
    expect(await schedule(rec)).toHaveLength(1);
    const r = await readiness(rec);
    for (const k of ["cpr", "tb"]) expect(item(r, k)).toMatchObject({ state: "problem", detail: "Document type not set up", blocksShifts: false });
    expect(r.approved).toBe(true);
    const s = await snapshot(rec);
    expect(s.eligible).toBe(true);
    expect(s.hold).toBeNull();
  });

  it("a caregiver WITHOUT a recorded approval is treated exactly as before (the type gap still blocks the compliance check for them)", async () => {
    const rec = await create("NoApproval");
    await invited(rec);
    await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'approved','Synthetic clearance on file',null)", [w.orgA, rec]);
    const r = await readiness(rec);
    expect(r.approved).toBe(false);
    expect(item(r, "cpr")).toMatchObject({ detail: "Document type not set up", blocksShifts: true });
    expect((await snapshot(rec)).eligible).toBe(false);
  });

  it("an agency document RULE that is not set up (the type exists, the validity rule does not) still blocks, approved or not", async () => {
    await setTypesActive(true);
    await q("delete from ogevia.document_requirement_policies where requirement = 'cpr' and organization_id = $1", [w.orgA]);
    const rec = await approvedCaregiver("PolicyGap");
    const r = await readiness(rec);
    expect(item(r, "cpr").detail).toBe("Agency document rule not set up");
    expect(item(r, "cpr").blocksShifts).toBe(true);
    await expectPgError(schedule(rec), "OGR30");
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  });

  it("CASE 2: once the types are CONFIGURED, the existing rules apply: a missing credential past its due date, a rejected one and an expired one block; a current one passes", async () => {
    await setTypesActive(true);
    const late = await approvedCaregiver("Late", { hireDaysAgo: 90 });                       // hired long ago, nothing uploaded
    await expectPgError(schedule(late), "OGR30", /CPR/i);
    const rejected = await approvedCaregiver("Rejected", { hireDaysAgo: 5 });
    await documentFor(rejected, cpr, "rejected", -2, 300);
    await expectPgError(schedule(rejected), "OGR30");
    const expired = await approvedCaregiver("Expired", { hireDaysAgo: 5 });
    await documentFor(expired, cpr, "verified", -400, -5);
    await expectPgError(schedule(expired), "OGR30");
    const current = await approvedCaregiver("Current", { hireDaysAgo: 5 });
    await documentFor(current, cpr, "verified", -5, 300); await documentFor(current, tb, "verified", -5, null);
    expect(await schedule(current)).toHaveLength(1);
    // inside the grace period a missing credential is still only a warning (unchanged 0088 rule)
    const inGrace = await approvedCaregiver("Grace", { hireDaysAgo: 2 });
    expect(await schedule(inGrace)).toHaveLength(1);
  });

  it("CASE 3: an independent hold still blocks, and the profile's compliance read shows the actual reason (type unset again, so only the other hold applies)", async () => {
    await setTypesActive(false);
    const rec = await approvedCaregiver("Independent");
    expect(await schedule(rec)).toHaveLength(1);                                             // type gap alone: schedulable
    await call(w.ownerA, "select ogevia_api.verify_background_check($1,$2,'not_approved','Synthetic: not cleared',null)", [w.orgA, rec]);
    await expectPgError(schedule(rec), "OGR30", /background/i);
    const s = await snapshot(rec);
    expect(s.eligible).toBe(false);
    expect(s.background).toMatchObject({ qualifies: false, state: "not_approved" });
    const r = await readiness(rec);
    expect(r.approved).toBe(true);                                                           // approval is recorded; the hold is separate
    expect(item(r, "background").state).toBe("unmet");
    expect(item(r, "cpr").detail).toBe("Document type not set up");
  });

  it("the report-only agency is unchanged: nothing blocked before activation, nothing new after", async () => {
    const rec = await approvedCaregiver("Report");
    const ev = await call(w.managerA, "select ogevia_api.evaluate_assignment_readiness($1,$2,null,now() + interval '3 days',now() + interval '3 days 1 hour','shift',null,null) as r", [w.orgA, rec]).then((r) => r[0].r);
    expect(ev.checks.find((c: any) => c.check === "cpr")).toMatchObject({ status: "pending", enforced: false });
  });
});

const psql = (args: string[]) => spawnSync("psql", ["-X", "-At", "-F", "|", ...args, `postgres://postgres@127.0.0.1:5432/${db.name}`], { encoding: "utf8" });
describe("deployment checks", () => {
  it("CHECK_SCHEDULING_0122 runs read-only and tells the three cases apart for a real caregiver code", async () => {
    const rec = await approvedCaregiver("Probe");
    const code = (await q("select caregiver_code from ogevia.caregiver_records where id = $1", [rec]))[0].caregiver_code as string;
    await setTypesActive(false);
    const out = psql(["-v", `cg=${code}`, "-f", new URL("../../../../docs/releases/2026-11-20-test-plan/toolchain/CHECK_SCHEDULING_0122.sql", import.meta.url).pathname]);
    expect(out.stderr).toBe("");
    expect(out.stdout).toMatch(/caregiver\|.*\|t\|t\|t/);                                   // approval recorded, enforcement on, 0122 present
    expect(out.stdout).toMatch(/scheduling_check\|cpr\|pending\|type_not_set\|f\|Document type not set up/);
    expect(out.stdout).toMatch(/compliance_read\|t\|0\|/);
    expect(out.stdout).not.toMatch(/@/);
  });
  it("VERIFY_PENDING passes when present (only the ledger row is missing in a test database)", () => {
    const pres = psql(["-v", "mig=0122", "-v", "expect=present", "-f", new URL("../../../../docs/releases/2026-11-20-test-plan/toolchain/VERIFY_PENDING.sql", import.meta.url).pathname]);
    expect(pres.stderr).toBe("");
    expect(pres.stdout.split("\n").filter((l) => l.includes("|f|"))).toEqual(["ledger row 0122 present|f|"]);
  });
});

describe("rollback", () => {
  it("restores the 0088 rule: an approved caregiver with the type unset is blocked again, and the helper is gone", async () => {
    await setTypesActive(false);
    await run(P("rollback/0122_unset_cpr_tb_type_not_a_block.down.sql"));
    expect(psql(["-v", "mig=0122", "-v", "expect=absent", "-f", new URL("../../../../docs/releases/2026-11-20-test-plan/toolchain/VERIFY_PENDING.sql", import.meta.url).pathname]).stdout.split("\n").filter((l) => l.includes("|f|"))).toEqual([]);
    expect((await q("select to_regprocedure('ogevia.caregiver_has_work_approval(uuid,uuid)') is null as gone"))[0].gone).toBe(true);
    const rec = await approvedCaregiver("Back");
    await expectPgError(schedule(rec), "OGR30");
    await run(P("migrations/0122_unset_cpr_tb_type_not_a_block.sql"));                      // re-applying is safe
    expect(await schedule(rec)).toHaveLength(1);
  });
});
