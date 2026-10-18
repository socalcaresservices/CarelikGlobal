// 0081 owner corrections through the real Lambda handler (SYNTHETIC data only):
//   1. unreserved Pending time counts when scheduling more work (409 conflict, nothing saved);
//   2. a review closed as not billable leaves Pending and shows its own fields;
//   3. a pending (unverified) CPR/TB document blocks an assignment and a new visit start once the agency enforces (422 not_ready).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let today: string;
let tomorrow: string;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  tomorrow = (await db.admin.query<{ d: string }>("select to_char($1::date + 1, 'YYYY-MM-DD') d", [today])).rows[0]!.d;
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
const monthStart = () => `${today.slice(0, 7)}-01`;
const summary = async (client: string) => (await call("GET /v1/reports/monthly-service-summary", w.managerA, { query: { organizationId: w.orgA, monthStart: monthStart(), clientId: client } })).body.services[0];
const shift = (client: string, service: string, minutes: number, caregiver: string | null = null, start = 9 * 60) => {
  const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return call("POST /v1/shifts", w.managerA, { body: { organizationId: w.orgA, clientId: client, serviceId: service, date: tomorrow, startTime: f(start), endTime: f(start + minutes), ...(caregiver ? { caregiverRecordId: caregiver } : {}) } });
};

describe("pending hours and closed reviews over HTTP", () => {
  it("an unscheduled visit awaiting confirmation (45 worked) leaves 555: a 560-minute shift is refused with 409 and not saved, 555 is created; closing the review as not billable moves the 45 out of Pending and frees them", async (ctx) => {
    if (tomorrow.slice(0, 7) !== today.slice(0, 7)) return ctx.skip();
    const cg = w.caregiverA2;
    const f = await freshClient(db, w, cg, 600);
    const started = await call("POST /v1/visits", cg, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, unscheduledReason: "Client asked for extra help (synthetic)" } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const visitId = started.body.visitId as string;
    await ageVisit(db, visitId, 45);
    expect((await call("POST /v1/visits/{visitId}/end", cg, { path: { visitId } })).status).toBe(200);
    expect(await summary(f.client)).toMatchObject({ hoursPendingMinutes: 45, hoursPendingUnreservedMinutes: 45, hoursLeftMinutes: 555 });

    const refused = await shift(f.client, f.service, 560);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("conflict");
    expect((await db.admin.query("select count(*)::int n from ogevia.shifts where client_id = $1", [f.client])).rows[0].n).toBe(0);
    const made = await shift(f.client, f.service, 555);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(await summary(f.client)).toMatchObject({ hoursPendingMinutes: 45, hoursReservedMinutes: 555, hoursLeftMinutes: 0, hoursOverLimitMinutes: 0 });

    // The office closes the review as not billable: the 45 leave Pending, stay visible as worked time, and no longer consume authorization.
    await api.confirm(db, cg, visitId, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
    expect((await summary(f.client)).hoursPendingMinutes).toBe(45); // in review, nothing billable: still Pending
    const closed = await call("POST /v1/visits/{visitId}/review-decision", w.managerA, { path: { visitId }, body: { decision: "close_not_billable", reason: "Not a valid visit (synthetic)" } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    const after = await summary(f.client);
    expect(after).toMatchObject({ hoursPendingMinutes: 0, hoursClosedNotBillableWorkedMinutes: 45, hoursClosedNotBillableHeldMinutes: 0, hoursWorkedNotBillableMinutes: 45, hoursReservedMinutes: 555, hoursLeftMinutes: 45 });
    expect(after.hoursBillableMinutes + after.hoursRoundingMinutes + after.hoursPendingMinutes + after.hoursReservedMinutes + after.hoursLeftMinutes).toBe(after.authorizedMinutes);
  });
});

describe("pending CPR/TB over HTTP", () => {
  it("with enforcement active a caregiver whose CPR/TB are uploaded but not verified cannot be assigned (422 not_ready 'CPR needs review.') and cannot start a visit", async () => {
    const cg = w.caregiverA3;
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1", [cg.userId])).rows[0].id as string;
    const as = async (a: Actor, sql: string, params: unknown[]) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_app"); await c.query("select ogevia_api.begin_request($1,$2)", [a.sub, randomUUID()]); const r = await c.query(sql, params); await c.query("commit"); return r.rows as any[]; } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
    const cpr = (await as(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
    const tb = (await as(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
    await as(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
    await as(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
    await as(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
    await as(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
    for (const [type, expires] of [[cpr, "2099-01-01"], [tb, null]] as const) { // uploaded, never verified
      const doc = (await as(w.managerA, "select ogevia_api.request_staff_document($1,$2,$3,null,null) as id", [w.orgA, rec, type]))[0].id;
      const version = randomUUID();
      await as(w.managerA, "select * from ogevia_api.register_document_version($1,$2,$3,'v1','application/pdf',1234,$4,$5::date,$6::date,null)", [doc, version, `${w.orgA}/documents/${doc}/${version}`, "f".repeat(64), today, expires]);
    }
    await db.admin.query("update ogevia.caregiver_records set hire_date = $2::date - 3 where id = $1", [rec, today]); // a new hire inside the 14 days
    for (const d of [0, 1, 2, 3, 4, 5, 6]) await db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,$3,'00:00','23:59')", [w.orgA, rec, d]);
    const f = await freshClient(db, w, cg, 100000, w.orgA, { before: 5, after: 120 });
    const st = (await as(w.ownerA, "select ogevia_api.get_readiness_status($1) as s", [w.orgA]))[0].s;
    await as(w.ownerA, "select ogevia_api.activate_readiness_enforcement($1,'Reviewed the report and the affected work',$2)", [w.orgA, st.affectedShiftsCount]);

    const ev = await call("POST /v1/readiness/evaluate", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId: rec, serviceId: f.service, clientId: f.client, date: tomorrow, startTime: "09:00", endTime: "11:00" } });
    expect(ev.body.evaluation).toMatchObject({ outcome: "blocked", ready: false });
    expect(ev.body.evaluation.summary).toMatch(/CPR needs review\./);
    const made = await shift(f.client, f.service, 120, rec);
    expect(made.status, JSON.stringify(made.body)).toBe(422);
    expect(made.body.error).toMatchObject({ code: "not_ready" });
    expect(made.body.error.message).toMatch(/CPR needs review\./);
    const started = await call("POST /v1/visits", cg, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service, unscheduledReason: "Client asked for extra help (synthetic)" } });
    expect(started.status, JSON.stringify(started.body)).toBe(422);
    expect(started.body.error).toMatchObject({ code: "not_ready" });
  });
});
