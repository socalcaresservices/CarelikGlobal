// Executes the PRODUCTION deployment SQL (db/deploy/1x_prd_*.sql) with the real
// psql against the LOCAL disposable cluster, in the order deploy-production.sh
// runs it against RDS: create database -> migrate (existing runner) -> app login
// -> tenant -> administrator -> access verification. Synthetic values only.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTarget, loadMigrations, migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

const DIR = join(__dirname, "../deploy");
const PRD = "ogevia_prd";
const TEST_DB = "ogevia_sv_test";
const PRD_LOGIN = "ogevia_prd_app";
const TEST_LOGIN = `ogevia_test_login_${randomUUID().slice(0, 8)}`;
const PRD_PASSWORD = randomUUID().replace(/-/g, "") + "Aa1"; // synthetic, local only
const TEST_PASSWORD = randomUUID().replace(/-/g, "");
const ADMIN_SUB = randomUUID();
const OTHER_SUB = randomUUID();

const url = (database: string, user?: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  return u.toString();
};
const psqlFile = (database: string, file: string) =>
  execFileSync("psql", [url(database), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", join(DIR, file)], { encoding: "utf8" });
// Variables arrive on stdin exactly as deploy-production.sh sends them (never argv).
const psqlStdin = (database: string, input: string) =>
  spawnSync("psql", [url(database), "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], { encoding: "utf8", input });
const withVars = (vars: Record<string, string>, file: string) =>
  `${Object.entries(vars).map(([k, v]) => `\\set ${k} '${v}'`).join("\n")}\n\\i ${join(DIR, file)}\n`;

async function admin<T>(database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url(database) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function dropAll() {
  await admin("postgres", async (c) => {
    await c.query(`drop database if exists ${PRD} with (force)`);
    await c.query(`drop database if exists ${TEST_DB} with (force)`);
    await c.query(`drop role if exists ${PRD_LOGIN}`);
    await c.query(`drop role if exists ${TEST_LOGIN}`);
  });
}

beforeAll(async () => {
  assertSafeTarget(ADMIN_URL);
  await dropAll();
});
afterAll(dropAll);

describe("production deployment SQL (runbook order)", () => {
  it("uses the existing migration folder and runner: exactly the repository's 36 files", () => {
    const all = loadMigrations();
    expect(all).toHaveLength(36);
    expect(all[0]!.name).toBe("0001_roles_schemas_extensions.sql");
    expect(all[35]!.name).toBe("0036_signature_recovery.sql");
  });

  it("10 creates ogevia_prd, idempotently, and never touches an existing database", async () => {
    psqlFile("postgres", "10_prd_create_database.sql");
    await admin(PRD, (c) => c.query("create table marker_survives_rerun (id int)"));
    psqlFile("postgres", "10_prd_create_database.sql");
    await admin(PRD, async (c) => {
      expect((await c.query("select to_regclass('marker_survives_rerun') as t")).rows[0].t).toBe("marker_survives_rerun");
      await c.query("drop table marker_survives_rerun");
    });
  });

  it("migrations apply with the existing runner, and a rerun applies nothing", async () => {
    const first = await admin(PRD, (c) => migrate(c));
    expect(first.applied).toHaveLength(36);
    const second = await admin(PRD, (c) => migrate(c));
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toHaveLength(36);
  });

  it("11 creates the dedicated login with only ogevia_app membership and CONNECT; idempotent", async () => {
    const script = withVars({ app_user: PRD_LOGIN, app_password: PRD_PASSWORD }, "11_prd_app_login.sql");
    expect(psqlStdin(PRD, script).status).toBe(0);
    expect(psqlStdin(PRD, script).status).toBe(0);
    await admin(PRD, async (c) => {
      const role = (await c.query("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname = $1", [PRD_LOGIN])).rows[0];
      expect(role).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true });
      expect((await c.query("select pg_has_role($1, 'ogevia_app', 'member') as m", [PRD_LOGIN])).rows[0].m).toBe(true);
      expect((await c.query("select has_database_privilege($1, $2, 'CONNECT') as ok", [PRD_LOGIN, PRD])).rows[0].ok).toBe(true);
    });
  });

  it("11 refuses the wrong login name and the wrong database", () => {
    const wrongLogin = psqlStdin(PRD, withVars({ app_user: "ogevia_app", app_password: "x" }, "11_prd_app_login.sql"));
    expect(wrongLogin.status).not.toBe(0);
    const wrongDb = psqlStdin("postgres", withVars({ app_user: PRD_LOGIN, app_password: "x" }, "11_prd_app_login.sql"));
    expect(wrongDb.status).not.toBe(0);
  });

  it("the production login acts as ogevia_app and nothing more", async () => {
    const c = new pg.Client({ connectionString: url(PRD, PRD_LOGIN), password: PRD_PASSWORD });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("set local role ogevia_app");
      await expect(c.query("select count(*) from ogevia.organizations")).rejects.toThrow(/permission denied/);
      await c.query("rollback");
    } finally {
      await c.end();
    }
  });

  it("the TEST slice's application login cannot connect to ogevia_prd", async () => {
    await admin("postgres", async (c) => {
      await c.query(`create database ${TEST_DB}`);
      await c.query(`revoke all on database ${TEST_DB} from public`);
      await c.query(`create role ${TEST_LOGIN} login noinherit password '${TEST_PASSWORD}'`);
      await c.query(`grant ogevia_app to ${TEST_LOGIN}`);
      await c.query(`grant connect on database ${TEST_DB} to ${TEST_LOGIN}`);
    });
    // Control: it does reach its own database...
    const own = new pg.Client({ connectionString: url(TEST_DB, TEST_LOGIN), password: TEST_PASSWORD });
    await own.connect();
    await own.end();
    // ...and is refused by production.
    const prd = new pg.Client({ connectionString: url(PRD, TEST_LOGIN), password: TEST_PASSWORD });
    await expect(prd.connect()).rejects.toThrow(/permission denied for database/);
    // The shared ogevia_app role itself cannot be used to log in at all.
    expect((await admin("postgres", (c) => c.query("select rolcanlogin from pg_roles where rolname = 'ogevia_app'"))).rows[0].rolcanlogin).toBe(false);
  });

  it("12 creates the SoCal Care Services tenant once, with an audit event", async () => {
    psqlFile(PRD, "12_prd_bootstrap_tenant.sql");
    psqlFile(PRD, "12_prd_bootstrap_tenant.sql");
    await admin(PRD, async (c) => {
      const orgs = (await c.query("select display_name, timezone from ogevia.organizations")).rows;
      expect(orgs).toEqual([{ display_name: "SoCal Care Services", timezone: "America/Los_Angeles" }]);
      expect((await c.query("select count(*)::int as n from ogevia.audit_events where action = 'organization.bootstrapped'")).rows[0].n).toBe(1);
      // Production starts with no clients, caregivers or synthetic data.
      expect((await c.query("select (select count(*) from ogevia.clients) + (select count(*) from ogevia.caregiver_records) as n")).rows[0].n).toBe("0");
    });
  });

  it("13 links the administrator as the single organization_owner; idempotent; no second owner", async () => {
    const script = withVars({ admin_sub: ADMIN_SUB, admin_name: "Synthetic Admin" }, "13_prd_bootstrap_admin.sql");
    expect(psqlStdin(PRD, script).status).toBe(0);
    expect(psqlStdin(PRD, script).status).toBe(0);
    await admin(PRD, async (c) => {
      const rows = (await c.query("select m.role, m.status from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = $1", [ADMIN_SUB])).rows;
      expect(rows).toEqual([{ role: "organization_owner", status: "active" }]);
      expect((await c.query("select count(*)::int as n from ogevia.audit_events where action = 'organization.owner_bootstrapped'")).rows[0].n).toBe(1);
      // The administrator can start a request through the application path.
      await c.query("begin");
      await c.query("set local role ogevia_app");
      expect((await c.query("select ogevia_api.begin_request($1) as id", [ADMIN_SUB])).rows[0].id).toBeTruthy();
      await c.query("rollback");
    });
    const second = psqlStdin(PRD, withVars({ admin_sub: OTHER_SUB, admin_name: "" }, "13_prd_bootstrap_admin.sql"));
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already has an active owner/);
  });

  it("13 refuses when the tenant does not exist", async () => {
    await admin(PRD, (c) => c.query("update ogevia.organizations set slug = 'tmp-renamed' where slug = 'socal-care-services'"));
    try {
      const r = psqlStdin(PRD, withVars({ admin_sub: randomUUID(), admin_name: "" }, "13_prd_bootstrap_admin.sql"));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/does not exist; run the tenant bootstrap first/);
    } finally {
      await admin(PRD, (c) => c.query("update ogevia.organizations set slug = 'socal-care-services' where slug = 'tmp-renamed'"));
    }
  });

  it("14 verifies the access model, and fails if PUBLIC regains CONNECT", async () => {
    const ok = psqlStdin(PRD, `\\i ${join(DIR, "14_prd_verify_access.sql")}\n`);
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    await admin("postgres", (c) => c.query(`grant connect on database ${PRD} to public`));
    expect(psqlStdin(PRD, `\\i ${join(DIR, "14_prd_verify_access.sql")}\n`).status).not.toBe(0);
    await admin("postgres", (c) => c.query(`revoke connect on database ${PRD} from public`));
  });

  it("no production deployment SQL contains a password literal", () => {
    for (const f of ["10_prd_create_database.sql", "11_prd_app_login.sql", "12_prd_bootstrap_tenant.sql", "13_prd_bootstrap_admin.sql", "14_prd_verify_access.sql"]) {
      const body = execFileSync("cat", [join(DIR, f)], { encoding: "utf8" });
      expect(body).not.toMatch(/password\s+'[^']+'/i);
    }
  });
});
