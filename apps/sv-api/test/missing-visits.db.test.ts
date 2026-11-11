import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createHandler } from "../src/handler";
import { MemoryEvidenceStore } from "../src/evidence";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb, w: World, handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb(); w = await seedWorld(db, 600);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());
async function call(route: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(route, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) };
}
async function fixture(reserved = true) {
  const f = await freshClient(db, w, w.caregiverA1, 600);
  const caregiver = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1 and organization_id=$2", [w.caregiverA1.userId, w.orgA])).rows[0].id;
  const s = (await db.admin.query(`insert into ogevia.shifts(organization_id,client_id,service_id,caregiver_user_id,caregiver_record_id,starts_at,ends_at)
    values($1,$2,$3,$4,$5,now()-interval '3 hours',now()-interval '1 hour') returning id,starts_at,ends_at`, [w.orgA,f.client,f.service,w.caregiverA1.userId,caregiver])).rows[0];
  const a = (await db.admin.query("select id,lineage_id,ogevia.organization_local_date($2, $3) as d from ogevia.client_authorizations where client_id=$1", [f.client,w.orgA,s.starts_at])).rows[0];
  if (reserved) await db.admin.query(`insert into ogevia.authorization_reservations(organization_id,authorization_lineage_id,shift_id,service_date,reserved_minutes) values($1,$2,$3,$4,120)`, [w.orgA,a.lineage_id,s.id,a.d]);
  return { ...f, shift: s.id, timeIn: s.starts_at.toISOString(), timeOut: s.ends_at.toISOString(), date: String(a.d instanceof Date ? a.d.toISOString().slice(0,10) : a.d) };
}
const report = (f: Awaited<ReturnType<typeof fixture>>, actor = w.managerA) => call("GET /v1/reports/missing-visits",actor,{ query:{organizationId:w.orgA,from:f.date,to:f.date,clientId:f.client} });
const record = (f: Awaited<ReturnType<typeof fixture>>, actor = w.managerA, reason = "Caregiver and family verified the actual times.", key = randomUUID()) => call("POST /v1/shifts/{shiftId}/missing-visit",actor,{ path:{shiftId:f.shift},key,body:{organizationId:w.orgA,timeIn:f.timeIn,timeOut:f.timeOut,reason} });

describe("missing scheduled visits through the real API and database", () => {
  it("reports ended shifts even without a reservation; honors permissions and filters", async () => {
    const f = await fixture(false);
    expect((await report(f)).body.missingVisits.map((r: {shiftId:string})=>r.shiftId)).toContain(f.shift);
    expect((await call("GET /v1/reports/missing-visits",w.managerA,{query:{organizationId:w.orgA}})).body.missingVisits.map((r:{shiftId:string})=>r.shiftId)).toContain(f.shift);
    expect((await report(f,w.caregiverA1)).status).toBe(403);
    expect((await report(f,w.managerB)).status).toBe(404);
    expect((await call("GET /v1/reports/missing-visits",w.managerA,{query:{organizationId:w.orgA,from:f.date,to:f.date,clientId:randomUUID()}})).body.missingVisits).toEqual([]);
  });
  it("requires a reason and manager access; a saved record moves Reserved to Pending once and preserves actor, reason and before/after history", async () => {
    const f = await fixture();
    f.timeOut=new Date(Date.parse(f.timeOut)-30*60000).toISOString();
    expect((await record(f,w.managerA," ")).status).toBe(400);
    expect((await record(f,w.caregiverA1)).status).toBe(403);
    expect((await record(f,w.managerB)).status).toBe(404);
    const key=randomUUID();
    const saved=await record(f,w.managerA,undefined,key);
    expect(saved.status,JSON.stringify(saved.body)).toBe(201);
    expect((await record(f,w.managerA,undefined,key)).body.visitId).toBe(saved.body.visitId);
    expect((await record(f)).status).toBe(409);
    expect((await report(f)).body.missingVisits).toEqual([]);
    const v=(await db.admin.query("select * from ogevia.service_visits where id=$1",[saved.body.visitId])).rows[0];
    expect(v).toMatchObject({status:"awaiting_signature",worked_minutes:90,billable_minutes:null,created_by:w.managerA.userId,caregiver_attested_at:null});
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_confirmations where visit_id=$1",[v.id])).rows[0].n).toBe(0);
    const audit=(await db.admin.query("select * from ogevia.audit_events where entity_id=$1 and action='service_visit.missing_punches_recorded'",[v.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({actor_user_id:w.managerA.userId,reason:"Caregiver and family verified the actual times.",before_state:{time_in:null,time_out:null},after_state:{worked_minutes:90,client_confirmed:false}});
    const history=await call("GET /v1/visits/{visitId}/corrections",w.managerA,{path:{visitId:v.id}});
    expect(history.body.corrections).toHaveLength(1);
    expect(history.body.corrections[0]).toMatchObject({reason:audit[0].reason,beforeSnapshot:{timeIn:null},afterSnapshot:{workedMinutes:90}});
    const sum=await call("GET /v1/reports/monthly-service-summary",w.managerA,{query:{organizationId:w.orgA,monthStart:f.date.slice(0,7)+"-01",clientId:f.client}});
    expect(sum.body.services[0]).toMatchObject({hoursPendingMinutes:90,hoursReservedMinutes:0,hoursBillableMinutes:0,hoursLeftMinutes:510});
    // Retain historical visit; synthetic cleanup marks it voided through the existing API.
    await db.admin.query("update ogevia.service_visits set status='voided',voided_at=now(),voided_by=$2,void_reason='Synthetic test cleanup' where id=$1",[v.id,w.managerA.userId]);
  });
  it("rejects future and reversed punches without creating work", async () => {
    const f=await fixture(false);
    for (const timeOut of [f.timeIn,new Date(Date.now()+3600000).toISOString()]) {
      const r=await call("POST /v1/shifts/{shiftId}/missing-visit",w.managerA,{path:{shiftId:f.shift},body:{organizationId:w.orgA,timeIn:f.timeIn,timeOut,reason:"Verified with the family and caregiver."}});
      expect(r.status).toBe(422);
    }
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where scheduled_shift_id=$1",[f.shift])).rows[0].n).toBe(0);
  });
  it("excludes cancelled shifts and serializes two managers recording the same shift",async()=>{
    const cancelled=await fixture(false);
    await db.admin.query("update ogevia.shifts set status='cancelled' where id=$1",[cancelled.shift]);
    expect((await report(cancelled)).body.missingVisits).toEqual([]);
    expect((await record(cancelled)).status).toBe(409);
    const f=await fixture();
    const results=await Promise.all([record(f),record(f)]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where scheduled_shift_id=$1",[f.shift])).rows[0].n).toBe(1);
  });
});
