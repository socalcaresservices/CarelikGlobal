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
const ux = process.env.OGEVIA_INCLUDE_PENDING_UX;
if (ux && ux !== "test-only") throw new Error("OGEVIA_INCLUDE_PENDING_UX must be test-only or unset");
assertSafeTarget(url);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await migrate(client, (line) => console.log(line), { includePendingUx: ux === "test-only" });
  console.log(
    `applied ${result.applied.length}, already applied ${result.alreadyApplied.length}`,
  );
} finally {
  await client.end();
}
