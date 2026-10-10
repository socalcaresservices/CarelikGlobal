// Ogevia readiness rollback runner (library). Runs the db/rollback/NNNN_*.down.sql scripts of ONE rollback attempt, newest first,
// in ONE transaction, and records that attempt so its archives can be restored safely later:
//   * a unique ATTEMPT ID (uuid),
//   * a complete MANIFEST with one row per archive slot of the attempt, INCLUDING slots that held zero records (archive_table null),
//     the number of rows each source table held just before the rollback, and the archive table + row count that holds them,
//   * every archive table is tagged (table comment) with the attempt id.
// db/restore/readiness_restore_from_archives.sql restores one attempt id, using only what this manifest names. Archives are never
// grouped by time, so two rollbacks minutes (or seconds) apart can never be mixed.
// Rollbacks that bypass this runner (running a down script by hand) still keep their data in archive tables but are NOT restorable by the script.
// CLI (db/scripts/rollback.ts): OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:rollback-readiness [target-version, default 0039]

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { ClientBase } from "pg";

export const ROLLBACK_DIR = new URL("../rollback/", import.meta.url);
const RUNNER_LOCK_KEY = 4_317_001; // the same lock as the migration runner: never both at once

export interface Slot {
  readonly stem: string; // archive name without the "archived_" prefix and the timestamp, e.g. "caregiver_service_approvals_0040"
  readonly migration: string;
  /** Rows the rollback must archive for this slot, counted just BEFORE the rollback (what the scripts below will find at that point). */
  readonly count: string;
  /** The archive holds the whole table even though `count` counts a subset (scoring rule versions). */
  readonly archiveHoldsWholeTable?: string;
}

/** Every archive slot of 0039-0046. A slot with no rows produces no archive table and is recorded with archive_table = null. */
export const SLOTS: readonly Slot[] = [
  // 0043
  ...["experience_tags", "caregiver_experience", "caregiver_experience_reviews", "client_experience_requirements", "caregiver_zip", "client_service_zip", "zip_centroids"]
    .map((t) => ({ stem: `${t}_0043`, migration: "0043", count: `select count(*) from ogevia.${t}` })),
  { stem: "scoring_rule_versions_0043", migration: "0043", count: "select count(*) from ogevia.scoring_rule_versions where version <> 'v0-provisional-50-25-25'", archiveHoldsWholeTable: "select count(*) from ogevia.scoring_rule_versions" },
  // 0042
  ...["organization_readiness_settings", "readiness_setting_events", "availability_overrides"]
    .map((t) => ({ stem: `${t}_0042`, migration: "0042", count: `select count(*) from ogevia.${t}` })),
  { stem: "shift_series_skipped_dates_0042", migration: "0042", count: "select count(*) from ogevia.shift_series_skipped_dates where reason in ('documents_not_current','service_not_approved','availability_outside','availability_not_provided','client_requirement_not_met')" },
  // 0041
  ...["document_requirement_policies", "document_requirement_policy_history"]
    .map((t) => ({ stem: `${t}_0041`, migration: "0041", count: `select count(*) from ogevia.${t}` })),
  { stem: "document_work_requirements_0041", migration: "0041", count: "select count(*) from ogevia.document_types where work_requirement is not null" },
  { stem: "shift_document_flags_0041", migration: "0041", count: "select count(*) from ogevia.shift_readiness_flags where kind = 'document'" },
  { stem: "assignment_document_flags_0041", migration: "0041", count: "select count(*) from ogevia.assignment_readiness_flags where kind = 'document'" },
  // 0040 (0041's flags are already removed when it runs)
  { stem: "caregiver_service_approvals_0040", migration: "0040", count: "select count(*) from ogevia.caregiver_service_approvals" },
  { stem: "assignment_readiness_flags_0040", migration: "0040", count: "select count(*) from ogevia.assignment_readiness_flags where kind <> 'document'" },
  { stem: "shift_service_flags_0040", migration: "0040", count: "select count(*) from ogevia.shift_readiness_flags where kind = 'service'" },
  // 0039 (0040's and 0041's flags are already removed when it runs)
  ...["availability_requests", "caregiver_availability_state", "caregiver_availability_windows", "caregiver_unavailable_dates"]
    .map((t) => ({ stem: `${t}_0039`, migration: "0039", count: `select count(*) from ogevia.${t}` })),
  { stem: "shift_readiness_flags_0039", migration: "0039", count: "select count(*) from ogevia.shift_readiness_flags where kind not in ('document', 'service')" },
];

export interface ManifestRow {
  readonly stem: string;
  readonly migration: string;
  readonly sourceRows: number;
  readonly archiveTable: string | null;
  readonly archiveRows: number | null;
}
export interface RollbackResult {
  readonly attemptId: string;
  readonly rolledBack: string[];
  readonly manifest: ManifestRow[];
}

const DDL = `
create table if not exists ogevia.readiness_rollback_attempts (
  attempt_id uuid primary key,
  started_at timestamptz not null,
  target_version text not null,
  highest_version text not null,
  slot_count integer not null check (slot_count > 0),
  performed_by text not null
);
create table if not exists ogevia.readiness_rollback_manifest (
  attempt_id uuid not null references ogevia.readiness_rollback_attempts (attempt_id),
  stem text not null,
  migration text not null,
  source_rows bigint not null check (source_rows >= 0),
  archive_table text unique,
  archive_rows bigint,
  primary key (attempt_id, stem),
  constraint manifest_archive_pair check ((archive_table is null) = (archive_rows is null)),
  constraint manifest_rows_have_archive check (source_rows = 0 or archive_table is not null)
);
alter table ogevia.readiness_rollback_attempts enable row level security;
alter table ogevia.readiness_rollback_manifest enable row level security;
revoke all on ogevia.readiness_rollback_attempts, ogevia.readiness_rollback_manifest from public;
`;

const archiveNames = async (client: ClientBase): Promise<string[]> =>
  (await client.query<{ tablename: string }>("select tablename from pg_catalog.pg_tables where schemaname = 'ogevia' and tablename ~ '^archived_.+_[0-9]{4}_[0-9]{14}$'")).rows.map((r) => r.tablename);

export async function rollbackReadiness(client: ClientBase, opts: { target?: string; log?: (line: string) => void } = {}): Promise<RollbackResult> {
  const target = opts.target ?? "0039";
  const log = opts.log ?? (() => {});
  if (!/^\d{4}$/.test(target) || Number(target) < 39) throw new Error("The readiness rollback target must be 0039 or later");
  const downs = new Map(readdirSync(ROLLBACK_DIR).map((f) => /^(\d{4})_.+\.down\.sql$/.exec(f)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[0]]));
  await client.query("select pg_advisory_lock($1)", [RUNNER_LOCK_KEY]);
  try {
    const ledger = (await client.query<{ version: string }>("select version from ogevia_meta.schema_migrations where version >= $1 order by version desc", [target])).rows.map((r) => r.version);
    if (ledger.length === 0) throw new Error(`ROLLBACK REFUSED: no applied migration at or above ${target}`);
    const highest = ledger[0]!;
    const expected = Array.from({ length: Number(highest) - Number(target) + 1 }, (_, i) => String(Number(highest) - i).padStart(4, "0"));
    if (ledger.join() !== expected.join()) throw new Error(`ROLLBACK REFUSED: the ledger is not a contiguous run ${target}..${highest}`);
    for (const v of ledger) if (!downs.has(v)) throw new Error(`ROLLBACK REFUSED: no rollback script for ${v}`);
    const slots = SLOTS.filter((s) => Number(s.migration) >= Number(target) && Number(s.migration) <= Number(highest));
    const attemptId = randomUUID();

    await client.query("begin");
    try {
      await client.query("set local role ogevia_owner");
      await client.query(DDL);
      const before = new Set(await archiveNames(client));
      const sourceRows = new Map<string, number>();
      const wholeRows = new Map<string, number>();
      for (const s of slots) {
        sourceRows.set(s.stem, Number((await client.query<{ count: string }>(s.count)).rows[0]!.count));
        if (s.archiveHoldsWholeTable) wholeRows.set(s.stem, Number((await client.query<{ count: string }>(s.archiveHoldsWholeTable)).rows[0]!.count));
      }
      await client.query(
        "insert into ogevia.readiness_rollback_attempts (attempt_id, started_at, target_version, highest_version, slot_count, performed_by) values ($1, clock_timestamp(), $2, $3, $4, session_user)",
        [attemptId, target, highest, slots.length],
      );
      for (const v of ledger) {
        const file = downs.get(v)!;
        log(`rolling back ${file}`);
        await client.query(readFileSync(new URL(file, ROLLBACK_DIR), "utf8"));
        await client.query("reset role");
        await client.query("delete from ogevia_meta.schema_migrations where version = $1", [v]);
        await client.query("set local role ogevia_owner");
      }
      const created = (await archiveNames(client)).filter((n) => !before.has(n));
      const used = new Set<string>();
      const manifest: ManifestRow[] = [];
      for (const s of slots) {
        const mine = created.filter((n) => new RegExp(`^archived_${s.stem}_[0-9]{14}$`).test(n));
        const rows = sourceRows.get(s.stem)!;
        if (mine.length > 1) throw new Error(`ROLLBACK REFUSED: more than one archive was created for ${s.stem}`);
        if (rows > 0 && mine.length === 0) throw new Error(`ROLLBACK REFUSED: ${s.stem} held ${rows} row(s) but no archive was created`);
        if (rows === 0 && mine.length === 1 && !s.archiveHoldsWholeTable) throw new Error(`ROLLBACK REFUSED: an archive was created for ${s.stem}, which held no rows`);
        let archiveTable: string | null = null;
        let archiveRows: number | null = null;
        if (mine.length === 1) {
          archiveTable = mine[0]!;
          used.add(archiveTable);
          archiveRows = Number((await client.query<{ count: string }>(`select count(*) from ogevia."${archiveTable}"`)).rows[0]!.count);
          const want = wholeRows.get(s.stem) ?? rows;
          if (archiveRows !== want) throw new Error(`ROLLBACK REFUSED: archive ${archiveTable} holds ${archiveRows} row(s), expected ${want}`);
          await client.query(`comment on table ogevia."${archiveTable}" is 'readiness rollback attempt ${attemptId}'`);
        }
        await client.query(
          "insert into ogevia.readiness_rollback_manifest (attempt_id, stem, migration, source_rows, archive_table, archive_rows) values ($1,$2,$3,$4,$5,$6)",
          [attemptId, s.stem, s.migration, rows, archiveTable, archiveRows],
        );
        manifest.push({ stem: s.stem, migration: s.migration, sourceRows: rows, archiveTable, archiveRows });
      }
      const stray = created.filter((n) => !used.has(n));
      if (stray.length) throw new Error(`ROLLBACK REFUSED: unexpected archive table(s) were created: ${stray.join(", ")}`);
      await client.query("reset role");
      await client.query("commit");
      log(`rollback attempt ${attemptId}: ${slots.length} archive slots recorded (${manifest.filter((m) => m.archiveTable).length} archives, ${manifest.filter((m) => !m.archiveTable).length} with zero records)`);
      return { attemptId, rolledBack: ledger, manifest };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [RUNNER_LOCK_KEY]);
  }
}
