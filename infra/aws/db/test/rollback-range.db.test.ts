// Range rollback runner (0088 down to 0047) and the behavior of the 0047-0088 down scripts on populated (synthetic) data.
// Local PostgreSQL only (OGEVIA_TEST_DATABASE_URL); creates and drops its own databases. Nothing here touches AWS.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { diffFingerprints, fingerprint } from "../scripts/fingerprint.js";
import { loadMigrations, migrate } from "../scripts/migrations.js";
import { MIN_TARGET, rollbackRange, rollbackSetSha } from "../scripts/rollback-range.js";
import { ADMIN_URL, createTestDb, seedWorld, type TestDb } from "./harness.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
const created: (() => Promise<void>)[] = [];
const KEPT_BY_0047 = [
  "column:ogevia.availability_overrides.client_id",
  "column:ogevia.availability_overrides.consumed_at",
  "column:ogevia.availability_overrides.consumed_context",
  "column:ogevia.availability_overrides.original_status",
  "column:ogevia.availability_overrides.shift_id",
  "constraint:ogevia.availability_overrides.availability_overrides_client_fk",
  "constraint:ogevia.availability_overrides.availability_overrides_consumed_shape",
  "constraint:ogevia.availability_overrides.availability_overrides_one_shift",
  "constraint:ogevia.availability_overrides.availability_overrides_original_status",
  "constraint:ogevia.availability_overrides.availability_overrides_shift_id_fkey",
  "index:ogevia.availability_overrides.availability_overrides_shift_idx",
];
afterAll(async () => { for (const d of created) await d(); });

async function connect(db: TestDb): Promise<pg.PoolClient> { return db.admin.connect(); }
const ledger = async (c: pg.ClientBase) => (await c.query<{ n: string; l: string }>("select count(*)::text as n, max(version) as l from ogevia_meta.schema_migrations")).rows[0]!;

/** A database migrated only up to `upTo` (the same steps as the migration runner, including the ledger rows). */
async function dbUpTo(upTo: string): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const name = `ogevia_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect(); await root.query(`create database ${name}`); await root.end();
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  pool.on("error", (e: Error & { code?: string }) => { if (e.code !== "57P01") throw e; });
  const c = await pool.connect();
  try {
    await c.query("create schema if not exists ogevia_meta; create table if not exists ogevia_meta.schema_migrations (version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now(), applied_by text not null default current_user)");
    for (const m of loadMigrations().filter((x) => x.version <= upTo)) {
      await c.query("begin");
      if (!m.runAsAdmin) await c.query("set local role ogevia_owner");
      await c.query(m.sql);
      await c.query("reset role");
      await c.query("insert into ogevia_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)", [m.version, m.name, m.checksum]);
      await c.query("commit");
    }
  } finally { c.release(); }
  const drop = async () => { await pool.end(); const r = new pg.Client({ connectionString: ADMIN_URL }); await r.connect(); await r.query(`drop database if exists ${name} with (force)`); await r.end(); };
  created.push(drop);
  return { pool, drop };
}
async function fullDb(): Promise<TestDb> { const d = await createTestDb(); created.push(() => d.drop()); return d; }

describe("the range rollback runner", () => {
  it("rolls 0088 down to 0047 and the schema equals a database that was only ever migrated to 0046 (functions, constraints, triggers, policies, privileges, table row counts)", async () => {
    const up46 = await dbUpTo("0046");
    const c46 = await up46.pool.connect();
    const f46 = await fingerprint(c46, { data: "counts" });
    c46.release();
    const full = await fullDb();
    const c = await connect(full);
    try {
      expect(await ledger(c)).toEqual({ n: "88", l: "0088" });
      const r = await rollbackRange(c, { target: "0047" });
      expect(r.rolledBack).toHaveLength(42);
      expect(r.rolledBack[0]).toBe("0088");
      expect(r.rolledBack[41]).toBe("0047");
      expect(await ledger(c)).toEqual({ n: "46", l: "0046" });
      const back = await fingerprint(c, { data: "counts" });
      const diff = diffFingerprints(f46, back);
      // The ONE documented exception: the 0047 down script KEEPS the columns, constraints and index it added to availability_overrides ("nullable, harmless",
      // so override history is not lost; see its header). Everything else must equal a database that was only ever migrated to 0046.
      expect(diff, `differences after rollback:\n${diff.join("\n")}`).toEqual(KEPT_BY_0047);
    } finally { c.release(); }
  });

  it("a second migrate after the rollback reproduces the 0088 schema (checksums and ledger agree)", async () => {
    const full = await fullDb();
    const c = await connect(full);
    try {
      const f85 = await fingerprint(c, { data: false });
      await rollbackRange(c, { target: "0047" });
      const res = await migrate(c);
      expect(res.applied).toHaveLength(42);
      expect(await ledger(c)).toEqual({ n: "88", l: "0088" });
      const again = await fingerprint(c, { data: false });
      const diff = diffFingerprints(f85, again);
      expect(diff, `differences after re-migrate:\n${diff.join("\n")}`).toEqual([]);
    } finally { c.release(); }
  });

  it("rolls back only part of the range and leaves the ledger consistent", async () => {
    const full = await fullDb();
    const c = await connect(full);
    try {
      const r = await rollbackRange(c, { target: "0080" });
      expect(r.rolledBack).toEqual(["0088", "0087", "0086", "0085", "0084", "0083", "0082", "0081", "0080"]);
      expect(await ledger(c)).toEqual({ n: "79", l: "0079" });
    } finally { c.release(); }
  });

  it("refuses a target below 0047, an unapplied target, a malformed or wrong set hash, and a gap in the ledger, changing nothing", async () => {
    const full = await fullDb();
    const c = await connect(full);
    try {
      await expect(rollbackRange(c, { target: "0046" })).rejects.toThrow(/target must be 0047 or later/);
      await expect(rollbackRange(c, { target: "0099" })).rejects.toThrow(/no applied migration at or above 0099/);
      await expect(rollbackRange(c, { target: "0047", expectSetSha: "abc" })).rejects.toThrow(/64 hex/);
      await expect(rollbackRange(c, { target: "0047", expectSetSha: "0".repeat(64) })).rejects.toThrow(/not the approved/);
      expect(await ledger(c)).toEqual({ n: "88", l: "0088" });
      await c.query("delete from ogevia_meta.schema_migrations where version = '0060'");
      await expect(rollbackRange(c, { target: "0047" })).rejects.toThrow(/not a contiguous run/);
      expect((await ledger(c)).l).toBe("0088");
      await c.query("insert into ogevia_meta.schema_migrations (version, name, checksum) select '0060', name, checksum from ogevia_meta.schema_migrations where version = '0059'");
    } finally { c.release(); }
  });

  it("accepts the correct set hash and reports it", async () => {
    const full = await fullDb();
    const c = await connect(full);
    try {
      const sha = rollbackSetSha("0083", "0088");
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      const r = await rollbackRange(c, { target: "0083", expectSetSha: sha });
      expect(r.setSha).toBe(sha);
      expect(MIN_TARGET).toBe("0047");
    } finally { c.release(); }
  });
});

describe("the down scripts on populated (synthetic) data", () => {
  async function world() {
    const full = await fullDb();
    const w = await seedWorld(full);
    return { full, w };
  }
  const refused = (e: unknown) => String((e as Error).message);

  it("0053 (SAFE AUTOMATED) refuses while an hour limit exists; the run stops cleanly there and can be repeated after the row is removed", async () => {
    const { full, w } = await world();
    await full.admin.query("insert into ogevia.caregiver_hour_limits (organization_id, max_daily_minutes, updated_by) values ($1, 480, $2)", [w.orgA, w.ownerA.userId]);
    const c = await connect(full);
    try {
      await expect(rollbackRange(c, { target: "0047" })).rejects.toThrow(/ROLLBACK FAILED at 0053/);
      expect(await ledger(c)).toEqual({ n: "53", l: "0053" });
      expect((await c.query("select count(*)::int as n from ogevia.caregiver_hour_limits")).rows[0].n).toBe(1);
      await c.query("delete from ogevia.caregiver_hour_limits");
      const r = await rollbackRange(c, { target: "0047" });
      expect(r.rolledBack[0]).toBe("0053");
      expect(await ledger(c)).toEqual({ n: "46", l: "0046" });
    } finally { c.release(); }
  });

  it("0054 (SAFE AUTOMATED) refuses while a caregiver is in a new stage", async () => {
    const { full, w } = await world();
    await full.admin.query("update ogevia.caregiver_records set status = 'applicant' where id = (select id from ogevia.caregiver_records where organization_id = $1 limit 1)", [w.orgA]);
    const c = await connect(full);
    try {
      await expect(rollbackRange(c, { target: "0047" })).rejects.toThrow(/ROLLBACK FAILED at 0054/);
      expect((await ledger(c)).l).toBe("0054");
    } finally { c.release(); }
  });

  it("0050 (SAFE AUTOMATED) refuses while an agency visit rule exists", async () => {
    const { full, w } = await world();
    await full.admin.query("insert into ogevia.agency_visit_rules (organization_id, version, minutes, effective_from, changed_by) values ($1, 1, 15, current_date, $2)", [w.orgA, w.ownerA.userId]);
    const c = await connect(full);
    try {
      await expect(rollbackRange(c, { target: "0047" })).rejects.toThrow(/ROLLBACK FAILED at 0050/);
      expect((await ledger(c)).l).toBe("0050");
    } finally { c.release(); }
  });

  it("0069 (BACKUP REQUIRED) does NOT refuse: it drops the export ledger together with its rows and keeps no copy", async () => {
    const { full, w } = await world();
    await full.admin.query("insert into ogevia.report_exports (organization_id, report_key, row_count, delivery, exported_by) values ($1, 'monthly_chain', 5, 'browser_assembled', $2)", [w.orgA, w.ownerA.userId]);
    expect((await full.admin.query("select count(*)::int as n from ogevia.report_exports")).rows[0].n).toBe(1);
    const c = await connect(full);
    try {
      let outcome = "";
      try { await rollbackRange(c, { target: "0069" }); outcome = "rolled back"; } catch (e) { outcome = refused(e); }
      expect(outcome, outcome).toBe("rolled back");
      expect((await ledger(c)).l).toBe("0068");
      const gone = await c.query("select to_regclass('ogevia.report_exports') as t");
      expect(gone.rows[0].t).toBeNull();
      const archives = await c.query("select count(*)::int as n from pg_tables where schemaname = 'ogevia' and tablename like 'archived_%'");
      expect(archives.rows[0].n).toBe(0);
    } finally { c.release(); }
  });
});
