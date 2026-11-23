// The production migration SQL for 0110 (offices) on a real disposable PostgreSQL that has the production ledger after the 0109 release (108 rows). Nothing here touches AWS.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const h109 = fileURLToPath(new URL("../../scripts/production-0109-release.py", import.meta.url));
const helper = fileURLToPath(new URL("../../scripts/production-offices-release.py", import.meta.url));
let db: TestDb;
const py = (script: string, ...args: string[]) => { const r = spawnSync("python3", [script, ...args], { encoding: "utf8", env: { ...process.env, OGEVIA_UX_SOURCE_ROOT: root } }); expect(r.status, r.stderr).toBe(0); return r.stdout; };
beforeAll(async () => { db = await createTestDb({ includePendingUx: true }); await db.admin.query(py(h109, "sql", db.name)); });   // 107 rows, then the 0109 release: 108 rows
afterAll(async () => db?.drop());
type Q = { query: (s: string) => Promise<{ rows: any[] }> };
const count = async (c: Q) => (await c.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n as number;
const objects = async (c: Q) => (await c.query("select (select count(*)::int from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='ogevia_api' and p.proname in ('create_office','rename_office','retire_office','list_offices','list_client_offices','set_client_office')) + (select count(*)::int from pg_tables where schemaname='ogevia' and tablename='offices') as n")).rows[0].n as number;

it("the fixture is the production state after the 0109 release: 108 ledger rows and none of the 0110 objects", async () => {
  expect(await count(db.admin)).toBe(108); expect(await objects(db.admin)).toBe(0);
});
it("refuses a ledger that is not exactly the 108 rows, without changing anything", async () => {
  const c = await db.admin.connect();
  const good = (await c.query("select checksum from ogevia_meta.schema_migrations where version='0109'")).rows[0].checksum as string;
  try {
    await c.query("update ogevia_meta.schema_migrations set checksum='0000' where version='0109'");
    await expect(c.query(py(helper, "sql", db.name))).rejects.toThrow(/Production ledger differs/);
    await c.query("rollback");
    expect(await objects(c)).toBe(0);
  } finally { await c.query("update ogevia_meta.schema_migrations set checksum=$1 where version='0109'".replace("$1", `'${good}'`)); c.release(); }
});
it("rolls the whole change back when the ledger insert fails", async () => {
  const c = await db.admin.connect();
  try {
    await c.query("create function public.reject_0110_ledger() returns trigger language plpgsql as $$ begin if new.version='0110' then raise exception 'synthetic ledger failure'; end if; return new; end $$");
    await c.query("create trigger reject_0110 before insert on ogevia_meta.schema_migrations for each row execute function public.reject_0110_ledger()");
    await expect(c.query(py(helper, "sql", db.name))).rejects.toThrow(/synthetic ledger failure/);
    await c.query("rollback");
    expect(await count(c)).toBe(108); expect(await objects(c)).toBe(0);
    await c.query("drop trigger reject_0110 on ogevia_meta.schema_migrations; drop function public.reject_0110_ledger()");
  } finally { c.release(); }
});
it("applies 0110 and its ledger row together, adds nothing else, keeps existing clients, and refuses a second run", async () => {
  const fresh = await createTestDb({ includePendingUx: true });
  const c = await fresh.admin.connect();
  try {
    await c.query(py(h109, "sql", fresh.name));
    const before = (await c.query("select count(*)::int n from ogevia.clients")).rows[0].n;
    await c.query(py(helper, "sql", fresh.name));
    expect(await count(c)).toBe(109); expect(await objects(c)).toBe(7);
    expect((await c.query("select version, name, checksum from ogevia_meta.schema_migrations where version='0110'")).rows[0]).toEqual({ version: "0110", name: "0110_offices.sql", checksum: "76dc0f2a8f8e5a080499f7c4514c718c40403ac6772eedbf841a7c22f3597951" });
    expect((await c.query("select count(*)::int n from ogevia.clients")).rows[0].n).toBe(before);
    expect((await c.query("select count(*)::int n from ogevia.clients where responsible_office_id is not null")).rows[0].n).toBe(0);
    await expect(c.query(py(helper, "sql", fresh.name))).rejects.toThrow(/Production ledger differs/);
    await c.query("rollback");
    expect(await count(c)).toBe(109);
    // the pinned rollback removes the objects and the ledger row together
    await c.query(py(helper, "rollback-sql", fresh.name));
    expect(await count(c)).toBe(108); expect(await objects(c)).toBe(0);
    expect((await c.query("select count(*)::int n from information_schema.columns where table_schema='ogevia' and table_name='clients' and column_name='responsible_office_id'")).rows[0].n).toBe(0);
  } finally { c.release(); await fresh.drop(); }
});
