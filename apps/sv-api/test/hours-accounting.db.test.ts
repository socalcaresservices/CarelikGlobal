// 0079 through the real Lambda handler (SYNTHETIC data only): the new hours-accounting fields reach the API next to the old ones, and the caregiver's
// Start Visit balance is computed on the server from the same records as the office figure.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, createTestDb, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { chainCsv } from "../src/exports";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

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

describe("hours accounting through the API", () => {
  it("a visit awaiting confirmation: Pending 130 (the held shift), Hours left 470 for the office, Left to record 600 for the caregiver, with the difference named", async () => {
    const cg = w.caregiverA2;
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

    const started = await call("POST /v1/visits", cg, { body: { organizationId: w.orgA, clientId: f.client, serviceId: f.service } });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const visitId = started.body.visitId as string;
    await ageVisit(db, visitId, 60);
    expect((await call("POST /v1/visits/{visitId}/end", cg, { path: { visitId } })).status).toBe(200);

    // Office: the monthly summary carries the new fields beside the old ones.
    const row = (await call("GET /v1/reports/monthly-service-summary", w.managerA, { query: { organizationId: w.orgA, monthStart, clientId: f.client } })).body.services[0];
    expect(row).toMatchObject({ authorizedMinutes: 600, hoursBillableMinutes: 0, hoursRoundingMinutes: 0, hoursPendingMinutes: 130, hoursPendingHeldMinutes: 130,
      hoursReservedMinutes: 0, hoursLeftMinutes: 470, hoursOverLimitMinutes: 0, hoursWorkedNotBillableMinutes: 0, remainingMinutes: 470, reservedMinutes: 130 });
    expect(row.hoursBillableMinutes + row.hoursRoundingMinutes + row.hoursPendingMinutes + row.hoursReservedMinutes + row.hoursLeftMinutes).toBe(row.authorizedMinutes);

    // Home (utilisation) and the chain report carry the same buckets.
    const home = (await call("GET /v1/reports/utilisation", w.managerA, { query: { organizationId: w.orgA, monthStart } })).body.services.find((s: any) => s.serviceId === f.service);
    expect(home.hoursPendingMinutes).toBeGreaterThanOrEqual(130);
    expect(home).toHaveProperty("hoursLeftMinutes");
    expect(home).toHaveProperty("hoursOverLimitMinutes");
    const chain = (await call("GET /v1/reports/monthly-chain", w.managerA, { query: { organizationId: w.orgA, monthStart, clientId: f.client } })).body.rows[0];
    expect(chain).toMatchObject({ hoursPendingMinutes: 130, hoursLeftMinutes: 470, hoursBalanceOk: true });
    expect(chainCsv([chain]).split("\r\n")[0]).toContain("Hours left (min, signed)");

    // Caregiver Start Visit: computed on the server; the office figure is lower by exactly the Pending time the caregiver's figure does not deduct.
    const services = (await call("GET /v1/clients/{clientId}/services", cg, { path: { clientId: f.client }, query: { organizationId: w.orgA } })).body.services;
    const svc = services.find((x: any) => x.serviceId === f.service);
    expect(Number(svc.leftToRecordMinutes)).toBe(600);
    expect(Number(svc.hoursLeftMinutes)).toBe(470);
    expect(Number(svc.officePendingMinutes)).toBe(130);
    expect(Number(svc.officeReservedMinutes)).toBe(0);
    expect(Number(svc.leftToRecordMinutes) - Number(svc.officePendingMinutes) - Number(svc.officeReservedMinutes)).toBe(Number(svc.hoursLeftMinutes));
    const active = (await call("GET /v1/visits/active", cg, { query: { organizationId: w.orgA } })).body.visit;
    expect(Number(active.leftToRecordMinutes)).toBe(600);
  });
});
