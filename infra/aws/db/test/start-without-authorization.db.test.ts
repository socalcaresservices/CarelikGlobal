// Owner confirmation (a): a caregiver cannot start a visit for a client who has no active service authorization today, whatever the UI shows.
// The refusal is server-side (ogevia_api.start_ad_hoc_service_visit, SQLSTATE OGC09) and creates no visit. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, seedWorld, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fx: { client: string; service: string; auth: string };

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 700);
  fx = await freshClient(db, w, w.caregiverA1, 100000, w.orgA, { before: 40, after: -2 });   // the authorization ended two days ago: 0 active services today
});
afterAll(async () => db?.drop());

const start = (reason: string | null) =>
  asActor(db, w.caregiverA1.sub, async (c) =>
    (await c.query("select ogevia_api.start_ad_hoc_service_visit($1, $2, $3, '{}', null, $4, $5) as id", [w.orgA, fx.client, fx.service, randomUUID(), reason])).rows[0].id as string);
const visits = async () => (await db.admin.query("select count(*)::int n from ogevia.service_visits where client_id = $1", [fx.client])).rows[0].n as number;

describe("start a visit for a client with no active authorization", () => {
  it("is refused by the server (OGC09) and creates no visit, even with a reason", async () => {
    await expectPgError(start("Scheduled visit, authorization lapsed (synthetic)"), "OGC09", /No active authorization covers this client and service/);
    await expectPgError(start(null), "OGC09", /No active authorization covers this client and service/);
    expect(await visits()).toBe(0);
  });
});
