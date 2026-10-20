// CLI: OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:rollback-to <target-version> [--expect-set-sha <64-hex>]
// Rolls the ledger back from its highest version down to <target-version> (0047 or later), one transaction per file. BACKUP REQUIRED scripts drop tables with their rows.
// Refuses any non-local host unless OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner (a YELLOW action, CLAUDE.md section 13).
import pg from "pg";
import { assertSafeTarget } from "./migrations.js";
import { rollbackRange } from "./rollback-range.js";

const url = process.env.OGEVIA_DATABASE_URL;
const target = process.argv[2];
const flag = process.argv[3];
const expectSetSha = flag === "--expect-set-sha" ? process.argv[4] : undefined;
if (!url || !target || (flag !== undefined && flag !== "--expect-set-sha")) {
  console.error("Set OGEVIA_DATABASE_URL (credentials come from the environment, never from Git) and pass <target-version> [--expect-set-sha <64-hex>].");
  process.exit(2);
}
assertSafeTarget(url);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await rollbackRange(client, { target, expectSetSha, log: (line) => console.log(line) });
  console.log(`rolled back ${result.rolledBack.length} migrations: ${result.rolledBack.join(", ")}`);
  console.log(`total ${result.timings.reduce((a, t) => a + t.ms, 0)} ms`);
} finally {
  await client.end();
}
