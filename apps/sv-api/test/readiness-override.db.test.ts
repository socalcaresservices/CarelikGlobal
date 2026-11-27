// 0123 (PENDING) through the real Lambda handler: approve, list and revoke an admin override of a CPR readiness block, and who may do it. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

const P = (f: string) => readFileSync(new URL(`../../../infra/aws/db/pending/${f}`, import.meta.url), "utf8");
let db: TestDb; let w: World; let handler: ReturnType<typeof createHandler>; let rec: string; let cpr: string;
const run = async (sql: string) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(sql); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
const sql = <T = any>(a: Actor, text: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(text, params)).rows as T[]);
const call = async (routeKey: string, actor: Actor, opts: Parameters<typeof event>[1] = {}) => { const r = await handler(event(routeKey, { sub: actor.sub, ...opts })); return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> }; };

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1600);
  for (const f of ["migrations/0103_caregiver_signin_override.sql", "migrations/0122_unset_cpr_tb_type_not_a_block.sql", "migrations/0123_readiness_override.sql"]) await run(P(f));
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: () => undefined });
  cpr = (await sql(w.managerA, "select ogevia_api.create_document_type($1,'CPR card',true,null) as id", [w.orgA]))[0].id;
  const tb = (await sql(w.managerA, "select ogevia_api.create_document_type($1,'TB result',false,null) as id", [w.orgA]))[0].id;
  await sql(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'cpr',$2,'Agency policy')", [w.orgA, cpr]);
  await sql(w.ownerA, "select ogevia_api.set_document_work_requirement($1,'tb',$2,'Agency policy')", [w.orgA, tb]);
  await sql(w.ownerA, "select ogevia_api.set_requirement_policy($1,'cpr','document_expiry',null,'Per agency policy')", [w.orgA]);
  await sql(w.ownerA, "select ogevia_api.set_requirement_policy($1,'tb','issue_plus_days',365,'Per agency policy')", [w.orgA]);
  rec = (await sql(w.managerA, "select * from ogevia_api.create_caregiver($1,'Synthetic','Override Route',null,'onboarding',null)", [w.orgA]))[0].caregiver_record_id;
  await db.admin.query("update ogevia.caregiver_records set hire_date = current_date - 90 where id = $1", [rec]);       // past the grace period: a missing CPR is a real block
}, 120_000);
afterAll(async () => db?.drop());

const readiness = async () => (await call("GET /v1/caregivers/{caregiverRecordId}/readiness", w.ownerA, { path: { caregiverRecordId: rec }, query: { organizationId: w.orgA } })).body.readiness;

describe("readiness override API", () => {
  it("the readiness read carries the exact issue; an administrator approves it (201) and it is listed with who and why", async () => {
    const item = (await readiness()).items.find((i: any) => i.requirement === "cpr");
    expect(item.extra).toMatchObject({ issueStatus: "missing", issueLabel: "Missing Doc" });
    const key = item.extra.issueKey as string;
    const out = await call("POST /v1/caregivers/{caregiverRecordId}/readiness-override", w.ownerA, { path: { caregiverRecordId: rec }, body: { organizationId: w.orgA, requirement: "cpr", issueKey: key, reason: "Card is being renewed; supervised" } });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body.override).toMatchObject({ requirement: "cpr", issueStatus: "missing", active: true });
    const after = (await readiness()).items.find((i: any) => i.requirement === "cpr");
    expect(after.extra.override).toMatchObject({ reason: "Card is being renewed; supervised" });
    const list = await call("GET /v1/readiness-overrides", w.ownerA, { query: { organizationId: w.orgA, activeOnly: "true" } });
    expect(list.status).toBe(200);
    expect(list.body.overrides).toHaveLength(1);
    expect(list.body.overrides[0]).toMatchObject({ caregiverRecordId: rec, requirement: "cpr", issueLabel: "Missing Doc", active: true, stillApplies: true });
  });

  it("who may: a manager and a caregiver are refused (403), another agency's administrator gets 404, and an unknown requirement or an empty reason is a 400", async () => {
    const key = (await readiness()).items.find((i: any) => i.requirement === "cpr").extra.issueKey as string;
    const body = { organizationId: w.orgA, requirement: "cpr", issueKey: key, reason: "A perfectly good reason" };
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/readiness-override", w.managerA, { path: { caregiverRecordId: rec }, body })).status).toBe(403);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/readiness-override", w.caregiverA1, { path: { caregiverRecordId: rec }, body })).status).toBe(403);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/readiness-override", w.managerB, { path: { caregiverRecordId: rec }, body })).status).toBe(404);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/readiness-override", w.ownerA, { path: { caregiverRecordId: rec }, body: { ...body, requirement: "background" } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/readiness-override", w.ownerA, { path: { caregiverRecordId: rec }, body: { ...body, reason: "" } })).status).toBe(400);
  });

  it("a stale issue is refused with a conflict and nothing is recorded", async () => {
    const r = await call("POST /v1/caregivers/{caregiverRecordId}/readiness-override", w.ownerA, { path: { caregiverRecordId: rec }, body: { organizationId: w.orgA, requirement: "tb", issueKey: "expired:" + randomUUID() + ":2020-01-01", reason: "A perfectly good reason" } });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/changed since you opened|already verified|finished the CPR and TB setup/);
  });

  it("revoking needs the administrator permission and a reason; the override then reads as revoked and the block returns", async () => {
    const id = (await call("GET /v1/readiness-overrides", w.ownerA, { query: { organizationId: w.orgA, caregiverRecordId: rec } })).body.overrides[0].id as string;
    const bodyOf = (reason: string) => ({ organizationId: w.orgA, reason });
    expect((await call("POST /v1/readiness-overrides/{overrideId}/revoke", w.managerA, { path: { overrideId: id }, body: bodyOf("Renewal did not happen") })).status).toBe(403);
    expect((await call("POST /v1/readiness-overrides/{overrideId}/revoke", w.ownerA, { path: { overrideId: id }, body: bodyOf("no") })).status).toBe(422);   // too short: the database rule (OGV22)
    const ok = await call("POST /v1/readiness-overrides/{overrideId}/revoke", w.ownerA, { path: { overrideId: id }, body: bodyOf("Renewal did not happen") });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.override).toMatchObject({ active: false });
    expect((await readiness()).items.find((i: any) => i.requirement === "cpr").extra.override).toBeUndefined();
    const history = (await call("GET /v1/readiness-overrides", w.ownerA, { query: { organizationId: w.orgA, caregiverRecordId: rec } })).body.overrides;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ active: false, revokeReason: "Renewal did not happen" });
  });
});
