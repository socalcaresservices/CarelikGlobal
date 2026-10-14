// End to end through the real Lambda handler, as the office reads it (SYNTHETIC data only):
//  - a scheduled visit that goes to review (its length differs from its shift by more than the agency rule) is counted once
//    in the monthly summary: used 60, not also reserved 130 (migration 0052, D2);
//  - the clean case: a correctly scheduled visit, signed by the client, is Billing Ready with no review reason, its
//    reservation becomes used time exactly once, and the authorization left does not change.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event, syntheticPng } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("authorization accounting through the API", () => {
  it("a visit in review with billable minutes is counted once in the monthly summary, before and after a review decision", async () => {
    const cg = w.caregiverA1;
    const f = await freshClient(db, w, cg, 600);
    const record = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [cg.userId, w.orgA])).rows[0].id as string;
    const shift = (await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
       select $1,$2,$3,$4,$5, now() - interval '1 minute', now() + interval '129 minutes', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
      [w.orgA, f.client, f.service, cg.userId, record, f.auth])).rows[0].id as string;
    await db.admin.query(
      `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, shift_id, service_date, reserved_minutes)
       select $1, a.lineage_id, $2, $3::date, 130 from ogevia.client_authorizations a where a.id = $4`, [w.orgA, shift, await orgToday(db), f.auth]);
    const monthStart = `${(await orgToday(db)).slice(0, 7)}-01`;
    const summary = async () => (await call("GET /v1/reports/monthly-service-summary", w.managerA, { query: { organizationId: w.orgA, monthStart, clientId: f.client } })).body.services[0];

    // Before the visit: the shift is reserved.
    expect(await summary()).toMatchObject({ authorizedMinutes: 600, billableMinutes: 0, reservedMinutes: 130, remainingMinutes: 470 });

    const started = await call("POST /v1/visits", cg, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const visitId = started.body.visitId as string;
    await ageVisit(db, visitId, 60);
    expect((await call("POST /v1/visits/{visitId}/end", cg, { path: { visitId } })).status).toBe(200);
    const confirmed = await call("POST /v1/visits/{visitId}/confirm", cg, {
      path: { visitId }, key: randomUUID(),
      body: { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng(60, 30, 7).toString("base64"), attested: true },
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.result).toMatchObject({ status: "administrator_review", billableMinutes: 60 });
    expect(confirmed.body.result.outcome.reviewReasons).toEqual(["schedule_variance"]);

    // In review: 60 used, nothing also reserved.
    expect(await summary()).toMatchObject({ billableMinutes: 60, reservedMinutes: 0, remainingMinutes: 540 });

    // A manager's decision records a review; it moves no minutes.
    const decided = await call("POST /v1/visits/{visitId}/review-decision", w.managerA, {
      path: { visitId }, key: randomUUID(), body: { organizationId: w.orgA, decision: "accept_capped_billable", reason: "Valid visit (synthetic)" },
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(201);
    expect(await summary()).toMatchObject({ billableMinutes: 60, reservedMinutes: 0, remainingMinutes: 540 });
  });

  it("clean scheduled visit: signed, Billing Ready, no review reason, reserved becomes used once, authorization left unchanged", async () => {
    const cg = w.caregiverA1;
    const f = await freshClient(db, w, cg, 600);
    const record = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [cg.userId, w.orgA])).rows[0].id as string;
    // 90 minutes is deliberately not the 120-minute helper length, so the harness leaves the shift as scheduled.
    const shift = (await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at, status, authorization_lineage_id)
       select $1,$2,$3,$4,$5, now() - interval '1 minute', now() + interval '89 minutes', 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
      [w.orgA, f.client, f.service, cg.userId, record, f.auth])).rows[0].id as string;
    await db.admin.query(
      `insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, shift_id, service_date, reserved_minutes)
       select $1, a.lineage_id, $2, $3::date, 90 from ogevia.client_authorizations a where a.id = $4`, [w.orgA, shift, await orgToday(db), f.auth]);
    const monthStart = `${(await orgToday(db)).slice(0, 7)}-01`;
    const summary = async () => (await call("GET /v1/reports/monthly-service-summary", w.managerA, { query: { organizationId: w.orgA, monthStart, clientId: f.client } })).body.services[0];

    // The caregiver sees only this assigned client and its authorized service.
    const assigned = await call("GET /v1/clients/assigned", cg, { query: { organizationId: w.orgA } });
    expect(assigned.body.clients.map((c: any) => c.clientId)).toContain(f.client);
    const services = await call("GET /v1/clients/{clientId}/services", cg, { path: { clientId: f.client }, query: { organizationId: w.orgA } });
    expect(services.body.services.map((x: any) => x.serviceId)).toContain(f.service);

    // Before: the shift is reserved, nothing used. 600 authorized, 510 left.
    expect(await summary()).toMatchObject({ authorizedMinutes: 600, billableMinutes: 0, reservedMinutes: 90, remainingMinutes: 510 });

    const started = await call("POST /v1/visits", cg, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const visitId = started.body.visitId as string;
    const linked = (await db.admin.query("select scheduled_shift_id from ogevia.service_visits where id = $1", [visitId])).rows[0];
    expect(linked.scheduled_shift_id).toBe(shift);

    await ageVisit(db, visitId, 90);
    const ended = await call("POST /v1/visits/{visitId}/end", cg, { path: { visitId } });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.visit.workedMinutes).toBeGreaterThanOrEqual(90);

    const key = randomUUID();
    const body = { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng(60, 30, 11).toString("base64"), attested: true };
    const confirmed = await call("POST /v1/visits/{visitId}/confirm", cg, { path: { visitId }, key, body });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.result).toMatchObject({ status: "signed", billableMinutes: confirmed.body.result.workedMinutes });
    expect(confirmed.body.result.outcome).toMatchObject({ reviewReasons: [], attestationVersion: "attest-v1", unscheduledReason: null });
    expect(confirmed.body.result.billableMinutes).toBeGreaterThanOrEqual(90);

    // After: the reservation is released and the same minutes are used once. Authorization left is unchanged.
    const worked = confirmed.body.result.billableMinutes as number;
    expect(await summary()).toMatchObject({ authorizedMinutes: 600, billableMinutes: worked, reservedMinutes: 0, remainingMinutes: 600 - worked });

    // The office sees it as ready: no administrator review needed.
    const review = await call("GET /v1/billing-review", w.managerA, { query: { organizationId: w.orgA, dateFrom: "2000-01-01", dateTo: "2100-01-01" } });
    const row = review.body.visits.find((v: any) => (v.visitId ?? v.id) === visitId);
    expect(row, JSON.stringify(Object.keys(review.body.visits[0] ?? {}))).toBeTruthy();
    expect(row.reviewState).toBe("ready");

    // A retry of the same confirmation changes nothing (same result, same balance).
    const again = await call("POST /v1/visits/{visitId}/confirm", cg, { path: { visitId }, key, body });
    expect(again.status).toBe(200);
    expect(again.body.result).toEqual(confirmed.body.result);
    expect(await summary()).toMatchObject({ billableMinutes: worked, reservedMinutes: 0, remainingMinutes: 600 - worked });
  });
});
