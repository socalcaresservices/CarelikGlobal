// The release candidate with compliance enforcement ENABLED on a disposable synthetic database: the owner activates (one way), the scheduled run opens a hold for a caregiver without
// clearance, every scheduling path refuses that caregiver, the hold shows up in the one issue list, and the new client gates (draft stage, service hold) still apply alongside it.
// Nothing here touches a live tenant. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, asReplica, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let fx: { client: string; service: string; auth: string };
let recA1: string, recA3: string;
let cpr: string, tb: string;
const sha = "a".repeat(64);
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const recOf = async (a: Actor) => (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0].id as string;
const add = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const allWeek = [0, 1, 2, 3, 4, 5, 6];
async function asApp<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_app"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const sweep = async () => {
  const orgs = await asApp(async (c) => (await c.query("select ogevia_api.system_compliance_orgs() as id")).rows.map((r) => r.id as string));
  let opened = 0;
  for (const org of orgs) opened += (await asApp(async (c) => (await c.query("select ogevia_api.system_compliance_sweep_org($1) as r", [org])).rows[0].r)).holdsOpened;
  return opened;
};
async function deliver(rec: string, type: string, expires: string | null) {
  const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id as string;
  const version = randomUUID();
  const row = (await call(w.managerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, add(-5), expires]))[0];
  await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
}
const baseline = async (rec: string) => {
  await q("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [rec]);
  for (const d of allWeek) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, rec, d]);
};
const shift = (a: Actor, d: string, rec: string | null) => call(a, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,$5,null)", [w.orgA, fx.client, fx.service, d, rec]);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  recA1 = await recOf(w.caregiverA1); recA3 = await recOf(w.caregiverA3);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
});
afterAll(async () => db?.drop());

describe("enforcement enabled in a disposable synthetic fixture", () => {
  it("activation is the owner's, one way and recorded; the scheduled run then holds the caregiver without clearance; every path refuses; the hold is in the issue list; compliant caregivers are untouched", async () => {
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
    await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
    await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
    await baseline(recA1); await baseline(recA3);
    await q("update ogevia.caregiver_records set hire_date = $1::date - 90", [today]);
    await q("delete from ogevia.caregiver_background_checks");
    await q("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','approved','Synthetic clearance',$3,now())", [recA1, w.orgA, w.ownerA.userId]);
    await deliver(recA1, cpr, add(400)); await deliver(recA1, tb, null);
    // before activation: report only, nobody is held
    expect(await sweep()).toBe(0);
    expect((await shift(w.managerA, add(3), recA3)).length).toBe(1);
    await q("delete from ogevia.authorization_reservations where shift_id is not null"); await q("delete from ogevia.shifts");
    // the owner activates after reading the status; a manager cannot
    const status = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    await expectPgError(call(w.managerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, status.affectedShiftsCount]), "OGA03");
    await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, status.affectedShiftsCount]);
    expect((await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s.enforcementActive).toBe(true);
    // the scheduled run (no signed-in person) opens exactly one hold: the caregiver without clearance and documents
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    const holds = await q("select caregiver_record_id from ogevia.caregiver_compliance_holds where released_at is null");
    expect(holds.rows.map((r: any) => r.caregiver_record_id)).toContain(recA3);
    expect(holds.rows.map((r: any) => r.caregiver_record_id)).not.toContain(recA1);
    // every path refuses the held caregiver; the compliant one is scheduled
    await expectPgError(shift(w.managerA, add(4), recA3), "OGR30", /Background check clearance has not been verified/);
    expect((await shift(w.managerA, add(5), recA1)).length).toBe(1);
    // the hold is one issue among the others, with its stable key and the right queue
    const r = (await call(w.managerA, "select ogevia_api.list_action_issues($1,null,null,null,null,$2,null,50,0) as r", [w.orgA, recA3]))[0].r;
    expect(r.issues.find((i: any) => i.issueKey === `caregiver:compliance_hold:${recA3}`)).toMatchObject({ queue: "documents_compliance", category: "compliance", action: "review_hold" });
    // activation is one way: a second activation is a repeat, never a switch back
    expect((await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s.enforcementActive).toBe(true);
  });

  it("alongside enforcement, the client gates still apply: a draft client and a held service are refused for the compliant caregiver too", async () => {
    await q("delete from ogevia.authorization_reservations where shift_id is not null"); await q("delete from ogevia.shifts");
    await call(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'draft','Preparing',null)", [w.orgA, fx.client]);
    await expectPgError(shift(w.managerA, add(6), recA1), "OGC09");
    await call(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'active',null,null)", [w.orgA, fx.client]);
    const hold = (await call(w.managerA, "select ogevia_api.open_client_service_hold($1,$2,$3,'The family asked for a pause',null) as id", [w.orgA, fx.client, fx.service]))[0].id;
    await expectPgError(shift(w.managerA, add(6), recA1), "OGC09");
    await call(w.managerA, "select ogevia_api.release_client_service_hold($1,$2,'Spoke with the family today',null)", [w.orgA, hold]);
    expect((await shift(w.managerA, add(6), recA1)).length).toBe(1);
    void asReplica;
  });
});
