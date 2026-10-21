// Ogevia range rollback runner (library) for the releases AFTER the readiness release: 0047 and later.
// Runs the db/rollback/NNNN_*.down.sql scripts newest first, ONE TRANSACTION PER FILE, and removes each file's ledger row inside the same transaction
// (the down scripts do not touch ogevia_meta.schema_migrations). A failing file rolls back its own transaction; files already reverted stay reverted and the
// ledger always matches the schema, so the run can be repeated after the cause is fixed.
// It does NOT archive data: BACKUP REQUIRED scripts drop tables with their rows (ROLLBACK_SCRIPTS_REVIEW_0047_0085.md). The readiness release 0039-0046 has its own
// archiving runner (rollbacks.ts); this runner refuses a target below 0047. A snapshot is a prerequisite and is never restored by this code.
// Refuses: a non-contiguous ledger, a missing down script, a target above the highest applied version, an unexpected rollback-set hash when one is supplied.
// CLI (db/scripts/rollback-to.ts): OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:rollback-to <target-version> [--expect-set-sha <64-hex>]

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { ClientBase } from "pg";

export const ROLLBACK_DIR = new URL("../rollback/", import.meta.url);
const RUNNER_LOCK_KEY = 4_317_001; // the same lock as the migration runner: never both at once
export const MIN_TARGET = "0047";

export interface RangeRollbackResult {
  readonly rolledBack: string[];
  readonly timings: { readonly version: string; readonly ms: number }[];
  readonly setSha: string;
}

function downFiles(): Map<string, string> {
  return new Map(
    readdirSync(ROLLBACK_DIR)
      .map((f) => /^(\d{4})_.+\.down\.sql$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1]!, m[0]] as [string, string]),
  );
}

/** sha256 over the lines "<sha256 of file>  <file name>\n" of the down files target..highest, in version order. The operator package pins this value. */
export function rollbackSetSha(target: string, highest: string): string {
  const downs = downFiles();
  const lines: string[] = [];
  for (let v = Number(target); v <= Number(highest); v++) {
    const key = String(v).padStart(4, "0");
    const file = downs.get(key);
    if (!file) throw new Error(`no rollback script for ${key}`);
    lines.push(`${createHash("sha256").update(readFileSync(new URL(file, ROLLBACK_DIR))).digest("hex")}  ${file}\n`);
  }
  return createHash("sha256").update(lines.join("")).digest("hex");
}

export async function rollbackRange(
  client: ClientBase,
  opts: { target: string; expectSetSha?: string; perFileTimeoutMs?: number; log?: (line: string) => void },
): Promise<RangeRollbackResult> {
  const { target } = opts;
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.perFileTimeoutMs ?? 120_000;
  if (!/^\d{4}$/.test(target) || target < MIN_TARGET) throw new Error(`ROLLBACK REFUSED: the target must be ${MIN_TARGET} or later (the readiness release has its own runner)`);
  if (opts.expectSetSha !== undefined && !/^[0-9a-f]{64}$/.test(opts.expectSetSha)) throw new Error("ROLLBACK REFUSED: the expected rollback-set hash must be 64 hex characters");
  const downs = downFiles();
  await client.query("select pg_advisory_lock($1)", [RUNNER_LOCK_KEY]);
  try {
    const ledger = (await client.query<{ version: string }>("select version from ogevia_meta.schema_migrations where version >= $1 order by version desc", [target])).rows.map((r) => r.version);
    if (ledger.length === 0) throw new Error(`ROLLBACK REFUSED: no applied migration at or above ${target}`);
    const highest = ledger[0]!;
    const expected = Array.from({ length: Number(highest) - Number(target) + 1 }, (_, i) => String(Number(highest) - i).padStart(4, "0"));
    if (ledger.join() !== expected.join()) throw new Error(`ROLLBACK REFUSED: the ledger is not a contiguous run ${target}..${highest}`);
    for (const v of ledger) if (!downs.has(v)) throw new Error(`ROLLBACK REFUSED: no rollback script for ${v}`);
    const setSha = rollbackSetSha(target, highest);
    if (opts.expectSetSha !== undefined && opts.expectSetSha !== setSha) throw new Error(`ROLLBACK REFUSED: the rollback set ${target}..${highest} hashes to ${setSha}, not the approved ${opts.expectSetSha}`);
    log(`rollback set ${target}..${highest} sha256 ${setSha}`);

    const rolledBack: string[] = [];
    const timings: { version: string; ms: number }[] = [];
    for (const v of ledger) {
      const file = downs.get(v)!;
      const sql = readFileSync(new URL(file, ROLLBACK_DIR), "utf8");
      const started = Date.now();
      log(`rolling back ${file}`);
      await client.query("begin");
      try {
        await client.query(`set local statement_timeout = ${Math.floor(timeoutMs)}`);
        await client.query("set local role ogevia_owner");
        await client.query(sql);
        await client.query("reset role");
        const gone = await client.query("delete from ogevia_meta.schema_migrations where version = $1", [v]);
        if (gone.rowCount !== 1) throw new Error(`the ledger row for ${v} was not found`);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`ROLLBACK FAILED at ${v}: ${(error as Error).message}. That file's transaction was rolled back; ${v} and everything below it are still applied; files already reverted stay reverted.`);
      }
      rolledBack.push(v);
      timings.push({ version: v, ms: Date.now() - started });
    }
    return { rolledBack, timings, setSha };
  } finally {
    await client.query("select pg_advisory_unlock($1)", [RUNNER_LOCK_KEY]);
  }
}
