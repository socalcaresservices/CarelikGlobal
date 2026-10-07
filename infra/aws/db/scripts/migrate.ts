// CLI: OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:migrate
// Refuses any non-local host unless OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner.
import pg from "pg";
import { assertSafeTarget, migrate } from "./migrations.js";

const url = process.env.OGEVIA_DATABASE_URL;
if (!url) {
  console.error(
    "Set OGEVIA_DATABASE_URL (credentials come from the environment, never from Git).",
  );
  process.exit(2);
}
assertSafeTarget(url);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await migrate(client, (line) => console.log(line));
  console.log(
    `applied ${result.applied.length}, already applied ${result.alreadyApplied.length}`,
  );
} finally {
  await client.end();
}
