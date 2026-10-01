import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import {
  createTestDb,
  expectPgError,
  seedWorld,
  signedVisit,
  type TestDb,
} from "./harness.js";

const DIR = new URL("../rollback/", import.meta.url);
const downs = readdirSync(DIR)
  .filter((f) => f.endsWith(".down.sql"))
  .sort()
  .reverse();

async function runDown(db: TestDb, file: string) {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    if (!file.startsWith("0001"))
      await client.query("set local role ogevia_owner");
    await client.query(
      readFileSync(new URL(file, DIR), "utf8").replace(
        /delete from ogevia_meta[^;]*;/,
        "",
      ),
    );
    await client.query("reset role");
    await client.query(
      "delete from ogevia_meta.schema_migrations where version = $1",
      [file.slice(0, 4)],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

describe("ROLLBACK scripts", () => {
  let empty: TestDb;
  let populated: TestDb;
  beforeAll(async () => {
    empty = await createTestDb();
    populated = await createTestDb();
    const w = await seedWorld(populated);
    await signedVisit(populated, w.caregiverA1, w, 30);
  });
  afterAll(async () => {
    await empty?.drop();
    await populated?.drop();
  });

  it("has a classified rollback for every migration", () => {
    const ups = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(
      downs
        .slice()
        .reverse()
        .map((f) => f.replace(".down.sql", ".sql")),
    ).toEqual(ups);
    for (const f of downs) {
      expect(readFileSync(new URL(f, DIR), "utf8")).toMatch(
        /CLASS: (SAFE AUTOMATED|BACKUP REQUIRED|FORWARD FIX PREFERRED|IRREVERSIBLE WITHOUT DATA LOSS)/,
      );
    }
  });

  it("round-trips an EMPTY database: down to zero, then up from zero again", async () => {
    for (const f of downs) await runDown(empty, f);
    const { rows } = await empty.admin.query(
      "select count(*)::int as n from pg_namespace where nspname in ('ogevia','ogevia_api')",
    );
    expect(rows[0].n).toBe(0);
    const client = await empty.admin.connect();
    try {
      expect((await migrate(client)).applied).toHaveLength(9);
    } finally {
      client.release();
    }
  });

  it("refuses the destructive rollbacks while real (synthetic) visit data exists", async () => {
    for (const f of [
      "0009_api_context_evidence_read.down.sql",
      "0008_grants.down.sql",
      "0007_reporting_billing_review.down.sql",
      "0006_service_verification_api.down.sql",
    ]) {
      await runDown(populated, f);
    }
    await expectPgError(
      runDown(populated, "0005_service_visits.down.sql"),
      "P0001",
      /Refusing/,
    );
    const { rows } = await populated.admin.query(
      "select count(*)::int as n from ogevia.service_visits",
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
