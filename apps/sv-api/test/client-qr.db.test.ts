import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ageVisit, createTestDb, freshClient, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createHandler } from "../src/handler";
import { MemoryEvidenceStore } from "../src/evidence";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event, syntheticPng } from "./fixtures";

let db: TestDb, world: World, handler: ReturnType<typeof createHandler>;
const logs: unknown[] = [];
beforeAll(async () => {
  vi.stubEnv("OGEVIA_QR_ENCRYPTION_KEY", "a".repeat(64));
  db = await createTestDb();
  world = await seedWorld(db, 600);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() },
    evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (record) => logs.push(record) });
});
afterAll(async () => { vi.unstubAllEnvs(); await db?.drop(); });

it("protects card management and enforces scheduled-only, explicit, retry-safe visit actions", async () => {
  const cg = world.caregiverA1;
  const { client, service, auth } = await freshClient(db, world, cg, 600);
  const org = world.orgA;
  const call = async (route: string, options: Parameters<typeof event>[1]) => {
    const result = await handler(event(route, options));
    return { status: result.statusCode, body: JSON.parse(result.body) };
  };
  const manage = (action: string, sub = world.ownerA.sub) => call("POST /v1/clients/{clientId}/qr-card", {
    sub, path: { clientId: client }, body: { organizationId: org, action },
  });
  const scan = (token: string, sub = cg.sub, body: Record<string, string> = {}, key?: string) =>
    call("POST /v1/checkin", { sub, body: { token, ...body }, ...(key ? { key } : {}) });
  expect((await manage("generate", world.managerB.sub)).status).toBe(404);
  expect(await manage("generate")).toEqual({ status: 200, body: { exists: true, active: true } });
  const { token } = (await manage("reprint")).body;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await manage("reprint")).body.token).toBe(token);
  expect((await call("POST /v1/checkin", { sub: null, body: { token } })).status).toBe(401);
  expect((await scan(token)).body).toEqual({ state: "empty" });
  expect((await scan(token, world.caregiverA2.sub)).body).toEqual({ state: "unavailable" });
  expect((await scan(token, world.managerB.sub)).body).toEqual({ state: "unavailable" });
  const record = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id=$1 and organization_id=$2", [cg.userId, org])).rows[0].id;
  const shiftId = (await db.admin.query(
    `insert into ogevia.shifts (organization_id,client_id,service_id,caregiver_user_id,caregiver_record_id,starts_at,ends_at,status,authorization_lineage_id)
     select $1,$2,$3,$4,$5,now()-interval '1 minute',now()+interval '2 hours','scheduled',lineage_id
     from ogevia.client_authorizations where id=$6 returning id`, [org, client, service, cg.userId, record, auth])).rows[0].id;
  expect((await scan(token)).body).toMatchObject({ state: "scheduled", shifts: [{ id: shiftId }] });
  await db.admin.query("update ogevia.shifts set status='cancelled' where id=$1", [shiftId]);
  expect((await scan(token, cg.sub, { shiftId }, randomUUID())).status).toBe(409);
  const fixture = await db.admin.connect();
  try {
    await fixture.query("begin");
    await fixture.query("set local session_replication_role=replica");
    await fixture.query("update ogevia.shifts set status='scheduled' where id=$1", [shiftId]);
    await fixture.query("commit");
  } finally { fixture.release(); }
  expect((await db.admin.query("select id from ogevia.service_visits where client_id=$1", [client])).rowCount).toBe(0);
  expect((await scan(token, world.caregiverA2.sub, { shiftId }, randomUUID())).body).toEqual({ state: "unavailable" });
  const key = randomUUID();
  const attempts = await Promise.all([scan(token, cg.sub, { shiftId }, key), scan(token, cg.sub, { shiftId }, key)]);
  expect(attempts[0]).toMatchObject({ status: 200, body: { state: "active" } });
  expect(attempts[1]).toEqual(attempts[0]);
  const visitId = attempts[0]!.body.visitId;
  expect((await scan(token)).body).toMatchObject({ state: "active", visitId });
  await ageVisit(db, visitId, 30);
  expect((await scan(token, cg.sub, { visitId })).body).toMatchObject({ state: "confirmation", visitId });
  expect((await scan(token, cg.sub, { visitId })).body).toMatchObject({ state: "confirmation", visitId });
  const confirmed = await call("POST /v1/visits/{visitId}/confirm", {
    sub: cg.sub, path: { visitId }, key: randomUUID(),
    body: { organizationId: org, signerRole: "client", method: "draw", signaturePng: syntheticPng(60,30,7).toString("base64"), attested: true },
  });
  expect(confirmed.status).toBe(200);
  const recorded = (await db.admin.query("select scheduled_shift_id, worked_minutes from ogevia.service_visits where client_id=$1", [client])).rows;
  expect(recorded).toEqual([{ scheduled_shift_id: shiftId, worked_minutes: 30 }]);
  expect((await manage("revoke")).body.active).toBe(false);
  expect((await scan(token)).body).toEqual({ state: "unavailable" });
  expect((await manage("regenerate")).body.active).toBe(true);
  const replacement = (await manage("reprint")).body.token;
  expect(replacement).not.toBe(token);
  expect((await scan(token)).body).toEqual({ state: "unavailable" });
  const audit = (await db.admin.query("select action, before_state, after_state from ogevia.audit_events where entity_type='client_qr_cards' and entity_id=$1", [client])).rows;
  expect(audit.map(row => row.action)).toEqual(expect.arrayContaining(["QR_CREATED","QR_REPRINTED","QR_REVOKED","QR_REGENERATED"]));
  for (const raw of [token, replacement]) expect(JSON.stringify({ logs, audit })).not.toContain(raw);
});
