// New agencies start empty and isolated, and no deployment path puts demo or test data into production.
// Runs the real deployment SQL with psql and the real API functions, against the LOCAL disposable cluster. Synthetic values only.
//
//  A. production onboarding (db/deploy/12_prd_bootstrap_tenant.sql) creates the organization and NOTHING else;
//  B. the synthetic seeds (02, 03, 04) refuse any database except ogevia_sv_test, and write nothing when refused;
//  C. two newly created agencies each start with no clients, caregivers, authorizations, shifts, visits or documents,
//     and cannot read each other's records once one of them starts working.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTarget, migrate } from "../scripts/migrations.js";
import { ADMIN_URL, asActor, createTestDb, type Actor, type TestDb } from "./harness.js";

const DIR = join(__dirname, "../deploy");
const PRD = "ogevia_prd";

const url = (database: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${database}`;
  return u.toString();
};
const psqlFile = (database: string, file: string, vars: Record<string, string> = {}) =>
  spawnSync("psql", [url(database), "-X", "-q", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", join(DIR, file)], { encoding: "utf8" });

async function admin<T>(database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url(database) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Rows per business table for one organization: every ogevia table with an organization_id column, counted. */
async function rowsByTable(q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>, orgId: string): Promise<Record<string, number>> {
  const { rows: tables } = await q(
    `select table_name from information_schema.columns
      where table_schema = 'ogevia' and column_name = 'organization_id'
        and table_name in (select table_name from information_schema.tables where table_schema = 'ogevia' and table_type = 'BASE TABLE')
      order by table_name`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const r = await q(`select count(*)::int as n from ogevia."${table_name}" where organization_id = $1`, [orgId]);
    out[table_name] = r.rows[0].n;
  }
  return out;
}

// Tables a brand-new agency may legitimately hold rows in: its own membership, audit trail and configuration defaults.
// Everything else (clients, caregivers, authorizations, shifts, visits, documents, ...) must be empty.
const BUSINESS_TABLES = [
  "clients", "client_private_names", "client_preparation", "client_authorizations", "authorization_reservations", "client_service_holds",
  "client_care_portals", "client_documents", "client_document_versions", "caregiver_records", "caregiver_assignments", "caregiver_onboarding_items",
  "staff_documents", "shifts", "care_requests", "service_visits", "visit_confirmations", "visit_evidence", "billing_approvals",
] as const;
/** Every listed table must exist with an organization_id column: a misspelt name fails the test instead of being skipped. */
const expectEmpty = (counts: Record<string, number>, where: string) => {
  for (const t of BUSINESS_TABLES) {
    expect(t in counts, `${t} is not an ogevia table with organization_id (fix the list)`).toBe(true);
    expect(counts[t], `${t} must be empty ${where}`).toBe(0);
  }
};

describe("A/B. production onboarding and the synthetic seeds", () => {
  beforeAll(async () => {
    assertSafeTarget(ADMIN_URL);
    await admin("postgres", async (c) => {
      await c.query(`drop database if exists ${PRD} with (force)`);
      await c.query(`create database ${PRD}`);
    });
    await admin(PRD, (c) => migrate(c));
  });
  afterAll(async () => {
    await admin("postgres", (c) => c.query(`drop database if exists ${PRD} with (force)`));
  });

  it("production tenant bootstrap creates the organization and no clients, caregivers, authorizations, shifts, visits or documents", async () => {
    const r = psqlFile(PRD, "12_prd_bootstrap_tenant.sql");
    expect(r.status, r.stderr).toBe(0);
    await admin(PRD, async (c) => {
      const org = (await c.query("select id from ogevia.organizations where slug = 'socal-care-services'")).rows;
      expect(org).toHaveLength(1);
      const counts = await rowsByTable((sql, p) => c.query(sql, p), org[0].id);
      expectEmpty(counts, "after production onboarding");
      // Only the organization's own audit entry, its own settings and the standard caregiver-onboarding checklist template
      // (background check, clearance, CPR, TB, training: configuration every agency gets) exist for it. No people, no records.
      const populated = Object.entries(counts).filter(([, n]) => n > 0).map(([t]) => t);
      const STARTER_CONFIGURATION = ["audit_events", "onboarding_requirements"];
      expect(populated.every((t) => STARTER_CONFIGURATION.includes(t) || t.startsWith("organization_")), `unexpected populated tables: ${populated}`).toBe(true);
      // And no organization other than the production tenant exists.
      expect((await c.query("select count(*)::int as n from ogevia.organizations")).rows[0].n).toBe(1);
    });
  });

  it("each synthetic seed (02, 03, 04) refuses the production database and writes nothing", async () => {
    const before = await admin(PRD, async (c) => ({
      orgs: (await c.query("select count(*)::int as n from ogevia.organizations")).rows[0].n,
      clients: (await c.query("select count(*)::int as n from ogevia.clients")).rows[0].n,
      caregivers: (await c.query("select count(*)::int as n from ogevia.caregiver_records")).rows[0].n,
      users: (await c.query("select count(*)::int as n from ogevia.app_users")).rows[0].n,
    }));
    const vars = { caregiver_sub: randomUUID(), manager_sub: randomUUID(), caregiver_a_sub: randomUUID(), caregiver_b_sub: randomUUID(), caregiver_a_code: "X", caregiver_b_code: "Y", caregiver_a_first: "A", caregiver_a_last: "A", caregiver_b_first: "B", caregiver_b_last: "B", manager_name: "M" };
    for (const f of ["02_seed_synthetic_test_slice.sql", "03_seed_care_acceptance.sql", "04_seed_scs_pilot_synthetic.sql"]) {
      const r = psqlFile(PRD, f, vars);
      expect(r.status, `${f} must fail in ${PRD}`).not.toBe(0);
      expect(r.stderr, f).toMatch(/Refusing: synthetic seed data is loaded only into ogevia_sv_test/);
    }
    const after = await admin(PRD, async (c) => ({
      orgs: (await c.query("select count(*)::int as n from ogevia.organizations")).rows[0].n,
      clients: (await c.query("select count(*)::int as n from ogevia.clients")).rows[0].n,
      caregivers: (await c.query("select count(*)::int as n from ogevia.caregiver_records")).rows[0].n,
      users: (await c.query("select count(*)::int as n from ogevia.app_users")).rows[0].n,
    }));
    expect(after).toEqual(before);
  });

  it("the seeds still run in the TEST database name (explicit, TEST-only seeding is intact)", async () => {
    const TEST = "ogevia_sv_test";
    await admin("postgres", async (c) => {
      await c.query(`drop database if exists ${TEST} with (force)`);
      await c.query(`create database ${TEST}`);
    });
    try {
      await admin(TEST, (c) => migrate(c));
      const r = psqlFile(TEST, "02_seed_synthetic_test_slice.sql", { caregiver_sub: randomUUID(), manager_sub: randomUUID() });
      expect(r.status, r.stderr).toBe(0);
      expect((await admin(TEST, (c) => c.query("select count(*)::int as n from ogevia.clients"))).rows[0].n).toBeGreaterThan(0);
    } finally {
      await admin("postgres", (c) => c.query(`drop database if exists ${TEST} with (force)`));
    }
  });
});

describe("C. two newly created agencies start empty and cannot see each other", () => {
  let db: TestDb;
  let orgA = "", orgB = "";
  let ownerA: Actor, ownerB: Actor;

  const q = (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
  const adminQ = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

  beforeAll(async () => {
    db = await createTestDb();
    const user = async (name: string): Promise<Actor> => {
      const sub = randomUUID();
      const { rows } = await adminQ("insert into ogevia.app_users (cognito_sub, display_name) values ($1, $2) returning id", [sub, name]);
      return { userId: rows[0].id, sub };
    };
    // The same statements the supported onboarding path uses (organization row + its owner), one per agency.
    const agency = async (slug: string, owner: Actor) => {
      const { rows } = await adminQ("insert into ogevia.organizations (slug, display_name, timezone) values ($1, $1, 'America/Los_Angeles') returning id", [slug]);
      await adminQ("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'organization_owner', 'active')", [rows[0].id, owner.userId]);
      return rows[0].id as string;
    };
    ownerA = await user("Owner A (synthetic)");
    ownerB = await user("Owner B (synthetic)");
    orgA = await agency("new-agency-a", ownerA);
    orgB = await agency("new-agency-b", ownerB);
  });
  afterAll(async () => db?.drop());

  it("neither agency has any clients, caregivers, authorizations, shifts, visits or documents (storage level)", async () => {
    for (const org of [orgA, orgB]) {
      const counts = await rowsByTable(adminQ, org);
      expectEmpty(counts, "in a new agency");
    }
    // Also by link: nothing anywhere in the schema hangs off a client, caregiver record or visit of these agencies.
    const { rows } = await adminQ(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'ogevia' and column_name in ('client_id', 'caregiver_record_id', 'visit_id')
          and table_name in (select table_name from information_schema.tables where table_schema = 'ogevia' and table_type = 'BASE TABLE')`,
    );
    for (const { table_name, column_name } of rows) {
      const n = (await adminQ(`select count(*)::int as n from ogevia."${table_name}"`)).rows[0].n;
      expect(n, `${table_name}.${column_name} rows in a database with only new agencies`).toBe(0);
    }
  });

  it("each agency's own manager sees empty lists through the application API", async () => {
    for (const [owner, org] of [[ownerA, orgA], [ownerB, orgB]] as const) {
      expect(await q(owner, "select * from ogevia_api.list_clients($1)", [org])).toEqual([]);
      expect(await q(owner, "select * from ogevia_api.list_client_directory($1)", [org])).toEqual([]);
      expect(await q(owner, "select * from ogevia_api.list_caregivers($1)", [org])).toEqual([]);
      expect(await q(owner, "select * from ogevia_api.list_shifts($1, '2026-01-01', '2027-12-31')", [org])).toEqual([]);
      expect(await q(owner, "select * from ogevia_api.list_open_shifts($1)", [org])).toEqual([]);
      expect(await q(owner, "select * from ogevia_api.list_shifts_to_reconcile($1)", [org])).toEqual([]);
      expect(await q(owner, "select * from ogevia_api.list_staff_documents($1)", [org])).toEqual([]);
    }
  });

  it("once agency A creates a client, agency B still sees nothing and cannot read A's records", async () => {
    const [{ client_id }] = await q(ownerA, "select * from ogevia_api.create_client($1, 'Synthetic', 'Client One')", [orgA]);
    expect(await q(ownerA, "select * from ogevia_api.list_clients($1)", [orgA])).toHaveLength(1);
    // B's own view is unchanged.
    expect(await q(ownerB, "select * from ogevia_api.list_clients($1)", [orgB])).toEqual([]);
    expect(await q(ownerB, "select * from ogevia_api.list_client_directory($1)", [orgB])).toEqual([]);
    // B addressing A's organization gets nothing back (the API returns no rows to a non-member), for lists and for a direct client lookup.
    expect(await q(ownerB, "select * from ogevia_api.list_clients($1)", [orgA])).toEqual([]);
    expect(await q(ownerB, "select * from ogevia_api.list_client_directory($1)", [orgA])).toEqual([]);
    expect(await q(ownerB, "select * from ogevia_api.list_caregivers($1)", [orgA])).toEqual([]);
    expect(await q(ownerB, "select * from ogevia_api.list_client_authorizations($1, $2)", [orgA, client_id])).toEqual([]);
    // B addressing its own organization with A's client id reveals nothing either.
    expect(await q(ownerB, "select * from ogevia_api.list_client_authorizations($1, $2)", [orgB, client_id])).toEqual([]);
    // A is unaffected and still sees its own client.
    expect(await q(ownerA, "select * from ogevia_api.list_clients($1)", [orgA])).toHaveLength(1);
  });
});

