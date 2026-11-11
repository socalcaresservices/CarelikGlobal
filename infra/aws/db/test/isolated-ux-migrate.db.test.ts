import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness.js";
import { loadMigrations, migrate } from "../scripts/migrations.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => db?.drop());
it("uses the existing runner to apply UX files once with original checksums; a rerun is harmless and drift fails", async () => {
  const c = await db.admin.connect();
  try {
    const options = { includePendingUx: true };
    expect((await migrate(c, () => {}, options)).applied).toHaveLength(5);
    const rows = (await c.query("select version, name, checksum from ogevia_meta.schema_migrations order by version")).rows;
    expect(rows).toEqual(loadMigrations(options).map(({ version, name, checksum }) => ({ version, name, checksum })));
    expect((await migrate(c, () => {}, options)).applied).toEqual([]);
    await expect(migrate(c)).rejects.toThrow(/not in the repository/);
    await c.query("update ogevia_meta.schema_migrations set checksum = 'changed' where version = '0094'");
    await expect(migrate(c, () => {}, options)).rejects.toThrow(/Drift/);
  } finally { c.release(); }
});
it("refuses non-TEST database names before writing anything", async () => {
  const seen: string[] = [];
  const client = { query: async (sql: string) => { seen.push(sql); return { rows: [{ name: "ogevia_prd" }] }; } };
  await expect(migrate(client as any, () => {}, { includePendingUx: true })).rejects.toThrow(/TEST-only/);
  expect(seen).toEqual(["select current_database() as name"]);
});
