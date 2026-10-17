// 0066: CPR/TB that is expired, or expires during a shift, is visible in the compliance and affected-shift views, including a shift already under way, and
// nothing ends a visit in progress. These are OWNER-DEFINED rules, not verified legal requirements. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, asReplica, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let rec: string;
let other: string;
let cpr: string;
let tb: string;
let fx: { client: string; service: string; auth: string };
const sha = "e".repeat(64);
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const add = async (n: number) => (await db.admin.query<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') d", [today, n])).rows[0]!.d;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const holds = () => call(w.managerA, "select ogevia_api.list_compliance_holds($1) as h", [w.orgA]).then((r) => r[0].h);
const attention = () => call(w.managerA, "select ogevia_api.get_compliance_attention($1) as a", [w.orgA]).then((r) => r[0].a);
const shift = (day: string, start: string, end: string, caregiver: string) =>
  call(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,$7,null)", [w.orgA, fx.client, fx.service, day, start, end, caregiver]).then((r) => r[0].shift_id as string);

async function deliver(caregiver: string, type: string, expires: string | null) {
  const doc = (await call(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, caregiver, type]))[0].id as string;
  const version = randomUUID();
  const row = (await call(w.managerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [
    doc, version, `${w.orgA}/documents/${doc}/${version}`, sha, await add(-5), expires]))[0];
  await call(w.ownerA, "select ogevia_api.review_document_version($1,'verified',null,null)", [row.document_version_id]);
}
async function sweep() {
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_app");
    const orgs = (await c.query("select ogevia_api.system_compliance_orgs() as id")).rows.map((r) => r.id as string);
    for (const o of orgs) await c.query("select ogevia_api.system_compliance_sweep_org($1)", [o]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  rec = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA1.userId])).rows[0].id;
  other = (await q("select id from ogevia.caregiver_records where linked_user_id = $1", [w.caregiverA2.userId])).rows[0].id;
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
  cpr = (await call(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  tb = (await call(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await call(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await call(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  for (const r of [rec, other]) {
    await q("delete from ogevia.caregiver_background_checks where caregiver_record_id = $1", [r]);
    await q("insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at) values ($1,$2,'completed','approved','Synthetic fixture clearance',$3,now())", [r, w.orgA, w.ownerA.userId]);
    for (let d = 0; d < 7; d++) await q("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, r, d]);
    await q("update ogevia.caregiver_records set hire_date = $2::date - 400 where id = $1", [r, today]);
  }
  await deliver(rec, cpr, await add(10)); // valid through today + 10
  await deliver(rec, tb, null);
  await deliver(other, cpr, await add(400));
  await deliver(other, tb, null);
});
afterAll(async () => db?.drop());

describe("CPR expiring in the future is visible per shift before any hold exists", () => {
  let before: string, across: string, after: string, otherShift: string;
  it("a shift before the expiry is clean; an overnight shift across the expiry midnight expires DURING the shift; a shift after the expiry is expired; another caregiver is unaffected", async () => {
    before = await shift(await add(5), "09:00", "11:00", rec);
    across = await shift(await add(10), "22:00", "06:00", rec); // 22:00 on the last valid day to 06:00 the next day
    after = await shift(await add(12), "09:00", "11:00", rec);
    otherShift = await shift(await add(10), "22:00", "06:00", other);
    const list = await holds();
    expect(list.holds).toEqual([]); // nobody is on hold: this is the view BEFORE the expiry
    const risks = list.shiftsAtRisk as any[];
    expect(risks.map((r) => [r.shiftId, r.requirement, r.documentStatus, r.validUntil.slice(0, 10), r.inProgress, r.onHold])).toEqual([
      [across, "cpr", "expires_during", await add(10), false, false],
      [after, "cpr", "expired", await add(10), false, false],
    ]);
    expect(risks[0]).toMatchObject({ caregiverRecordId: rec, clientCode: expect.any(String), visitId: null });
    expect(risks.map((r) => r.shiftId)).not.toContain(before);
    expect(risks.map((r) => r.shiftId)).not.toContain(otherShift);
    expect(list.totals).toMatchObject({ shiftsAtRisk: 2, shiftsAtRiskInProgress: 0 });
    expect((await attention()).shiftsAtRisk).toBe(2);
    const snap = (await call(w.managerA, "select ogevia_api.get_caregiver_compliance($1,$2) as c", [w.orgA, rec]))[0].c;
    expect(snap.shiftRisks.map((r: any) => r.shiftId)).toEqual([across, after]);
    expect((await call(w.managerA, "select ogevia_api.get_caregiver_compliance($1,$2) as c", [w.orgA, other]))[0].c.shiftRisks).toEqual([]);
  });
  it("a cancelled or called-out shift drops out; a viewer without compliance access and another agency see nothing", async () => {
    await call(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic: client unwell')", [w.orgA, after]);
    expect(((await holds()).shiftsAtRisk as any[]).map((r) => r.shiftId)).toEqual([across]);
    expect((await call(w.managerB, "select ogevia_api.get_compliance_attention($1) as a", [w.orgA]))[0].a).toBeNull();
    await expect(call(w.managerB, "select ogevia_api.list_compliance_holds($1) as h", [w.orgA])).rejects.toThrow();
  });
  it("replacing the document with a current one clears the risk", async () => {
    await q("update ogevia.staff_documents set closed_at = now() where caregiver_record_id = $1 and document_type_id = $2 and closed_at is null", [rec, cpr]);
    await deliver(rec, cpr, await add(300));
    expect((await holds()).shiftsAtRisk).toEqual([]);
    await q("update ogevia.staff_documents set closed_at = now() where caregiver_record_id = $1 and document_type_id = $2 and closed_at is null", [rec, cpr]);
    await deliver(rec, cpr, await add(10)); // restore for the next block
  });
});

describe("a shift already under way when the CPR expires: visible as in progress, the visit is never ended", () => {
  it("the open visit is listed on the at-risk shift and on the hold's affected shift; the sweep opens the hold; the visit stays open and the caregiver can end it", async () => {
    for (const r of (await q("select id from ogevia.shifts where status = 'scheduled'")).rows) await call(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic: fixture reset')", [w.orgA, r.id]); // earlier block's shifts
    const f2 = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 5, after: 120 });
    fx = f2;
    const s = await shift(today, "23:00", "23:30", rec);
    await asReplica(db, "update ogevia.shifts set starts_at = now() - interval '30 minutes', ends_at = now() + interval '3 hours' where id = $1", [s]);
    const visit = await api.start(db, w.caregiverA1, w.orgA, f2.client, f2.service, s, "Synthetic: scheduled visit");
    // the document expires while the visit is open: its last valid day was yesterday
    await q("update ogevia.document_versions set expires_on = $2::date - 1 where document_id in (select id from ogevia.staff_documents where caregiver_record_id = $1 and document_type_id = $3)", [rec, today, cpr]).catch(async () => {
      await asReplica(db, "update ogevia.document_versions set expires_on = $2::date - 1 where document_id in (select id from ogevia.staff_documents where caregiver_record_id = $1 and document_type_id = $3 and closed_at is null)", [rec, today, cpr]);
    });
    const live = await holds();
    expect((live.shiftsAtRisk as any[]).find((r) => r.shiftId === s)).toMatchObject({ requirement: "cpr", documentStatus: "expired", inProgress: true, visitId: visit });
    expect(live.totals).toMatchObject({ shiftsAtRiskInProgress: 1 });
    // enforcement on; the scheduled run opens the hold and flags the shift
    const status = (await call(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    await call(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, status.affectedShiftsCount]);
    await sweep();
    const after = await holds();
    const mine = after.holds.find((h: any) => h.caregiverRecordId === rec);
    expect(mine.affectedShifts.find((x: any) => x.shiftId === s)).toMatchObject({ inProgress: true, visitId: visit });
    expect(mine.inProgressVisits.map((x: any) => x.visitId)).toEqual([visit]);
    expect((after.shiftsAtRisk as any[]).find((r) => r.shiftId === s)).toMatchObject({ onHold: true, inProgress: true });
    expect(await q("select status::text s, time_out from ogevia.service_visits where id = $1", [visit]).then((r) => r.rows[0])).toMatchObject({ s: "draft", time_out: null });
    await ageVisit(db, visit, 20);
    await api.end(db, w.caregiverA1, visit); // never blocked
    expect((await q("select time_out is not null ended from ogevia.service_visits where id = $1", [visit])).rows[0].ended).toBe(true);
  });
});
