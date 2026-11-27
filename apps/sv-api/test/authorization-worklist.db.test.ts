// 0125 through the real handler: the Authorization Worklist route. SYNTHETIC data only.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, freshClient, seedWorld, signedVisit, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createHandler } from "../src/handler";
import { MemoryEvidenceStore } from "../src/evidence";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb, w: World, handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  vi.stubEnv("OGEVIA_QR_ENCRYPTION_KEY", "d".repeat(64));
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  const dir = new URL("../../../infra/aws/db/pending/migrations/", import.meta.url);
  const c = await db.admin.connect();
  try { for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL(f, dir), "utf8")); await c.query("reset role"); await c.query("commit"); } } finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => {} });
}, 240_000);
afterAll(async () => { vi.unstubAllEnvs(); await db?.drop(); });
const get = async (sub: string, query: Record<string, string>) => { const r = await handler(event("GET /v1/authorization-worklist", { sub, query })); return { status: r.statusCode, body: JSON.parse(r.body || "{}") as any }; };

describe("GET /v1/authorization-worklist", () => {
  it("returns the worklist with hours and status for people who may read authorizations, in the caller's agency only", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 60, w.orgA, { before: 20, after: 100 });
    await signedVisit(db, w.caregiverA1, w, 55, w.orgA, f.client, f.service);
    const ok = await get(w.managerA.sub, { organizationId: w.orgA, clientId: f.client });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.rows).toHaveLength(1);
    expect(ok.body.rows[0]).toMatchObject({ clientId: f.client, status: "nearly_exhausted", authorizedMinutes: 60, usedMinutes: 55, remainingMinutes: 5, program: "SYNTHETIC-PAYER" });
    expect(JSON.stringify(ok.body)).not.toMatch(/legal|firstName|lastName/);
    expect((await get(w.schedulerA.sub, { organizationId: w.orgA, clientId: f.client })).status).toBe(200);
    expect((await get(w.caregiverA1.sub, { organizationId: w.orgA })).status).toBe(403);
    expect((await get(w.managerB.sub, { organizationId: w.orgA, clientId: f.client })).status).toBe(404);
    const b = await get(w.managerB.sub, { organizationId: w.orgB });
    expect(b.status).toBe(200); expect(JSON.stringify(b.body)).not.toContain(f.client);
  });
  it("validates its filters before it reads anything", async () => {
    for (const q of [{ status: "bogus" }, { expiringDays: "x" }, { nearlyPercent: "1.5" }, { month: "2026-13-45" }, { clientId: "nope" }]) {
      expect((await get(w.managerA.sub, { organizationId: w.orgA, ...q })).status, JSON.stringify(q)).toBe(400);
    }
    expect((await get(w.managerA.sub, { organizationId: w.orgA, expiringDays: "0" })).status).toBe(422);
    expect((await get(w.managerA.sub, { organizationId: w.orgA, status: "attention", expiringDays: "45", nearlyPercent: "90", from: "2026-01-01", to: "2026-12-31" })).status).toBe(200);
  });
});
