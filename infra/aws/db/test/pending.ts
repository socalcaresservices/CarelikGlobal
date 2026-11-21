// Staff management (0086, 0087) was PENDING (infra/aws/db/pending) until the readiness release integrated it into the ledger set: the files now live in
// migrations/ and rollback/, so createTestDb() applies them. These helpers keep the old names for the staff tests that roll the staff migrations back and
// re-apply them. Staff is rolled back TOGETHER WITH 0088 (the readiness migration re-creates list_accounts on top of 0087), newest first, and re-applied oldest first.
import { readdirSync, readFileSync } from "node:fs";
import type { ClientBase } from "pg";
import type { MigrationOptions } from "../scripts/migrations.js";
import { createTestDb, type TestDb } from "./harness.js";

const UP = new URL("../migrations/", import.meta.url);
const DOWN = new URL("../rollback/", import.meta.url);
const STAGED = /^(0086_staff_management|0087_staff_invitation_acceptance|0088_caregiver_readiness_approve_for_work)/;
const files = (dir: URL, suffix: string) => readdirSync(dir).filter((f) => f.endsWith(suffix) && STAGED.test(f)).sort();

async function run(client: ClientBase, label: string, sql: string) {
  await client.query("begin");
  try {
    await client.query("set local role ogevia_owner");   // as the real runner: every object is owned by ogevia_owner
    await client.query(sql);
    await client.query("reset role");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw new Error(`${label} failed: ${(error as Error).message}`);
  }
}

/** Re-applies 0086, 0087 and 0088 in order (no ledger row is written: the ledger already holds them). */
export async function applyPendingMigrations(client: ClientBase): Promise<string[]> {
  const names = files(UP, ".sql");
  for (const name of names) await run(client, `Pending migration ${name}`, readFileSync(new URL(name, UP), "utf8"));
  return names;
}

/** Runs the rollback scripts of 0088, 0087 and 0086, newest first. */
export async function rollBackPendingMigrations(client: ClientBase): Promise<string[]> {
  const names = files(DOWN, ".down.sql").reverse();
  for (const name of names) await run(client, `Pending rollback ${name}`, readFileSync(new URL(name, DOWN), "utf8"));
  return names;
}

/** Kept for the staff tests: createTestDb() already includes 0086 and 0087 (and 0088). */
export async function createTestDbWithPending(options: MigrationOptions = {}): Promise<TestDb> {
  return createTestDb(options);
}
