// Executes the TEST-SLICE deployment SQL (db/deploy/*.sql) with the real psql
// against the LOCAL disposable cluster, exactly as the runbook does against
// RDS: create database -> migrate -> app login role -> synthetic seed.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTarget, migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

const DIR = join(__dirname, "../deploy");
const DB = "ogevia_sv_test";
const APP_USER = `ogevia_app_login_${randomUUID().slice(0, 8)}`;
const APP_PASSWORD = randomUUID(); // synthetic, local only
const CAREGIVER_SUB = randomUUID();
const MANAGER_SUB = randomUUID();
const PILOT = { manager: randomUUID(), caregiverA: randomUUID(), caregiverB: randomUUID() };
const PILOT_ORG = "5c500000-0000-4000-8000-000000000001";
const TEST_ORG = "7e570000-0000-4000-8000-000000000001";

const url = (database: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
};
const psql = (database: string, file: string, vars: Record<string, string> = {}) =>
  execFileSync("psql", [url(database), "-X", "-q", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", join(DIR, file)], {
    encoding: "utf8",
  });

beforeAll(async () => {
  assertSafeTarget(ADMIN_URL);
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`);
  await root.end();
});

afterAll(async () => {
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`drop database if exists ${DB} with (force)`);
  await root.query(`drop role if exists ${APP_USER}`);
  await root.end();
});

describe("test-slice deployment SQL (runbook order)", () => {
  it("00 creates the separate test database, idempotently", () => {
    psql("postgres", "00_create_test_database.sql");
    psql("postgres", "00_create_test_database.sql");
  });

  it("migrations 0001-0024 apply to it", async () => {
    const client = new pg.Client({ connectionString: url(DB) });
    await client.connect();
    try {
      const result = await migrate(client);
      expect(result.applied).toHaveLength(24);
    } finally {
      await client.end();
    }
  });

  it("01 creates an unprivileged NOINHERIT login in ogevia_app, idempotently", async () => {
    const vars = { app_user: APP_USER, app_password: APP_PASSWORD };
    psql(DB, "01_app_login_role.sql", vars);
    psql(DB, "01_app_login_role.sql", vars);
    const root = new pg.Client({ connectionString: url(DB) });
    await root.connect();
    const { rows } = await root.query(
      "select rolcanlogin, rolinherit, rolsuper, rolbypassrls, pg_has_role($1, 'ogevia_app', 'MEMBER') as member from pg_roles where rolname = $1",
      [APP_USER],
    );
    await root.end();
    expect(rows[0]).toEqual({ rolcanlogin: true, rolinherit: false, rolsuper: false, rolbypassrls: false, member: true });
  });

  it("01 also works when the login IS ogevia_app (the deployed secret's user)", async () => {
    psql(DB, "01_app_login_role.sql", { app_user: "ogevia_app", app_password: APP_PASSWORD });
    psql(DB, "01_app_login_role.sql", { app_user: "ogevia_app", app_password: APP_PASSWORD });
    const appUrl = new URL(url(DB));
    appUrl.username = "ogevia_app";
    appUrl.password = APP_PASSWORD;
    const c = new pg.Client({ connectionString: appUrl.toString() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("set local role ogevia_app");
      await expect(c.query("select * from ogevia.clients")).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback");
    } finally {
      await c.end();
      const root = new pg.Client({ connectionString: url(DB) });
      await root.connect();
      await root.query("alter role ogevia_app nologin password null");
      await root.end();
    }
  });

  it("02 seeds synthetic data idempotently; the caregiver sees exactly the two test clients through the API", async () => {
    const vars = { caregiver_sub: CAREGIVER_SUB, manager_sub: MANAGER_SUB };
    const out = psql(DB, "02_seed_synthetic_test_slice.sql", vars);
    psql(DB, "02_seed_synthetic_test_slice.sql", vars);
    expect(out).toMatch(/2 \|\s+2 \|\s+2/);

    // Connect AS the login role (like the Lambda) and use the API functions.
    // node-postgres: connectionString wins over `user`, so put the login in the URL.
    const appUrl = new URL(url(DB));
    appUrl.username = APP_USER;
    appUrl.password = APP_PASSWORD;
    const asApp = new pg.Client({ connectionString: appUrl.toString() });
    await asApp.connect();
    try {
      expect((await asApp.query("select current_user as u")).rows[0].u).toBe(APP_USER);
      // NOINHERIT: without SET ROLE the login cannot call the API at all.
      await asApp.query("begin");
      await expect(asApp.query("select ogevia_api.begin_request($1, $2)", [CAREGIVER_SUB, randomUUID()])).rejects.toMatchObject({ code: "42501" });
      await asApp.query("rollback");

      await asApp.query("begin");
      await asApp.query("set local role ogevia_app");
      await asApp.query("select ogevia_api.begin_request($1, $2)", [CAREGIVER_SUB, randomUUID()]);
      const me = await asApp.query("select * from ogevia_api.get_my_context()");
      expect(me.rows.map((r) => r.role)).toEqual(["caregiver"]);
      const clients = await asApp.query("select client_code from ogevia_api.list_assigned_visit_clients($1)", [me.rows[0].organization_id]);
      expect(clients.rows.map((r) => r.client_code).sort()).toEqual(["TEST-C01", "TEST-C02"]);
      // And no direct table access.
      await expect(asApp.query("select * from ogevia.clients")).rejects.toMatchObject({ code: "42501" });
      await asApp.query("rollback");
    } finally {
      await asApp.end();
    }
  });

  it("03 seeds a link-only replacement caregiver with availability, idempotently", async () => {
    const out1 = psql(DB, "03_seed_care_acceptance.sql");
    psql(DB, "03_seed_care_acceptance.sql");
    expect(out1).toMatch(/\b7\b/);
    const root = new pg.Client({ connectionString: url(DB) });
    await root.connect();
    const { rows } = await root.query("select count(*)::int n from ogevia.caregiver_availability_windows where caregiver_record_id='7e570000-0000-4000-8000-0000000000b2'");
    const rec = await root.query("select linked_user_id, status from ogevia.caregiver_records where id='7e570000-0000-4000-8000-0000000000b2'");
    await root.end();
    expect(rows[0].n).toBe(7);
    expect(rec.rows[0]).toEqual({ linked_user_id: null, status: "active" });
  });

  it("04 seeds the SCS pilot organization idempotently: individual accounts, own clients only, isolated from the test slice", async () => {
    const vars = {
      manager_sub: PILOT.manager,
      manager_name: "Pilot Manager",
      caregiver_a_sub: PILOT.caregiverA,
      caregiver_a_code: "SCS-CG-A",
      caregiver_a_first: "Pilot",
      caregiver_a_last: "Caregiver A",
      caregiver_b_sub: PILOT.caregiverB,
      caregiver_b_code: "SCS-CG-B",
      caregiver_b_first: "Pilot",
      caregiver_b_last: "Caregiver B",
    };
    const out = psql(DB, "04_seed_scs_pilot_synthetic.sql", vars);
    psql(DB, "04_seed_scs_pilot_synthetic.sql", vars);
    // memberships | caregiver_records | assignments | authorizations
    expect(out).toMatch(/3 \|\s+2 \|\s+4 \|\s+4/);

    const appUrl = new URL(url(DB));
    appUrl.username = APP_USER;
    appUrl.password = APP_PASSWORD;
    const asApp = new pg.Client({ connectionString: appUrl.toString() });
    await asApp.connect();
    const as = async <T>(sub: string, fn: () => Promise<T>) => {
      await asApp.query("begin");
      try {
        await asApp.query("set local role ogevia_app");
        await asApp.query("select ogevia_api.begin_request($1, $2)", [sub, randomUUID()]);
        return await fn();
      } finally {
        await asApp.query("rollback");
      }
    };
    const codes = (sub: string, org: string) =>
      as(sub, async () =>
        (await asApp.query("select client_code from ogevia_api.list_assigned_visit_clients($1)", [org])).rows
          .map((r) => r.client_code)
          .sort(),
      );
    try {
      for (const [sub, role] of [[PILOT.manager, "manager"], [PILOT.caregiverA, "caregiver"], [PILOT.caregiverB, "caregiver"]] as const) {
        const ctx = await as(sub, async () => (await asApp.query("select * from ogevia_api.get_my_context()")).rows);
        expect(ctx.map((r) => [r.organization_id, r.role])).toEqual([[PILOT_ORG, role]]);
      }
      expect(await codes(PILOT.caregiverA, PILOT_ORG)).toEqual(["P-AAXRX", "P-QAUF7"]);
      expect(await codes(PILOT.caregiverB, PILOT_ORG)).toEqual(["P-AHXN7"]);
      expect(await codes(PILOT.manager, PILOT_ORG)).toEqual(["P-AAXRX", "P-AHXN7", "P-QAUF7"]);
      // Neither tenant's accounts see the other's clients.
      expect(await codes(PILOT.manager, TEST_ORG)).toEqual([]);
      expect(await codes(PILOT.caregiverA, TEST_ORG)).toEqual([]);
      expect(await codes(CAREGIVER_SUB, PILOT_ORG)).toEqual([]);
      expect(await codes(MANAGER_SUB, PILOT_ORG)).toEqual([]);
    } finally {
      await asApp.end();
    }
  });
});
