// Duplicate-name flag (SYNTHETIC data): the server compares normalized names inside one agency and returns only a boolean.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { duplicateNameIds } from "../src/routes";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
const clients: string[] = [];
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
  for (let i = 0; i < 3; i++) clients.push((await freshClient(db, w, w.caregiverA1, 5000, w.orgA)).client);
  const name = async (id: string, first: string, last: string) =>
    expect((await call("POST /v1/clients/{clientId}/legal-name", w.ownerA, { path: { clientId: id }, body: { organizationId: w.orgA, firstName: first, lastName: last }, key: randomUUID() })).status).toBe(200);
  await name(clients[0]!, "Dana", "Sample");
  await name(clients[1]!, " dana ", "SAMPLE");
  await name(clients[2]!, "Dana", "Other");
});
afterAll(async () => db?.drop());
async function call(routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { sub: actor.sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

describe("duplicate names", () => {
  it("pure helper: shared normalized names are flagged, unique ones are not", () => {
    const d = duplicateNameIds([{ id: "a", names: ["ana lee"] }, { id: "b", names: ["ana lee", "bo"] }, { id: "c", names: ["cy"] }, { id: "d", names: ["bo"] }]);
    expect([...d].sort()).toEqual(["a", "b", "d"]);
  });

  it("client list flags only the clients that share a name", async () => {
    const r = await call("GET /v1/clients", w.ownerA, { query: { organizationId: w.orgA } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const flag = (id: string) => r.body.clients.find((c: any) => c.clientId === id).duplicateName;
    expect([flag(clients[0]!), flag(clients[1]!), flag(clients[2]!)]).toEqual([true, true, false]);
  });

  it("caregiver list flags a shared name and shift rows carry the flags", async () => {
    await db.admin.query("update ogevia.caregiver_records set first_name = 'Pat', last_name = 'Twin' where organization_id = $1 and linked_user_id in ($2, $3)", [w.orgA, w.caregiverA1.userId, w.caregiverA2.userId]);
    const r = await call("GET /v1/caregivers", w.ownerA, { query: { organizationId: w.orgA } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const twins = r.body.caregivers.filter((c: any) => c.firstName === "Pat");
    expect(twins.length).toBe(2);
    expect(twins.every((c: any) => c.duplicateName === true)).toBe(true);
    expect(r.body.caregivers.filter((c: any) => c.firstName !== "Pat").every((c: any) => c.duplicateName === false)).toBe(true);

    const shift = (await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status)
       values ($1,$2,$3, now() + interval '1 day', now() + interval '1 day 2 hours', 'scheduled') returning id`, [w.orgA, clients[0], w.serviceA])).rows[0].id as string;
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const s = await call("GET /v1/shifts", w.ownerA, { query: { organizationId: w.orgA, from: day, to: day } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const row = s.body.shifts.find((x: any) => x.shiftId === shift);
    expect(row).toMatchObject({ duplicateName: true, caregiverDuplicateName: false });
  });
});
