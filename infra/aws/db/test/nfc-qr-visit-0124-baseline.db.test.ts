// 0124 on the PRODUCTION baseline (0001-0088 only, without the TEST-only 0089-0102): the shift-aware start from 0102 is absent, so the baseline start is used and a
// choice it cannot honour is refused cleanly. SYNTHETIC data only.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createHelperShift, createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1400);
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL("../pending/migrations/0124_nfc_qr_visit_verification.sql", import.meta.url), "utf8")); await c.query("reset role"); await c.query("commit"); } finally { c.release(); }
}, 180_000);
afterAll(async () => db?.drop());

describe("0124 on the production baseline", () => {
  it("the shift-aware start is absent here; one matching visit still clocks in, and a choice the baseline start cannot honour is refused with nothing clocked", async () => {
    expect((await db.admin.query("select to_regprocedure('ogevia.start_service_visit(uuid,uuid,uuid,text[],text,uuid,text,uuid)') p")).rows[0].p).toBeNull();
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const loc = (await call(w.ownerA, "select ogevia_api.save_service_location($1,$2,null,'home','Client home','100 Synthetic Way','Synthetictown','CA','90001',34.0522,-118.2437) as id", [w.orgA, f.client]))[0].id;
    const token = randomBytes(32).toString("hex"); const code = "OGL-" + "ABCDEFGH";
    await call(w.ownerA, "select ogevia_api.register_home_labels($1,$2::jsonb)", [w.orgA, JSON.stringify([{ code, hash: sha(token), sealed: "sealed:x" }])]);
    await call(w.ownerA, "select ogevia_api.assign_home_label($1,$2,$3,true,false)", [w.orgA, code, loc]);
    await createHelperShift(db, w.orgA, w.caregiverA1.userId, f.client, f.service);
    const punch = (shift: string | null, intent = "arrival") => call(w.caregiverA1, "select ogevia_api.record_punch($1,null,$2,$3,null,34.0522,-118.2437,20,$4,false) as r", [sha(token), intent, shift, randomUUID()]).then((r) => r[0].r as any);
    // two back-to-back shifts inside the window
    const first = (await db.admin.query("select id from ogevia.shifts where client_id = $1", [f.client])).rows[0].id as string;
    const c = await db.admin.connect();
    try { await c.query("set session_replication_role = replica"); await c.query("update ogevia.shifts set ends_at = now() + interval '30 minutes' where id = $1", [first]); } finally { await c.query("reset session_replication_role"); c.release(); }
    await db.admin.query(`insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
                          select organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, ends_at, ends_at + interval '120 minutes' from ogevia.shifts where id = $1`, [first]);
    const second = (await db.admin.query("select id from ogevia.shifts where client_id = $1 and id <> $2", [f.client, first])).rows[0].id as string;
    expect(await punch(null)).toMatchObject({ outcome: "needs_choice" });
    const refused = await punch(second);
    expect(refused).toMatchObject({ outcome: "not_saved", reason: "start_refused" });
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where client_id = $1", [f.client])).rows[0].n).toBe(0);
    expect(await punch(first)).toMatchObject({ outcome: "saved", locationResult: "within_range" });
  });
});
