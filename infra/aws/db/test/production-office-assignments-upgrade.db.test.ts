// The production migration SQL for 0111 + 0112 (office assignments, counties, caregiver colour, assignment history) on a real disposable PostgreSQL that has the production ledger after the Offices release (109 rows). Nothing here touches AWS.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const h109 = fileURLToPath(new URL("../../scripts/production-0109-release.py", import.meta.url));
const h110 = fileURLToPath(new URL("../../scripts/production-offices-release.py", import.meta.url));
const helper = fileURLToPath(new URL("../../scripts/production-office-assignments-release.py", import.meta.url));
let db: TestDb;
const py = (script: string, ...args: string[]) => { const r = spawnSync("python3", [script, ...args], { encoding: "utf8", env: { ...process.env, OGEVIA_UX_SOURCE_ROOT: root } }); expect(r.status, r.stderr).toBe(0); return r.stdout; };
type Q = { query: (s: string) => Promise<{ rows: any[] }> };
const count = async (c: Q) => (await c.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n as number;
const objects = async (c: Q) => (await c.query(`select (select count(*)::int from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='ogevia_api' and p.proname in ('update_office','reactivate_office','set_person_offices','set_client_service_county','set_caregiver_service_counties','set_caregiver_color','list_people_facets','list_assignment_history'))
  + (select count(*)::int from (values ('ogevia.office_assignments'),('ogevia.caregiver_service_counties')) v(t) where to_regclass(t) is not null) n`)).rows[0].n as number;
async function productionAfter0110(d: TestDb) { await d.admin.query(py(h109, "sql", d.name)); await d.admin.query(py(h110, "sql", d.name)); }   // 107 rows -> 108 (0109) -> 109 (0110)
beforeAll(async () => { db = await createTestDb({ includePendingUx: true }); await productionAfter0110(db); });
afterAll(async () => db?.drop());

it("the fixture is the production state after the Offices release: 109 ledger rows (0110 last) and none of the 0111/0112 objects", async () => {
  expect(await count(db.admin)).toBe(109); expect(await objects(db.admin)).toBe(0);
  expect((await db.admin.query("select max(version) v from ogevia_meta.schema_migrations")).rows[0].v).toBe("0110");
});
it("refuses a ledger that is not exactly the 109 rows, without changing anything", async () => {
  const c = await db.admin.connect();
  const good = (await c.query("select checksum from ogevia_meta.schema_migrations where version='0110'")).rows[0].checksum as string;
  try {
    await c.query("update ogevia_meta.schema_migrations set checksum='0000' where version='0110'");
    await expect(c.query(py(helper, "sql", db.name))).rejects.toThrow(/Production ledger differs/);
    await c.query("rollback");
    expect(await objects(c)).toBe(0);
  } finally { await c.query(`update ogevia_meta.schema_migrations set checksum='${good}' where version='0110'`); c.release(); }
});
it("rolls BOTH migrations back when the second ledger insert fails (all or nothing)", async () => {
  const c = await db.admin.connect();
  try {
    await c.query("create function public.reject_0112_ledger() returns trigger language plpgsql as $$ begin if new.version='0112' then raise exception 'synthetic ledger failure'; end if; return new; end $$");
    await c.query("create trigger reject_0112 before insert on ogevia_meta.schema_migrations for each row execute function public.reject_0112_ledger()");
    await expect(c.query(py(helper, "sql", db.name))).rejects.toThrow(/synthetic ledger failure/);
    await c.query("rollback");
    expect(await count(c)).toBe(109); expect(await objects(c)).toBe(0);   // 0111's tables and functions are gone too: the first migration was in the same transaction
    await c.query("drop trigger reject_0112 on ogevia_meta.schema_migrations; drop function public.reject_0112_ledger()");
  } finally { c.release(); }
});
it("applies 0111 and 0112 with their ledger rows together, keeps existing clients and offices, backfills the existing primary office, refuses a second run, and the pinned rollback returns to 109 rows", async () => {
  const fresh = await createTestDb({ includePendingUx: true });
  const c = await fresh.admin.connect();
  try {
    await productionAfter0110(fresh);
    const orgId = (await c.query("insert into ogevia.organizations (slug, display_name, timezone) values ('p-agency','P Agency (synthetic)','America/Los_Angeles') returning id")).rows[0].id as string;
    const user = (await c.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'SYNTHETIC ADMIN') returning id", [randomUUID()])).rows[0].id as string;
    // an office and a client that has it as responsible office BEFORE the release (a verified existing assignment)
    const office = (await c.query("insert into ogevia.offices (organization_id, name, created_by) values ($1,'Existing Office',$2) returning id", [orgId, user])).rows[0].id as string;
    const client = (await c.query("insert into ogevia.clients (organization_id) values ($1) returning id", [orgId])).rows[0].id as string;
    await c.query("update ogevia.clients set responsible_office_id = $1 where id = $2", [office, client]);
    const clientsBefore = (await c.query("select count(*)::int n from ogevia.clients")).rows[0].n;
    await c.query(py(helper, "sql", fresh.name));
    expect(await count(c)).toBe(111); expect(await objects(c)).toBe(10);
    expect((await c.query("select version from ogevia_meta.schema_migrations order by version desc limit 2")).rows.map((r) => r.version)).toEqual(["0112", "0111"]);
    expect((await c.query("select count(*)::int n from ogevia.clients")).rows[0].n).toBe(clientsBefore);
    expect((await c.query("select count(*)::int n from ogevia.offices where name = 'Existing Office'")).rows[0].n).toBe(1);
    expect((await c.query("select office_id, is_primary from ogevia.office_assignments where client_id = $1", [client])).rows).toEqual([{ office_id: office, is_primary: true }]);
    expect((await c.query("select count(*)::int n from ogevia.office_assignments where caregiver_record_id is not null")).rows[0].n).toBe(0);   // nothing is assigned to caregivers: they start Unassigned
    await expect(c.query(py(helper, "sql", fresh.name))).rejects.toThrow(/Production ledger differs/);
    await c.query("rollback");
    expect(await count(c)).toBe(111);
    await c.query(py(helper, "rollback-sql", fresh.name));
    expect(await count(c)).toBe(109); expect(await objects(c)).toBe(0);
    expect((await c.query("select responsible_office_id from ogevia.clients where id = $1", [client])).rows[0].responsible_office_id).toBe(office);   // the primary office stays
  } finally { c.release(); await fresh.drop(); }
});
