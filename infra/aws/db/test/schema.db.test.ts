import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrate } from "../scripts/migrations.js";
import {
  createTestDb,
  expectPgError,
  seedWorld,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
});
afterAll(async () => db?.drop());

const q = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) => (await db.admin.query(sql, params)).rows as T[];

describe("SCHEMA: migration chain", () => {
  it("migrates a clean empty database to the full target from zero, in order", async () => {
    const rows = await q<{ version: string; name: string }>(
      "select version, name from ogevia_meta.schema_migrations order by version",
    );
    expect(rows.map((r) => r.name)).toEqual(
      loadMigrations().map((m) => m.name),
    );
    expect(rows.map((r) => r.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
      "0014",
      "0015",
      "0016",
      "0017",
      "0018",
      "0019",
      "0020",
      "0021",
    ]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const client = await db.admin.connect();
    try {
      const result = await migrate(client);
      expect(result.applied).toEqual([]);
      expect(result.alreadyApplied).toHaveLength(loadMigrations().length);
    } finally {
      client.release();
    }
  });

  it("detects drift when an applied migration's checksum changes", async () => {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query(
        "update ogevia_meta.schema_migrations set checksum = 'tampered' where version = '0005'",
      );
      await expect(migrate(client)).rejects.toThrow(/Drift: migration 0005/);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("has every required table", async () => {
    const tables = (
      await q<{ t: string }>(
        "select tablename as t from pg_tables where schemaname = 'ogevia' order by 1",
      )
    ).map((r) => r.t);
    expect(tables).toEqual([
      "app_users",
      "audit_events",
      "authorization_reservations",
      "billing_approvals",
      "care_notifications",
      "care_request_alert_recipients",
      "care_request_events",
      "care_request_offers",
      "care_requests",
      "caregiver_assignments",
      "caregiver_availability_windows",
      "caregiver_records",
      "caregiver_unavailable_dates",
      "client_authorizations",
      "client_care_portals",
      "clients",
      "document_types",
      "document_versions",
      "idempotency_records",
      "organization_memberships",
      "organizations",
      "permissions",
      "role_permissions",
      "service_visits",
      "services",
      "shift_coverage_events",
      "shifts",
      "staff_documents",
      "visit_confirmations",
      "visit_corrections",
      "visit_evidence",
    ]);
  });

  it("keeps the current-main status vocabularies exactly", async () => {
    const enumValues = async (t: string) =>
      (
        await q<{ v: string }>(
          "select e.enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'ogevia' and t.typname = $1 order by e.enumsortorder",
          [t],
        )
      ).map((r) => r.v);
    expect(await enumValues("service_visit_status")).toEqual([
      "draft",
      "awaiting_signature",
      "signed",
      "administrator_review",
      "corrected",
      "voided",
    ]);
    expect(await enumValues("visit_authorization_status")).toEqual([
      "within_authorization",
      "limit_reached",
      "exceeds_authorization",
      "administrator_override",
    ]);
    expect(await enumValues("visit_signer_role")).toEqual([
      "client",
      "parent",
      "guardian",
      "authorized_representative",
    ]);
  });

  it("has the integrity constraints and indexes the invariants depend on", async () => {
    const constraints = (
      await q<{ c: string }>(
        "select conname as c from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'ogevia'",
      )
    ).map((r) => r.c);
    for (const name of [
      "client_authorizations_one_current_per_coverage",
      "service_visits_time_check",
      "service_visits_worked_range",
      "service_visits_billable_le_worked",
      "service_visits_locked_shape",
      "service_visits_voided_shape",
      "visit_evidence_key_shape",
      "visit_confirmations_method_evidence",
      "visit_confirmations_visit_id_key",
      "visit_corrections_original_visit_id_key",
    ]) {
      expect(constraints, name).toContain(name);
    }
    const indexes = (
      await q<{ i: string }>(
        "select indexname as i from pg_indexes where schemaname = 'ogevia'",
      )
    ).map((r) => r.i);
    for (const name of [
      "service_visits_one_open_per_caregiver_user",
      "service_visits_one_open_per_caregiver_record",
      "service_visits_shift_unique",
      "client_authorizations_current_lookup_idx",
      "service_visits_authorization_date_idx",
      "service_visits_org_status_idx",
      "caregiver_assignments_lookup_idx",
    ]) {
      expect(indexes, name).toContain(name);
    }
  });
});

describe("SECURITY: least-privilege roles", () => {
  it("gives the runtime role no table privileges and no superuser/owner status", async () => {
    expect(
      await q(
        "select 1 from information_schema.role_table_grants where grantee = 'ogevia_app'",
      ),
    ).toEqual([]);
    const [role] = await q<{
      rolsuper: boolean;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
    }>(
      "select rolsuper, rolcanlogin, rolbypassrls from pg_roles where rolname = 'ogevia_app'",
    );
    expect(role).toEqual({
      rolsuper: false,
      rolcanlogin: false,
      rolbypassrls: false,
    });
    const owners = await q<{ o: string }>(
      "select distinct pg_get_userbyid(relowner) as o from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('ogevia','ogevia_api')",
    );
    expect(owners.map((r) => r.o)).toEqual(["ogevia_owner"]);
  });

  it("exposes no function to PUBLIC and pins search_path on every function", async () => {
    expect(
      await q(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('ogevia','ogevia_api')
         and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`,
      ),
    ).toEqual([]);
    expect(
      await q(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('ogevia','ogevia_api')
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
      ),
    ).toEqual([]);
  });

  it("denies the runtime role direct reads and writes on every table", async () => {
    const client = await db.admin.connect();
    try {
      for (const sql of [
        "select * from ogevia.service_visits",
        "select * from ogevia.clients",
        `update ogevia.client_authorizations set monthly_authorized_minutes = 99999`,
        `insert into ogevia.audit_events (organization_id, action, entity_type) values ('${w.orgA}', 'x', 'y')`,
        "delete from ogevia.visit_confirmations",
      ]) {
        await client.query("begin");
        await client.query("set local role ogevia_app");
        await expectPgError(client.query(sql), "42501");
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  });

  it("rejects API calls without a resolved identity", async () => {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query("set local role ogevia_app");
      await expectPgError(
        client.query(
          "select * from ogevia_api.list_assigned_visit_clients($1)",
          [w.orgA],
        ),
        "OGA01",
      );
      await client.query("rollback");
      await client.query("begin");
      await client.query("set local role ogevia_app");
      await expectPgError(
        client.query("select ogevia_api.begin_request($1)", [
          "00000000-0000-0000-0000-000000000000",
        ]),
        "OGA01",
      );
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("forgets the actor when the transaction ends (pooled connection safety)", async () => {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query("set local role ogevia_app");
      await client.query("select ogevia_api.begin_request($1)", [
        w.caregiverA1.sub,
      ]);
      await client.query("commit");
      const { rows } = await client.query(
        "select current_setting('ogevia.actor_user_id', true) as a",
      );
      expect(rows[0].a ?? "").toBe("");
    } finally {
      client.release();
    }
  });

  it("enables row level security on every ogevia table", async () => {
    expect(
      await q(
        "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ogevia' and c.relkind = 'r' and not c.relrowsecurity and relname not in ('permissions','role_permissions')",
      ),
    ).toEqual([]);
  });

  it("never stores signature image bytes: no bytea column exists", async () => {
    expect(
      await q(
        "select table_name, column_name from information_schema.columns where table_schema = 'ogevia' and data_type = 'bytea'",
      ),
    ).toEqual([]);
  });
});

describe("SCHEMA: fresh second database (independent from-zero proof)", () => {
  it("migrates another empty database identically", async () => {
    const other = await createTestDb();
    try {
      const a = await q<{ name: string; checksum: string }>(
        "select name, checksum from ogevia_meta.schema_migrations order by 1",
      );
      const b = (
        await other.admin.query(
          "select name, checksum from ogevia_meta.schema_migrations order by 1",
        )
      ).rows;
      expect(b).toEqual(a);
    } finally {
      await other.drop();
    }
  });
});
