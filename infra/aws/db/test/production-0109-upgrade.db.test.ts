// The production migration SQL for 0109 on a real disposable PostgreSQL that has the accepted 107-row ledger. Nothing here touches AWS.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness.js";
import { loadMigrations } from "../scripts/migrations.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const helper = fileURLToPath(new URL("../../scripts/production-0109-release.py", import.meta.url));
let db: TestDb;
beforeAll(async () => { db = await createTestDb({ includePendingUx: true }); });
afterAll(async () => db?.drop());
function sql(database = db.name) {
  const r = spawnSync("python3", [helper, "sql", database], { encoding: "utf8", env: { ...process.env, OGEVIA_UX_SOURCE_ROOT: root } });
  expect(r.status, r.stderr).toBe(0); return r.stdout;
}
const count = async (c: { query: (s: string) => Promise<{ rows: any[] }> }) => (await c.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n as number;
const objects = async (c: { query: (s: string) => Promise<{ rows: any[] }> }) => (await c.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='ogevia_api' and p.proname in ('cancel_staff_document_request','retire_document_type','mark_staff_care_notifications_read')")).rows[0].n as number;

it("the fixture is the accepted production state: 107 ledger rows and none of the 0109 objects", async () => {
  expect(await count(db.admin)).toBe(107); expect(await objects(db.admin)).toBe(0);
});
it("rolls the whole change back when the ledger insert fails; keeps existing rows", async () => {
  await db.admin.query("create table public.prd0109_sentinel(id integer primary key, value text); insert into public.prd0109_sentinel values (1,'synthetic existing record')");
  const c = await db.admin.connect();
  try {
    await c.query("create function public.reject_0109_ledger() returns trigger language plpgsql as $$ begin if new.version='0109' then raise exception 'synthetic ledger failure'; end if; return new; end $$; create trigger reject_0109 before insert on ogevia_meta.schema_migrations for each row execute function public.reject_0109_ledger()");
    await expect(c.query(sql())).rejects.toThrow(/synthetic ledger failure/);
    await c.query("rollback");
    expect(await count(c)).toBe(107); expect(await objects(c)).toBe(0);
    expect((await c.query("select value from public.prd0109_sentinel")).rows[0].value).toBe("synthetic existing record");
    await c.query("drop trigger reject_0109 on ogevia_meta.schema_migrations; drop function public.reject_0109_ledger()");
  } finally { c.release(); }
});
it("refuses a ledger that is not exactly the accepted 107 rows, without changing anything", async () => {
  const c = await db.admin.connect();
  try {
    await c.query("update ogevia_meta.schema_migrations set checksum='0000' where version='0107'");
    await expect(c.query(sql())).rejects.toThrow(/Production ledger differs/);
    await c.query("rollback");
    expect(await objects(c)).toBe(0);
    await c.query("update ogevia_meta.schema_migrations set checksum=(select checksum from ogevia_meta.schema_migrations where version='0107' limit 1) where false");
  } finally { c.release(); }
});
it("applies 0109 and its ledger row together, as ogevia_owner, and refuses a second run", async () => {
  const fresh = await createTestDb({ includePendingUx: true });
  const c = await fresh.admin.connect();
  try {
    await c.query(sql(fresh.name));
    expect(await count(c)).toBe(108); expect(await objects(c)).toBe(3);
    const expected = loadMigrations({ includePendingUx: true }).map(({ version, name, checksum }) => ({ version, name, checksum }));
    const rows = (await c.query("select version,name,checksum from ogevia_meta.schema_migrations order by version")).rows;
    expect(rows.slice(0, 107)).toEqual(expected);
    expect(rows[107]).toEqual({ version: "0109", name: "0109_request_cleanup.sql", checksum: "2c0ebb9e91e5a88d52f4cd323a82c7b691fb85197c74f80ca98ee774642cd25b" });
    expect((await c.query("select count(*)::int n from pg_proc where proname in ('cancel_staff_document_request','retire_document_type','mark_staff_care_notifications_read') and pg_get_userbyid(proowner)='ogevia_owner'")).rows[0].n).toBe(3);
    await expect(c.query(sql(fresh.name))).rejects.toThrow(/Production ledger differs/);
    await c.query("rollback");
    expect(await count(c)).toBe(108);
  } finally { c.release(); await fresh.drop(); }
});
