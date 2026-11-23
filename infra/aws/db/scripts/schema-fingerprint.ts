// READ-ONLY schema fingerprint of ONE database, printed as sorted JSON (object key -> md5; no row content, no data hashes).
//   OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws exec tsx db/scripts/schema-fingerprint.ts > fingerprint.json
// Used for the stabilization schema comparison (docs/stabilization/database-audit.md): run it on a database built from the repository
// migrations and on production (by the owner), then compare the two files with `diff`. The connection is opened read-only.
import pg from "pg";
import { fingerprint } from "./fingerprint.js";

const url = process.env.OGEVIA_DATABASE_URL;
if (!url) { console.error("Set OGEVIA_DATABASE_URL (credentials come from the environment, never from Git)."); process.exit(2); }
const client = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on" });
await client.connect();
try {
  const fp = await fingerprint(client, { data: false });
  const sorted = Object.fromEntries(Object.keys(fp).sort().map((k) => [k, fp[k]]));
  process.stdout.write(JSON.stringify(sorted, null, 1) + "\n");
  console.error(`fingerprint keys: ${Object.keys(sorted).length}`);
} finally { await client.end(); }
