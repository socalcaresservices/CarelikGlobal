// Ogevia PostgreSQL migration runner (library). Used by db/scripts/migrate.ts
// and by the test harness, so tests apply exactly what a deploy would.
//
// Rules:
// - Files in db/migrations named NNNN_snake_case.sql, applied in order.
// - Each file runs in ONE transaction. Files must not contain BEGIN/COMMIT.
// - Files run as ogevia_owner (SET LOCAL ROLE) unless their first line is
//   "-- ogevia:run-as=admin" (only 0001: roles, extensions, schemas).
// - ogevia_meta.schema_migrations records version + SHA-256. An applied file
//   whose content changed is drift: the runner refuses to continue.
// - A session advisory lock prevents two runners at once.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { ClientBase } from "pg";

export const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const RUNNER_LOCK_KEY = 4_317_001;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
  readonly runAsAdmin: boolean;
}

export interface MigrationOptions { readonly includePendingUx?: boolean }

export function loadMigrations(options: MigrationOptions = {}): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const released = files.map((name, index) => {
    const match = FILE_PATTERN.exec(name);
    if (!match) throw new Error(`Bad migration file name: ${name}`);
    const version = match[1]!;
    if (Number(version) !== index + 1) {
      throw new Error(
        `Migration numbering gap or duplicate at ${name} (expected ${String(index + 1).padStart(4, "0")})`,
      );
    }
    const sql = readFileSync(new URL(name, MIGRATIONS_DIR), "utf8");
    return {
      version,
      name,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
      runAsAdmin: sql.startsWith("-- ogevia:run-as=admin"),
    };
  });
  if (!options.includePendingUx) return released;
  if (released.length !== 88 || released.at(-1)?.version !== "0088") throw new Error("UX pending set requires the reviewed 0001–0088 baseline");
  const pending = new URL("../pending/migrations/", import.meta.url);
  const names = ["0090_caregiver_signin_override.sql", "0091_caregiver_client_labels.sql", "0092_bulk_import.sql", "0093_staff_duplicates.sql", "0094_standard_document_types.sql"];
  // 0089 was withdrawn, not silently applied or reused. Original bytes/names/checksums are kept.
  return [...released, ...names.map((name) => {
    const sql = readFileSync(new URL(name, pending), "utf8");
    return { version: name.slice(0, 4), name, sql, checksum: createHash("sha256").update(sql).digest("hex"), runAsAdmin: false };
  })];
}

export interface MigrateResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

export async function migrate(
  client: ClientBase,
  log: (line: string) => void = () => {},
  options: MigrationOptions = {},
): Promise<MigrateResult> {
  if (options.includePendingUx) {
    const db = (await client.query<{ name: string }>("select current_database() as name")).rows[0]?.name;
    if (db !== "ogevia_sv_test" && !/^ogevia_test_[0-9a-f]{12}$/.test(db ?? "")) throw new Error("Pending UX migrations are TEST-only; refusing this database");
  }
  const migrations = loadMigrations(options);
  await client.query("select pg_advisory_lock($1)", [RUNNER_LOCK_KEY]);
  try {
    await client.query(`
      create schema if not exists ogevia_meta;
      create table if not exists ogevia_meta.schema_migrations (
        version text primary key,
        name text not null,
        checksum text not null,
        applied_at timestamptz not null default now(),
        applied_by text not null default current_user
      );
    `);
    const { rows } = await client.query<{
      version: string;
      checksum: string;
      name: string;
    }>(
      "select version, checksum, name from ogevia_meta.schema_migrations order by version",
    );
    const applied = new Map(rows.map((r) => [r.version, r]));
    for (const row of rows) {
      if (!migrations.some((m) => m.version === row.version)) {
        throw new Error(
          `Database has migration ${row.version} (${row.name}) that is not in the repository`,
        );
      }
    }

    const result = { applied: [] as string[], alreadyApplied: [] as string[] };
    for (const m of migrations) {
      const existing = applied.get(m.version);
      if (existing) {
        if (existing.checksum !== m.checksum) {
          throw new Error(
            `Drift: migration ${m.name} changed after it was applied (checksum mismatch)`,
          );
        }
        result.alreadyApplied.push(m.name);
        continue;
      }
      log(`applying ${m.name}`);
      await client.query("begin");
      try {
        if (!m.runAsAdmin) await client.query("set local role ogevia_owner");
        await client.query(m.sql);
        await client.query("reset role");
        await client.query(
          "insert into ogevia_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)",
          [m.version, m.name, m.checksum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(
          `Migration ${m.name} failed: ${(error as Error).message}`,
        );
      }
      result.applied.push(m.name);
    }
    await client.query(`
      grant usage on schema ogevia_meta to ogevia_readonly;
      grant select on ogevia_meta.schema_migrations to ogevia_readonly;
    `);
    return result;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [RUNNER_LOCK_KEY]);
  }
}

/** Hosts a runner may target without an explicit owner approval flag. */
export function assertSafeTarget(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  const local = ["127.0.0.1", "localhost", "::1", ""].includes(host);
  if (
    !local &&
    process.env.OGEVIA_ALLOW_REMOTE_MIGRATION !== "approved-by-owner"
  ) {
    throw new Error(
      `Refusing to migrate non-local host ${host}. Applying migrations to AWS is a YELLOW action (CLAUDE.md section 13); set OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner only after written approval.`,
    );
  }
}
