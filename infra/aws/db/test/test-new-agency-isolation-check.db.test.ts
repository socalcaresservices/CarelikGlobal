// db/maintenance/test_new_agency_isolation_check.sql: the TEST-database check for new agencies, run with the real psql against a real PostgreSQL.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTarget, migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

const FILE = join(__dirname, "../maintenance/test_new_agency_isolation_check.sql");
const TEST = "ogevia_sv_test";
const OTHER = "ogevia_other_check";
const url = (database: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
};
const run = (database: string) => spawnSync("psql", [url(database), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", FILE], { encoding: "utf8" });
async function admin<T>(database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url(database) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const counts = (db: string) => admin(db, async (c) => (await c.query(
  `select (select count(*) from ogevia.organizations)::int o, (select count(*) from ogevia.app_users)::int u, (select count(*) from ogevia.clients)::int c,
          (select count(*) from ogevia.audit_events)::int a, (select count(*) from ogevia.organization_memberships)::int m`)).rows[0]);

beforeAll(async () => {
  assertSafeTarget(ADMIN_URL);
  for (const db of [TEST, OTHER]) {
    await admin("postgres", async (c) => {
      await c.query(`drop database if exists ${db} with (force)`);
      await c.query(`create database ${db}`);
    });
    await admin(db, (c) => migrate(c));
  }
});
afterAll(async () => {
  await admin("postgres", async (c) => {
    for (const db of [TEST, OTHER]) await c.query(`drop database if exists ${db} with (force)`);
  });
});

describe("TEST new-agency emptiness and isolation check", () => {
  it("passes all three checks and leaves nothing behind (rolled back)", async () => {
    const before = await counts(TEST);
    const r = run(TEST);
    expect(r.status, r.stderr).toBe(0);
    for (const p of ["PASS 1:", "PASS 2:", "PASS 3:"]) expect(r.stderr, p).toContain(p);
    expect(r.stdout).toContain("ROLLED BACK");
    expect(r.stdout.trim().split("\n").pop()).toBe("0"); // verification_agencies_left_behind
    expect(await counts(TEST)).toEqual(before);
  });

  it("refuses any database other than ogevia_sv_test and changes nothing", async () => {
    const before = await counts(OTHER);
    const r = run(OTHER);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Refusing: this check runs only in the TEST database/);
    expect(await counts(OTHER)).toEqual(before);
  });

  it("DETECTS automatic demo data: a trigger that creates a client for every new organization fails check 1", async () => {
    await admin(TEST, async (c) => {
      await c.query(`create function ogevia.zz_demo_seed() returns trigger language plpgsql as $$ begin
        insert into ogevia.clients (organization_id, client_code) values (new.id, 'DEMO-' || substr(md5(random()::text), 1, 6)); return new; end $$`);
      await c.query("create trigger zz_demo_seed after insert on ogevia.organizations for each row execute function ogevia.zz_demo_seed()");
    });
    try {
      const r = run(TEST);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/CHECK FAILED: a new agency has 1 rows in clients/);
    } finally {
      await admin(TEST, async (c) => {
        await c.query("drop trigger zz_demo_seed on ogevia.organizations");
        await c.query("drop function ogevia.zz_demo_seed()");
      });
    }
    expect((await counts(TEST)).c).toBe(0); // the failed run rolled back; no demo client remains
  });

  it("stops with NOT RUN when the master cannot assume the application role (no weaker fallback)", async () => {
    const role = "ogevia_check_nomember";
    await admin("postgres", async (c) => {
      await c.query(`drop role if exists ${role}`);
      await c.query(`create role ${role} login password 'x' createrole`);
    });
    try {
      await admin(TEST, async (c) => {
        await c.query(`grant all on schema ogevia to ${role}`);
        await c.query(`grant all on all tables in schema ogevia to ${role}`);
        await c.query(`grant all on schema ogevia_api to ${role}`);
        await c.query(`grant execute on all functions in schema ogevia_api to ${role}`);
      });
      const u = new URL(url(TEST));
      u.username = role;
      u.password = "x";
      const r = spawnSync("psql", [u.toString(), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", FILE], { encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/NOT RUN: the database master cannot assume the application role/);
    } finally {
      await admin(TEST, async (c) => {
        await c.query(`revoke all on all tables in schema ogevia from ${role}`);
        await c.query(`revoke all on schema ogevia from ${role}`);
        await c.query(`revoke execute on all functions in schema ogevia_api from ${role}`);
        await c.query(`revoke all on schema ogevia_api from ${role}`);
      });
      await admin("postgres", (c) => c.query(`drop role if exists ${role}`));
    }
  });
});

