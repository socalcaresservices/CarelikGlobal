// Scoped removal of confirmed test clients (db/maintenance/test_data_purge.sql), run with the real psql against a real PostgreSQL that carries the
// repository's real protections. It must remove what the database allows, keep what the protections guard, and never bypass a trigger.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL, asActor, createTestDb, seedWorld, type TestDb, type World } from "./harness.js";

const FILE = join(__dirname, "../maintenance/test_data_purge.sql");
let db: TestDb;
let w: World;
let slug = "";
let purgeable: string[] = [];
let protectedIds: string[] = [];

const run = (vars: Record<string, string>) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db.name}`;
  return spawnSync("psql", [u.toString(), "-X", "-q", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", FILE], { encoding: "utf8" });
};
const one = async (sql: string, p: unknown[] = []) => (await db.admin.query(sql, p)).rows[0];
const n = async (sql: string, p: unknown[] = []) => Number((await one(sql, p)).n);
const state = async () => ({
  clients: await n("select count(*) n from ogevia.clients where organization_id = $1", [w.orgA]),
  clientsB: await n("select count(*) n from ogevia.clients where organization_id = $1", [w.orgB]),
  shifts: await n("select count(*) n from ogevia.shifts where organization_id = $1", [w.orgA]),
  assignments: await n("select count(*) n from ogevia.caregiver_assignments where organization_id = $1", [w.orgA]),
  names: await n("select count(*) n from ogevia.client_private_names where organization_id = $1", [w.orgA]),
  auths: await n("select count(*) n from ogevia.client_authorizations where organization_id = $1", [w.orgA]),
  members: await n("select count(*) n from ogevia.organization_memberships where organization_id = $1", [w.orgA]),
  caregivers: await n("select count(*) n from ogevia.caregiver_records where organization_id = $1", [w.orgA]),
  audit: await n("select count(*) n from ogevia.audit_events where organization_id = $1", [w.orgA]),
  triggers: await n("select count(*) n from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal and t.tgenabled = 'O'"),
});

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  slug = (await one("select slug from ogevia.organizations where id = $1", [w.orgA])).slug;
  const cg = (await one("select id from ogevia.caregiver_records where organization_id = $1 limit 1", [w.orgA])).id;
  const mk = async (first: string, last: string) =>
    (await asActor(db, w.managerA.sub, async (c) => (await c.query("select * from ogevia_api.create_client($1, $2, $3)", [w.orgA, first, last])).rows[0])).client_id as string;
  // Two clients with only unprotected records: P1 (name + preparation), P2 (name + shift + assignment).
  const p1 = await mk("Synthetic", "Plain One");
  const p2 = await mk("Synthetic", "Plain Two");
  await db.admin.query("insert into ogevia.client_preparation (client_id, organization_id, stage, updated_by) values ($1, $2, 'draft', $3)", [p1, w.orgA, w.managerA.userId]);
  await db.admin.query("insert into ogevia.shifts (organization_id, client_id, starts_at, ends_at) values ($1, $2, now() + interval '1 day', now() + interval '1 day 2 hours')", [w.orgA, p2]);
  await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, client_id, caregiver_record_id, service_id, effective_start) values ($1, $2, $3, $4, current_date)", [w.orgA, p2, cg, w.serviceA]);
  purgeable = [p1, p2];
  // Protected: every world client of agency A that has an authorization (a financial record that is never deleted).
  protectedIds = (await db.admin.query("select distinct client_id from ogevia.client_authorizations where organization_id = $1", [w.orgA])).rows.map((r) => r.client_id);
  expect(protectedIds.length).toBeGreaterThan(0);
});
afterAll(async () => db?.drop());

describe("scoped test-data removal", () => {
  it("dry run: reports what would be removed and kept, and changes nothing", async () => {
    const before = await state();
    const total = before.clients;
    const r = run({ org_slug: slug, expected_clients: String(total), mode: "dry-run" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(await state()).toEqual(before);
    expect(r.stdout).toMatch(/scope\|clients removed\|(\d+)/);
    expect(Number(r.stdout.match(/scope\|clients removed\|(\d+)/)![1])).toBe(total - protectedIds.length);
    expect(Number(r.stdout.match(/scope\|clients kept[^|]*\|(\d+)/)![1])).toBe(protectedIds.length);
    expect(r.stdout).toContain("protected record (delete-protected table)");
  });

  it("refuses: wrong expected count, apply without the typed confirmation, apply without a snapshot id", async () => {
    const before = await state();
    const total = String(before.clients);
    const wrong = run({ org_slug: slug, expected_clients: String(before.clients + 1), mode: "apply", snapshot_id: "ogevia-prod-postgres-pre-testdata-202610230000", confirm: `PURGE-${slug}-${before.clients + 1}` });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toMatch(/expected_clients/);
    const noConfirm = run({ org_slug: slug, expected_clients: total, mode: "apply", snapshot_id: "ogevia-prod-postgres-pre-testdata-202610230000" });
    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toMatch(/confirm=PURGE/);
    const noSnap = run({ org_slug: slug, expected_clients: total, mode: "apply", confirm: `PURGE-${slug}-${total}` });
    expect(noSnap.status).not.toBe(0);
    expect(noSnap.stderr).toMatch(/snapshot_id/);
    const unknown = run({ org_slug: "no-such-agency", expected_clients: "0" });
    expect(unknown.status).not.toBe(0);
    expect(await state()).toEqual(before);
  });

  it("refuses to run with a delete-protection trigger disabled (there is no bypass)", async () => {
    const before = await state();
    await db.admin.query("alter table ogevia.service_visits disable trigger service_visits_no_delete");
    try {
      const r = run({ org_slug: slug, expected_clients: String(before.clients), mode: "dry-run" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/delete-protection triggers are missing or disabled/);
    } finally {
      await db.admin.query("alter table ogevia.service_visits enable trigger service_visits_no_delete");
    }
    expect(await state()).toEqual(before);
  });

  it("apply: removes the unprotected test clients and their unprotected records; keeps protected clients intact; preserves agency, access, caregivers, audit and protections", async () => {
    const before = await state();
    const total = before.clients;
    const r = run({ org_slug: slug, expected_clients: String(total), mode: "apply", snapshot_id: "ogevia-prod-postgres-pre-testdata-202610230000", confirm: `PURGE-${slug}-${total}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("APPLIED");
    const after = await state();
    // Removable = every client of the agency without a protected child (here: the clients with no authorization), which includes both created above.
    const removed = total - protectedIds.length;
    expect(removed).toBeGreaterThanOrEqual(purgeable.length);
    expect(after.clients).toBe(protectedIds.length);
    for (const id of purgeable) expect(await n("select count(*) n from ogevia.clients where id = $1", [id])).toBe(0);
    expect(await n("select count(*) n from ogevia.shifts where client_id = any($1)", [purgeable])).toBe(0);
    expect(await n("select count(*) n from ogevia.caregiver_assignments where client_id = any($1)", [purgeable])).toBe(0);
    expect(await n("select count(*) n from ogevia.client_preparation where client_id = any($1)", [purgeable])).toBe(0);
    expect(await n("select count(*) n from ogevia.client_private_names where client_id = any($1)", [purgeable])).toBe(0);
    // Protected clients and their authorizations are exactly as before.
    for (const id of protectedIds) expect(await n("select count(*) n from ogevia.clients where id = $1", [id])).toBe(1);
    expect(after.auths).toBe(before.auths);
    // Other agency, access, caregivers and protections untouched; exactly one new audit event, counts only.
    expect(after.clientsB).toBe(before.clientsB);
    expect(after.members).toBe(before.members);
    expect(after.caregivers).toBe(before.caregivers);
    expect(after.triggers).toBe(before.triggers);
    expect(after.audit).toBe(before.audit + 1);
    const ev = await one("select after_state from ogevia.audit_events where organization_id = $1 and action = 'client.test_data_removed'", [w.orgA]);
    expect(ev.after_state).toMatchObject({ clients_removed: removed, clients_kept_protected: protectedIds.length });
    expect(JSON.stringify(ev.after_state)).not.toMatch(/Synthetic|Plain/);
  });

  it("is repeatable: a second run removes nothing and keeps the protected clients", async () => {
    const before = await state();
    const r = run({ org_slug: slug, expected_clients: String(before.clients), mode: "dry-run" });
    expect(r.status, r.stderr).toBe(0);
    expect(Number(r.stdout.match(/scope\|clients removed\|(\d+)/)![1])).toBe(0);
    expect(await state()).toEqual(before);
  });

  it("lists every unprotected table that hangs off a client (a future client-linked table fails this test until the script is reviewed)", async () => {
    const { rows } = await db.admin.query(`
      with recursive fk as (select c.conrelid::regclass::text child, c.confrelid::regclass::text parent from pg_constraint c where c.contype = 'f' and c.connamespace = 'ogevia'::regnamespace),
      tree as (select 'ogevia.clients'::text tbl, array['ogevia.clients']::text[] path
               union all select f.child, t.path || f.child from tree t join fk f on f.parent = t.tbl where not f.child = any(t.path)),
      prot as (select (t.tgrelid::regclass)::text tbl from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'forbid_delete' and not t.tgisinternal),
      guard as (select (t.tgrelid::regclass)::text tbl from pg_trigger t where not t.tgisinternal and t.tgname ~ 'guard|history' and (t.tgtype & 8) = 8)
      select distinct tbl from tree where tbl not in (select tbl from prot) and tbl not in (select tbl from guard) and tbl <> 'ogevia.clients' order by 1`);
    const sql = readFileSync(FILE, "utf8");
    expect(rows.length).toBeGreaterThan(10);
    for (const { tbl } of rows) expect(sql, `${tbl} must be deleted by the script (or be protected)`).toContain(`delete from ${tbl} `);
  });

  it("never disables a trigger or bypasses a protection in its own text", () => {
    const sql = readFileSync(FILE, "utf8").replace(/^\s*--.*$/gm, "");
    expect(sql).not.toMatch(/disable\s+trigger|session_replication_role\s*=|set\s+session_replication_role|alter\s+table|truncate|drop\s+(table|trigger)/i);
  });
});

