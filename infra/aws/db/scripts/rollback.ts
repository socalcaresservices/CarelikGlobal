// CLI: OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:rollback-readiness [target-version]
// Rolls back the readiness release (0046 down to the target, default 0039) as ONE recorded, restorable attempt. BACKUP REQUIRED.
// Refuses any non-local host unless OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner (a YELLOW action, CLAUDE.md section 13).
import pg from "pg";
import { assertSafeTarget } from "./migrations.js";
import { rollbackReadiness } from "./rollbacks.js";

const url = process.env.OGEVIA_DATABASE_URL;
if (!url) {
  console.error("Set OGEVIA_DATABASE_URL (credentials come from the environment, never from Git).");
  process.exit(2);
}
assertSafeTarget(url);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await rollbackReadiness(client, { target: process.argv[2], log: (line) => console.log(line) });
  console.log(`ATTEMPT ID: ${result.attemptId}`);
} finally {
  await client.end();
}
