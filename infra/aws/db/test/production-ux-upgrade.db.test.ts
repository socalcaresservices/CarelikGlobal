import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness.js";
import { loadMigrations } from "../scripts/migrations.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDb({ includeLiveTest: true }); });
afterAll(async () => db?.drop());
function sql() {
  const helper = fileURLToPath(new URL("../../scripts/production-ux-release.py", import.meta.url));
  const r = spawnSync(process.env.PYTHON ?? "python3", [helper, "sql", db.name], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}
it("rolls back the whole upgrade when the final ledger insert fails; preserves existing rows", async () => {
  await db.admin.query("create table public.production_ux_sentinel(id integer primary key, value text); insert into public.production_ux_sentinel values (1,'synthetic existing record')");
  const c = await db.admin.connect();
  try {
    await c.query("create function public.reject_ux_ledger() returns trigger language plpgsql as $$ begin if new.version='0107' then raise exception 'synthetic ledger failure'; end if; return new; end $$; create trigger reject_ux_ledger before insert on ogevia_meta.schema_migrations for each row execute function public.reject_ux_ledger()");
    await expect(c.query(sql())).rejects.toThrow(/synthetic ledger failure/);
    await c.query("rollback");
    expect((await c.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n).toBe(102);
    expect((await c.query("select to_regclass('ogevia.caregiver_signin_overrides') t")).rows[0].t).toBeNull();
    expect((await c.query("select value from public.production_ux_sentinel")).rows[0].value).toBe("synthetic existing record");
    await c.query("drop trigger reject_ux_ledger on ogevia_meta.schema_migrations; drop function public.reject_ux_ledger()");
  } finally { c.release(); }
});
it("applies exactly five migrations to 0102, preserves old function columns, and refuses reapply", async () => {
  const c = await db.admin.connect();
  try {
    const before = (await c.query("select pg_get_function_result('ogevia_api.list_assigned_visit_clients(uuid)'::regprocedure) r")).rows[0].r as string;
    await c.query(sql());
    const expected = loadMigrations({ includePendingUx: true }).map(({ version, name, checksum }) => ({ version, name, checksum }));
    expect((await c.query("select version,name,checksum from ogevia_meta.schema_migrations order by version")).rows).toEqual(expected);
    const after = (await c.query("select pg_get_function_result('ogevia_api.list_assigned_visit_clients(uuid)'::regprocedure) r")).rows[0].r as string;
    expect(after).toContain(before.slice(0,-1));
    await expect(c.query(sql())).rejects.toThrow(/Production ledger differs/);
    await c.query("rollback");
    expect((await c.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n).toBe(107);
  } finally { c.release(); }
});
