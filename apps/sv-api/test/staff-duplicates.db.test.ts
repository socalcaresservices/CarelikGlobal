// R6 duplicate staff over HTTP (pending migration 0093, applied on top of 0001-0088) through the real Lambda handler and a real disposable PostgreSQL.
// SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
const logs: unknown[] = [];


beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1300);
  const c = await db.admin.connect();
  try {
    await c.query("begin"); await c.query("set local role ogevia_owner");
    await c.query(readFileSync(new URL("../../../infra/aws/db/pending/migrations/0106_staff_duplicates.sql", import.meta.url), "utf8"));
    await c.query("reset role"); await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (l: unknown) => logs.push(l) });
});
afterAll(async () => db?.drop());

async function call(routeKey: string, actor: Actor | null, opts: Parameters<typeof event>[1] = {}) {
  const r = await handler(event(routeKey, { ...(actor ? { sub: actor.sub } : {}), ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}
let typeId = "";
const mk = async (name: string) => {
  if (!typeId) typeId = (await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_staff_type($1,'Office (synthetic)') as id", [w.orgA])).rows))[0].id;
  return (await asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.create_staff($1,$2,$3,null,null) as id", [w.orgA, name, typeId])).rows))[0].id as string;
};

describe("duplicate staff routes", () => {
  it("GET lists possible duplicates (read-only); POST merges, repeating is harmless; the reason is required", async () => {
    const keep = await mk("Hal Http"), dup = await mk("hal  HTTP");
    const g = await call("GET /v1/staff/duplicates", w.ownerA, { query: { organizationId: w.orgA } });
    expect(g.status).toBe(200);
    expect(g.body.duplicates.filter((d: any) => /hal http/i.test(d.displayName ?? d.display_name)).length).toBe(2);
    const noReason = await call("POST /v1/staff/{profileId}/merge", w.ownerA, { path: { profileId: keep }, body: { organizationId: w.orgA, duplicateProfileId: dup } });
    expect(noReason.status).toBe(400);
    const m = await call("POST /v1/staff/{profileId}/merge", w.ownerA, { path: { profileId: keep }, body: { organizationId: w.orgA, duplicateProfileId: dup, reason: "Entered twice (synthetic)" } });
    expect(m.status).toBe(200);
    expect(m.body.result).toBe("merged");
    const again = await call("POST /v1/staff/{profileId}/merge", w.ownerA, { path: { profileId: keep }, body: { organizationId: w.orgA, duplicateProfileId: dup, reason: "Entered twice (synthetic)" } });
    expect(again.body.result).toBe("already_merged");
    expect((await db.admin.query("select status from ogevia.staff_profiles where id = $1", [dup])).rows[0].status).toBe("inactive");
  });

  it("a record with no match is refused (409); a caregiver is 403; no sign-in is 401; another agency's administrator gets 404", async () => {
    const a = await mk("Ida Alone"), b = await mk("Jon Other");
    const body = { organizationId: w.orgA, duplicateProfileId: b, reason: "Trying it (synthetic)" };
    expect((await call("POST /v1/staff/{profileId}/merge", w.ownerA, { path: { profileId: a }, body })).status).toBe(409);
    expect((await call("POST /v1/staff/{profileId}/merge", w.caregiverA1, { path: { profileId: a }, body })).status).toBe(403);
    expect((await call("POST /v1/staff/{profileId}/merge", null, { path: { profileId: a }, body })).status).toBe(401);
    expect((await call("POST /v1/staff/{profileId}/merge", w.managerB, { path: { profileId: a }, body })).status).toBe(404);
    expect((await call("GET /v1/staff/duplicates", w.caregiverA1, { query: { organizationId: w.orgA } })).status).toBe(403);
  });
});
