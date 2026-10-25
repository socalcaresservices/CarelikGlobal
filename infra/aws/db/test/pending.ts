// PENDING migrations (infra/aws/db/pending): written and tested, not yet part of any release, so NOT applied by `db:migrate`, the release packages or createTestDb().
// A test that needs them creates its database with createTestDbWithPending(). Releasing one means moving it into migrations/ and rollback/ and re-pinning the release package.
import { readdirSync, readFileSync } from "node:fs";
import type { ClientBase } from "pg";
import { createTestDb, type TestDb } from "./harness.js";

const UP = new URL("../pending/migrations/", import.meta.url);
const DOWN = new URL("../pending/rollback/", import.meta.url);
const files = (dir: URL, suffix: string) => readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();

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

/** Applies every pending migration, in order, on top of the released set (no ledger row: a pending migration is not part of a release). */
export async function applyPendingMigrations(client: ClientBase): Promise<string[]> {
  const names = files(UP, ".sql");
  for (const name of names) await run(client, `Pending migration ${name}`, readFileSync(new URL(name, UP), "utf8"));
  return names;
}

/** Runs the pending rollback scripts, newest first. */
export async function rollBackPendingMigrations(client: ClientBase): Promise<string[]> {
  const names = files(DOWN, ".down.sql").reverse();
  for (const name of names) await run(client, `Pending rollback ${name}`, readFileSync(new URL(name, DOWN), "utf8"));
  return names;
}

export async function createTestDbWithPending(): Promise<TestDb> {
  const db = await createTestDb();
  const client = await db.admin.connect();
  try {
    await applyPendingMigrations(client);
  } catch (error) {
    client.release();
    await db.drop();
    throw error;
  }
  client.release();
  return db;
}
