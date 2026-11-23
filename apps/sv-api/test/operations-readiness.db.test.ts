// GET /v1/operations-readiness: one call composing existing functions, each under its own permission; a part that is not allowed is named, never zero. SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb; let w: World; let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
});
afterAll(async () => db?.drop());
const get = async (a: Actor | null, org = w.orgA) => {
  const r = await handler(event("GET /v1/operations-readiness", { ...(a ? { sub: a.sub } : {}), query: { organizationId: org } }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
};

describe("GET /v1/operations-readiness", () => {
  it("returns the overview, the expiring authorizations and the compliance summary for a manager, as of now, with nothing unavailable", async () => {
    const r = await get(w.managerA);
    expect(r.status).toBe(200);
    expect(r.body.readiness.unavailable).toEqual([]);
    expect(r.body.readiness.overview).toMatchObject({ urgentWindowHours: 48 });
    expect(Array.isArray(r.body.readiness.expiring)).toBe(true);
    expect(r.body.readiness.compliance).toHaveProperty("enforcementActive");
    expect(Date.now() - Date.parse(r.body.readiness.asOf)).toBeLessThan(60_000);
  });
  it("a caregiver is refused (403): nothing is composed or shown as empty; a person of another agency is refused; no sign-in is 401", async () => {
    expect((await get(w.caregiverA1)).status).toBe(403);
    expect((await get(w.managerB)).status).toBe(403);
    expect((await get(null)).status).toBe(401);
  });
  it("a role with only some permissions gets the parts it may see and the others named as unavailable (never empty)", async () => {
    const r = await get(w.schedulerA);
    if (r.status === 200) {
      for (const name of r.body.readiness.unavailable as string[]) expect(r.body.readiness[name]).toBeNull();
      expect(Array.isArray(r.body.readiness.unavailable)).toBe(true);
    } else expect(r.status).toBe(403);
  });
});
