import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ADMIN_URL, createTestDb, type TestDb } from "./harness.js";
import { loadMigrations, migrate } from "../scripts/migrations.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => db?.drop());
it("uses the existing runner to apply UX files once with original checksums; a rerun is harmless and drift fails", async () => {
  const c = await db.admin.connect();
  try {
    const options = { includePendingUx: true };
    expect((await migrate(c, () => {}, options)).applied).toHaveLength(19);
    const rows = (await c.query("select version, name, checksum from ogevia_meta.schema_migrations order by version")).rows;
    expect(rows).toEqual(loadMigrations(options).map(({ version, name, checksum }) => ({ version, name, checksum })));
    expect((await migrate(c, () => {}, options)).applied).toEqual([]);
    await expect(migrate(c)).rejects.toThrow(/not in the repository/);
    await c.query("update ogevia_meta.schema_migrations set checksum = 'changed' where version = '0107'");
    await expect(migrate(c, () => {}, options)).rejects.toThrow(/Drift/);
  } finally { c.release(); }
});
it("refuses non-TEST database names before writing anything", async () => {
  const seen: string[] = [];
  const client = { query: async (sql: string) => { seen.push(sql); return { rows: [{ name: "ogevia_prd" }] }; } };
  await expect(migrate(client as any, () => {}, { includePendingUx: true })).rejects.toThrow(/TEST-only/);
  expect(seen).toEqual(["select current_database() as name"]);
});
it("verifies a NOINHERIT login through the runtime role without granting it direct schema access", async () => {
  const source = readFileSync(new URL("../../../../docs/releases/2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DB.sh", import.meta.url), "utf8");
  const sql = source.match(/LOGIN_OK=.*?-c "([^"]+)"/)?.[1];
  expect(sql).toBeTruthy();
  const role = `ogevia_test_login_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = randomUUID();
  await db.admin.query(`create role ${role} login noinherit password '${password}'`);
  await db.admin.query(`grant ogevia_app to ${role}`);
  const url = new URL(ADMIN_URL); url.pathname = `/${db.name}`; url.username = role; url.password = password;
  const login = new pg.Client({ connectionString: url.toString() });
  const run = async () => {
    const results = await login.query(sql!);
    const list = Array.isArray(results) ? results : [results];
    return list.flatMap((r) => r.rows).map((r) => Object.values(r)[0]);
  };
  try {
    await login.connect();
    expect((await login.query("select has_schema_privilege(current_user, 'ogevia', 'USAGE') as allowed")).rows[0].allowed).toBe(false);
    expect(await run()).toEqual([`${role}|false|true`]);
    expect((await login.query("select current_user as name")).rows[0].name).toBe(role);
    await db.admin.query("revoke execute on function ogevia_api.begin_request(text,uuid) from ogevia_app");
    expect(await run()).toEqual([`${role}|false|false`]);
    await db.admin.query("grant execute on function ogevia_api.begin_request(text,uuid) to ogevia_app");
    await db.admin.query("grant select on ogevia.clients to ogevia_app");
    expect(await run()).toEqual([`${role}|true|true`]);
    await db.admin.query("revoke select on ogevia.clients from ogevia_app");
    expect(await run()).toEqual([`${role}|false|true`]);
  } finally {
    await login.end();
    await db.admin.query("grant execute on function ogevia_api.begin_request(text,uuid) to ogevia_app");
    await db.admin.query("revoke select on ogevia.clients from ogevia_app");
    await db.admin.query(`drop role ${role}`);
  }
});
