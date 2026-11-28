// 0118 over HTTP (real Lambda handler): the service-location routes, and the Details edit that no longer carries or changes the city. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

const errs: string[] = [];
let db: TestDb; let w: World; let handler: ReturnType<typeof createHandler>; let temecula: string; let client: string;
beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true }); w = await seedWorld(db, 1185);
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner");
    for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql", "0113_notifications.sql", "0117_open_shift_sms.sql", "0118_client_service_location.sql"]) await c.query(readFileSync(new URL(`../../../infra/aws/db/pending/migrations/${f}`, import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  temecula = await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_office($1,'Temecula Office',null) as id", [w.orgA])).rows[0].id as string);
  client = (await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 40 })).client as string;
  await db.admin.query("update ogevia.clients set city = 'Hemet' where id = $1", [client]);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => { if ((l as any)?.level === 'error') errs.push(JSON.stringify(l)); } });
}, 120_000);
afterAll(async () => { delete process.env.SERVICE_LOCATION; delete process.env.COVER_ALERT_ADDRESS_RULES; await db?.drop(); });

async function get(a: Actor | null, route: string, path: Record<string, string>) {
  const r = await handler(event(route, { ...(a ? { sub: a.sub } : {}), path, query: { organizationId: w.orgA } })); return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
async function post(a: Actor | null, route: string, path: Record<string, string>, body: Record<string, unknown>) {
  const r = await handler(event(route, { ...(a ? { sub: a.sub } : {}), path, body: { organizationId: w.orgA, ...body } })); return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("service location routes", () => {
  it("read and save together; incomplete shows what is missing; validated; manage-clients only; signed in only", async () => {
    const before = await get(w.managerA, "GET /v1/clients/{clientId}/service-location", { clientId: client });
    expect(before.status).toBe(200); expect(before.body.location).toMatchObject({ city: "Hemet", zip: null, complete: false, missing: ["zip"], office: null });
    expect((await get(null, "GET /v1/clients/{clientId}/service-location", { clientId: client })).status).toBe(401);
    expect((await get(w.caregiverA1, "GET /v1/clients/{clientId}/service-location", { clientId: client })).status).toBe(403);
    expect((await post(w.schedulerA, "POST /v1/clients/{clientId}/service-location", { clientId: client }, { city: "Winchester", zip: "92596" })).status).toBe(403);
    expect((await post(w.managerA, "POST /v1/clients/{clientId}/service-location", { clientId: client }, { city: "", zip: "92596" })).status).toBe(400);
    expect((await post(w.managerA, "POST /v1/clients/{clientId}/service-location", { clientId: client }, { city: "Winchester", zip: "9259" })).status).toBe(400);
    expect((await post(w.managerA, "POST /v1/clients/{clientId}/service-location", { clientId: client }, { city: "Winchester", zip: "92596", county: "Narnia" })).status).toBeGreaterThanOrEqual(400);
    const ok = await post(w.managerA, "POST /v1/clients/{clientId}/service-location", { clientId: client }, { city: "Winchester", zip: "92596", county: "Riverside County", officeId: temecula });
    expect(ok.status).toBe(200); expect(ok.body.location).toMatchObject({ city: "Winchester", zip: "92596", state: "CA", county: "Riverside", complete: true, office: { officeId: temecula, name: "Temecula Office" } });
  });
  it("with the switch on, the Details edit leaves the city alone and does not demand a city or ZIP; with it off the old behavior is unchanged", async () => {
    process.env.COVER_ALERT_ADDRESS_RULES = "on"; process.env.SERVICE_LOCATION = "on";
    await db.admin.query("update ogevia.clients set city = 'Winchester' where id = $1", [client]);
    const d = await post(w.managerA, "POST /v1/clients/{clientId}/details", { clientId: client }, { firstName: "Synthetic", lastName: "Client", clientTypeId: null, caregiverLabel: null });   // no city, no ZIP sent
    expect(d.status, JSON.stringify(d.body) + errs.join("|")).toBe(200);
    expect((await db.admin.query("select city from ogevia.clients where id = $1", [client])).rows[0].city).toBe("Winchester");   // not cleared
    delete process.env.SERVICE_LOCATION;                                                                                         // switch off: the old rule (city required with the alert rules on)
    expect((await post(w.managerA, "POST /v1/clients/{clientId}/details", { clientId: client }, { firstName: "Synthetic", lastName: "Client" })).status).toBe(400);
    delete process.env.COVER_ALERT_ADDRESS_RULES;
  });
});
