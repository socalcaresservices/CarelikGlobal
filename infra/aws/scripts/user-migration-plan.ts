// DRY RUN ONLY. Usage: pnpm --filter @carelik/infra-aws user-migration:plan <sanitized-export.json>
// Reads a local JSON export (ids, emails, flags; NO passwords), prints the plan
// with hashed emails. Makes no AWS or database call and writes nothing.
import { readFileSync } from "node:fs";
import { planUserMigration, summarize, type MigrationInput } from "../lib/user-migration.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: user-migration-plan <sanitized-export.json>");
  process.exit(2);
}
const rows = planUserMigration(JSON.parse(readFileSync(file, "utf8")) as MigrationInput);
console.log("| SOURCE USER | EMAIL HASH | COGNITO SUB | APP USER | ACTIVE MEMBERSHIPS | ROLES | STATUS | ACTION | ROLLBACK |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  console.log(`| ${r.sourceUserId} | ${r.emailHash} | ${r.cognitoSub ?? "-"} | ${r.appUserId ?? "-"} | ${r.activeMemberships} | ${r.roles.join(", ") || "-"} | ${r.status} | ${r.action} | ${r.rollback} |`);
}
console.log("\nSummary:", JSON.stringify(summarize(rows)));
