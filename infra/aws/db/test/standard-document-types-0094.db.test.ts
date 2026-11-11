// 0094 (PENDING): standard CPR and TB document types for every agency: names only, no requirement chosen, no validity rule. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedWorld, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0107_standard_document_types.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0107_standard_document_types.down.sql", import.meta.url);
let db: TestDb; let w: World;
const run = async (url: URL) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
const names = async (org: string) => (await db.admin.query("select name, requires_expiry from ogevia.document_types where organization_id = $1 order by name", [org])).rows;

beforeAll(async () => { db = await createTestDb(); w = await seedWorld(db, 1400); });
afterAll(async () => db?.drop());

describe("0094 standard document types", () => {
  it("creates CPR and TB (no expiry requirement) for every agency with an owner, chooses no requirement, sets no validity rule, and audits each row", async () => {
    // Agency B already has a "CPR card" type: it keeps that, and only TB is added.
    await db.admin.query("insert into ogevia.document_types (organization_id, name, requires_expiry, created_by) values ($1,'CPR card',true,$2)", [w.orgB, w.managerB.userId]);
    await db.admin.query("update ogevia.organization_memberships set role = 'organization_owner' where organization_id = $1 and user_id = $2", [w.orgB, w.managerB.userId]);
    await run(UP);
    expect((await names(w.orgA)).map((r) => r.name)).toEqual(["CPR", "TB"]);
    expect((await names(w.orgA)).every((r) => r.requires_expiry === false)).toBe(true);
    expect((await names(w.orgB)).map((r) => r.name)).toEqual(["CPR card", "TB"]);
    const req = await db.admin.query("select count(*)::int n from ogevia.document_requirement_policies where organization_id = $1", [w.orgA]).catch(() => ({ rows: [{ n: 0 }] }));
    expect(req.rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events where action = 'document_type.created' and after_state ->> 'source' = 'standard_types_0094'")).rows[0].n).toBe(3);
  });
  it("is idempotent, and the rollback removes only the rows it created", async () => {
    const f = new URL(UP);
    const c = await db.admin.connect(); try { const r = await c.query("select ogevia.ensure_standard_document_types($1) n", [w.orgA]); expect(r.rows[0].n).toBe(0); } finally { c.release(); }
    await run(DOWN);
    expect((await names(w.orgA)).length).toBe(0);
    expect((await names(w.orgB)).map((r) => r.name)).toEqual(["CPR card"]);
    void f;
  });
});
