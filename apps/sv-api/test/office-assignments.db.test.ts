// 0111 (pending migration) over HTTP through the real Lambda handler and a real disposable PostgreSQL: office address/county, assignments with a primary, service counties, caregiver colour. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb; let w: World; let handler: ReturnType<typeof createHandler>; let cg: string; let cgB: string; let north: string; let south: string;
beforeAll(async () => {
  db = await createTestDb(); w = await seedWorld(db, 1420);
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql"]) {
    const c = await db.admin.connect();
    try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL(`../../../infra/aws/db/pending/migrations/${f}`, import.meta.url), "utf8")); await c.query("reset role"); await c.query("commit"); }
    catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
  cg = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1, 'CG-API-1', 'Api', 'One', 'active') returning id", [w.orgA])).rows[0].id;
  cgB = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) values ($1, 'CG-API-2', 'Api', 'Two', 'active') returning id", [w.orgB])).rows[0].id;
}, 120_000);
afterAll(async () => db?.drop());
async function call(routeKey: string, actor: Actor | null, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { ...(actor ? { sub: actor.sub } : {}), ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("office assignment routes", () => {
  it("the Administrator adds offices with an address and county and edits them; a manager and a caregiver are refused; a missing name is a 400 and an unknown county a 422", async () => {
    north = (await call("POST /v1/offices", w.ownerA, { body: { organizationId: w.orgA, name: "Temecula" } })).body.officeId;
    south = (await call("POST /v1/offices", w.ownerA, { body: { organizationId: w.orgA, name: "Moreno Valley" } })).body.officeId;
    const upd = (office: string, body: Record<string, unknown>, a: Actor = w.ownerA) => call("POST /v1/offices/{officeId}/update", a, { path: { officeId: office }, body: { organizationId: w.orgA, ...body } });
    expect((await upd(north, { name: "Temecula", addressLine1: "1 Synthetic Way", city: "Temecula", postalCode: "92590", county: "riverside" })).body.status).toBe("updated");
    expect((await upd(north, { name: "Temecula", addressLine1: "1 Synthetic Way", city: "Temecula", postalCode: "92590", county: "Riverside" })).body.status).toBe("unchanged");
    expect((await upd(north, { name: "Temecula" }, w.managerA)).status).toBe(403);
    expect((await upd(north, { name: "Temecula" }, w.caregiverA1)).status).toBe(403);
    expect((await upd(north, { name: "Temecula", county: "Atlantis" })).status).toBe(422);
    expect((await upd(north, {})).status).toBe(400);
    const list = await call("GET /v1/offices", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.body.offices.find((o: any) => o.officeId === north)).toMatchObject({ addressLine1: "1 Synthetic Way", city: "Temecula", county: "Riverside" });
  });
  it("a manager assigns a client and a caregiver (primary plus secondary), changes the primary, and the facets show each once with the primary flagged", async () => {
    const setC = (body: Record<string, unknown>, a: Actor = w.managerA) => call("POST /v1/caregivers/{caregiverRecordId}/offices", a, { path: { caregiverRecordId: cg }, body: { organizationId: w.orgA, ...body } });
    expect((await setC({ primaryOfficeId: north, secondaryOfficeIds: [south] })).body.status).toBe("set");
    expect((await setC({ primaryOfficeId: south, secondaryOfficeIds: [north] })).body.status).toBe("set");
    expect((await setC({ primaryOfficeId: null, secondaryOfficeIds: [north] })).status).toBe(422);   // a primary is required once there are offices
    expect((await setC({ primaryOfficeId: north }, w.caregiverA1)).status).toBe(403);
    expect((await call("POST /v1/clients/{clientId}/offices", w.managerA, { path: { clientId: w.clientA1 }, body: { organizationId: w.orgA, primaryOfficeId: north } })).body.status).toBe("set");
    const f = (await call("GET /v1/people-facets", w.managerA, { query: { organizationId: w.orgA } })).body.facets;
    expect(f.caregiverOffices.filter((x: any) => x.caregiverRecordId === cg).map((x: any) => [x.officeId, x.isPrimary])).toEqual([[south, true], [north, false]]);
    expect(f.clientOffices.filter((x: any) => x.clientId === w.clientA1).map((x: any) => [x.officeId, x.isPrimary])).toEqual([[north, true]]);
  });
  it("service counties and caregiver colour save; a caregiver cannot read the facets; another agency's records and offices are refused (404/403)", async () => {
    expect((await call("POST /v1/clients/{clientId}/service-county", w.managerA, { path: { clientId: w.clientA1 }, body: { organizationId: w.orgA, county: "San Bernardino" } })).body.status).toBe("set");
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/service-counties", w.managerA, { path: { caregiverRecordId: cg }, body: { organizationId: w.orgA, counties: ["Riverside", "San Diego"] } })).body.status).toBe("set");
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/color", w.managerA, { path: { caregiverRecordId: cg }, body: { organizationId: w.orgA, color: "yellow" } })).body.status).toBe("set");
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/color", w.managerA, { path: { caregiverRecordId: cg }, body: { organizationId: w.orgA, color: "#fff" } })).status).toBe(422);
    const f = (await call("GET /v1/people-facets", w.managerA, { query: { organizationId: w.orgA } })).body.facets;
    expect(f.caregiverColors).toEqual([{ caregiverRecordId: cg, userId: null, color: "yellow" }]); expect(f.clientCounties).toEqual([{ clientId: w.clientA1, county: "San Bernardino" }]);
    expect(f.caregiverCounties.map((x: any) => x.county).sort()).toEqual(["Riverside", "San Diego"]);
    expect((await call("GET /v1/people-facets", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("GET /v1/people-facets", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/color", w.managerA, { path: { caregiverRecordId: cgB }, body: { organizationId: w.orgA, color: "red" } })).status).toBe(404);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/offices", w.managerB, { path: { caregiverRecordId: cg }, body: { organizationId: w.orgB, primaryOfficeId: north } })).status).toBe(404);
    expect((await call("POST /v1/clients/{clientId}/offices", w.managerA, { path: { clientId: w.clientA2 }, body: { organizationId: w.orgA, primaryOfficeId: "00000000-0000-4000-8000-000000000000" } })).status).toBe(404);
  });
});
