// db/maintenance/test_http_isolation_seed.sql and _retire.sql: the committed synthetic agencies behind the HTTP isolation test, run with the real psql.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTarget, migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

const SEED = join(__dirname, "../maintenance/test_http_isolation_seed.sql");
const RETIRE = join(__dirname, "../maintenance/test_http_isolation_retire.sql");
const TEST = "ogevia_sv_test";
const OTHER = "ogevia_other_isolation";
const url = (database: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
};
const run = (database: string, file: string) => spawnSync("psql", [url(database), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
async function admin<T>(database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url(database) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const tenantRows = (db: string) => admin(db, async (c) => (await c.query(
  `select (select count(*) from ogevia.clients)::int clients, (select count(*) from ogevia.caregiver_records)::int caregivers, (select count(*) from ogevia.client_authorizations)::int auths,
          (select count(*) from ogevia.shifts)::int shifts, (select count(*) from ogevia.organizations where slug ~ '^http-iso-[ab]-')::int orgs`)).rows[0]);

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

describe("HTTP isolation seed and retire (TEST only)", () => {
  it("refuses any database except ogevia_sv_test and changes nothing", async () => {
    for (const file of [SEED, RETIRE]) {
      const r = run(OTHER, file);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Refusing: this runs only in the TEST database ogevia_sv_test");
    }
    expect((await tenantRows(OTHER)).orgs).toBe(0);
  });

  it("commits two new agencies with one active owner each and nothing else, returning one row of ids", async () => {
    const r = run(TEST, SEED);
    expect(r.status).toBe(0);
    const row = r.stdout.split("\n").find((l) => /^[0-9a-f-]{36}\|[0-9a-f-]{36}\|[0-9a-f-]{36}\|[0-9a-f-]{36}$/.test(l));
    expect(row).toBeTruthy();
    const [orgA, subA, orgB, subB] = row!.split("|");
    expect(new Set([orgA, orgB, subA, subB]).size).toBe(4);
    expect(await tenantRows(TEST)).toEqual({ clients: 0, caregivers: 0, auths: 0, shifts: 0, orgs: 2 });
    const owners = await admin(TEST, async (c) => (await c.query(
      `select o.id org, u.cognito_sub sub, m.role::text role, m.status::text status from ogevia.organization_memberships m
         join ogevia.organizations o on o.id = m.organization_id join ogevia.app_users u on u.id = m.user_id where o.slug ~ '^http-iso-[ab]-' order by o.slug`)).rows);
    expect(owners).toEqual([{ org: orgA, sub: subA, role: "organization_owner", status: "active" }, { org: orgB, sub: subB, role: "organization_owner", status: "active" }]);
  });

  it("retire suspends the two agencies and disables their owners, deleting nothing", async () => {
    const r = run(TEST, RETIRE);
    expect(r.status).toBe(0);
    const after = await admin(TEST, async (c) => ({
      orgs: (await c.query(`select status::text s from ogevia.organizations where slug ~ '^http-iso-[ab]-'`)).rows.map((x) => x.s),
      users: (await c.query(`select status from ogevia.app_users where display_name like 'HTTP isolation owner%'`)).rows.map((x) => x.status),
    }));
    expect(after).toEqual({ orgs: ["suspended", "suspended"], users: ["disabled", "disabled"] });
  });
});
