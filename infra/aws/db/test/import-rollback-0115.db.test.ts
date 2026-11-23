// 0115 (PENDING): bulk import history and rollback, on top of 0105. SYNTHETIC data only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const P = (n: string) => new URL(`../pending/${n}`, import.meta.url);
let db: TestDb; let w: World; let staffType: string; let today: string;
const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const imp = (a: Actor, kind: string, rows: unknown[], seed: string, confirm: boolean) =>
  call(a, "select ogevia_api.import_rows($1,$2,$3::jsonb,$4,'people.csv',$5) as r", [w.orgA, kind, JSON.stringify(rows), sha(seed), confirm]).then((r) => r[0].r);
const history = (a: Actor = w.ownerA) => call(a, "select * from ogevia_api.list_import_batches($1)", [w.orgA]);
const rollback = (a: Actor, batch: string, reason = "Synthetic: wrong file") => call(a, "select ogevia_api.rollback_import_batch($1,$2,$3) as r", [w.orgA, batch, reason]).then((r) => r[0].r);
const q = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows as any[];

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1000);
  today = await orgToday(db);
  await run(P("migrations/0105_bulk_import.sql"));
  staffType = (await call(w.ownerA, "select ogevia_api.create_staff_type($1,'Scheduler (synthetic)') as id", [w.orgA]))[0].id;
  // an import made BEFORE 0115: it has no records, so it can never be rolled back
  await imp(w.ownerA, "people", [{ first_name: "Early", last_name: "Bird", type: "Caregiver" }], "early", true);
  await run(P("migrations/0115_import_history_rollback.sql"));
}, 120_000);
afterAll(async () => db?.drop());

describe("history", () => {
  it("lists earlier imports as not rollbackable, and new ones with their counts, who and when", async () => {
    const early = (await history())[0];
    expect(early).toMatchObject({ kind: "people", row_count: 1, created_count: 1, can_roll_back: false });
    await expectPgError(rollback(w.ownerA, early.batch_id), "OGC09");
    await imp(w.ownerA, "people", [{ first_name: "Ana", last_name: "Sample", type: "Caregiver" }, { first_name: "Sam", last_name: "Planner", type: "Scheduler (synthetic)", email: "sam@example.invalid" }], "mix", true);
    const h = (await history())[0];
    expect(h).toMatchObject({ file_name: "people.csv", row_count: 2, created_count: 2, can_roll_back: true, rolled_back_at: null });
    expect(await q("select entity_type from ogevia.import_batch_records where batch_id = $1 order by 1", [h.batch_id])).toEqual([{ entity_type: "caregiver" }, { entity_type: "staff" }]);
  });
  it("is readable by the Administrator and staff managers, not by a caregiver or another agency", async () => {
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_import_batches($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select * from ogevia_api.list_import_batches($1)", [w.orgA]), "OGN04");
  });
});

describe("rollback", () => {
  it("undoes one untouched import all-or-nothing: records become Inactive (not deleted), the reason and audit are kept, and a repeat is a no-op", async () => {
    const batch = (await history())[0].batch_id as string;
    await expectPgError(rollback(w.ownerA, batch, " "), "OGV22");
    expect(await rollback(w.ownerA, batch)).toEqual({ state: "rolled_back", records: 2 });
    expect((await q("select status from ogevia.caregiver_records where first_name = 'Ana'"))[0].status).toBe("inactive");
    expect((await q("select status from ogevia.staff_profiles where display_name = 'Sam Planner'"))[0].status).toBe("inactive");
    expect(await rollback(w.ownerA, batch)).toEqual({ state: "already_rolled_back" });
    const h = (await history())[0]; expect(h).toMatchObject({ can_roll_back: false, rolled_back_reason: "Synthetic: wrong file" });
    const audit = await q("select reason, after_state from ogevia.audit_events where action = 'import.rolled_back' and entity_id = $1", [batch]);
    expect(audit).toHaveLength(1); expect(audit[0].after_state).toMatchObject({ records: 2 });
    await expect(db.admin.query("delete from ogevia.import_batch_rollbacks")).rejects.toMatchObject({ code: "OGC09" });
  });
  it("refuses the WHOLE rollback when any imported record has activity, and changes nothing", async () => {
    await imp(w.ownerA, "clients", [{ first_name: "Cora", last_name: "Client", city: "Temecula" }, { first_name: "Dan", last_name: "Client", city: "Corona" }], "clients2", true);
    const batch = (await history())[0].batch_id as string;
    const cora = (await q("select c.id from ogevia.clients c join ogevia.client_private_names n on n.client_id = c.id where n.legal_first_name = 'Cora'"))[0].id as string;
    // activity on ONE imported client: a caregiver is assigned to it
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, w.caregiverA1.userId, cora, w.serviceA, today]);
    await expectPgError(rollback(w.ownerA, batch), "OGC09", /Nothing was changed/);
    expect((await q("select c.status from ogevia.clients c where c.id = $1", [cora]))[0].status).toBe("active");
    expect((await q("select count(*)::int n from ogevia.import_batch_rollbacks where batch_id = $1", [batch]))[0].n).toBe(0);
  });
  it("an untouched clients import rolls back; a manager without the permission cannot", async () => {
    await imp(w.ownerA, "clients", [{ first_name: "Eve", last_name: "Client", city: "Anaheim" }], "clients3", true);
    const batch = (await history())[0].batch_id as string;
    await expectPgError(rollback(w.caregiverA1, batch), "OGA03");
    expect(await rollback(w.ownerA, batch)).toMatchObject({ state: "rolled_back", records: 1 });
    expect((await q("select c.status from ogevia.clients c join ogevia.client_private_names n on n.client_id = c.id where n.legal_first_name = 'Eve'"))[0].status).toBe("inactive");
  });
  it("the replaced import_rows still behaves like 0105: preview writes nothing, the same file twice creates nothing", async () => {
    const before = (await q("select count(*)::int n from ogevia.import_batches"))[0].n;
    const p = await imp(w.ownerA, "people", [{ first_name: "Zed", last_name: "Preview", type: "Caregiver" }], "zed", false);
    expect(p).toMatchObject({ mode: "preview" });
    expect((await q("select count(*)::int n from ogevia.import_batches"))[0].n).toBe(before);
    await imp(w.ownerA, "people", [{ first_name: "Zed", last_name: "Preview", type: "Caregiver" }], "zed", true);
    expect(await imp(w.ownerA, "people", [{ first_name: "Zed", last_name: "Preview", type: "Caregiver" }], "zed", true)).toMatchObject({ mode: "already_imported" });
  });
  it("the down script restores the 0105 function and removes the new objects", async () => {
    await run(P("rollback/0115_import_history_rollback.down.sql"));
    expect((await q("select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('rollback_import_batch','list_import_batches')"))[0].n).toBe(0);
    expect((await q("select count(*)::int n from pg_tables where schemaname = 'ogevia' and tablename in ('import_batch_records','import_batch_rollbacks')"))[0].n).toBe(0);
    expect(await imp(w.ownerA, "people", [{ first_name: "Yan", last_name: "After", type: "Caregiver" }], "yan", true)).toMatchObject({ mode: "applied", created: 1 });
  });
});
