// End to end through the real Lambda handler: a scheduled visit that goes to review (its length differs from its shift by
// more than the agency rule) is counted once in the monthly summary the office reads: used 60, not also reserved 130
// (migration 0052, D2). SYNTHETIC data only.
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
});
