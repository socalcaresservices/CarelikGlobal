// CLI: runs every db/verification/*.sql in a READ ONLY transaction and fails
// if any check returns a row whose "ok" column is false.
//   OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:verify
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const url = process.env.OGEVIA_DATABASE_URL;
if (!url) {
  console.error("Set OGEVIA_DATABASE_URL.");
  process.exit(2);
}
export const VERIFICATION_DIR = new URL("../verification/", import.meta.url);
const client = new pg.Client({ connectionString: url });
await client.connect();
let failures = 0;
try {
  for (const file of readdirSync(VERIFICATION_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.query("begin transaction read only");
    try {
      const { rows } = await client.query<{
        check_name: string;
        ok: boolean;
        detail: string | null;
      }>(readFileSync(new URL(file, VERIFICATION_DIR), "utf8"));
      for (const row of rows) {
        if (!row.ok) failures += 1;
        console.log(
          `${row.ok ? "PASS" : "FAIL"} ${file} ${row.check_name}${row.detail ? ` - ${row.detail}` : ""}`,
        );
      }
    } finally {
      await client.query("rollback");
    }
  }
} finally {
  await client.end();
}
process.exit(failures === 0 ? 0 : 1);
