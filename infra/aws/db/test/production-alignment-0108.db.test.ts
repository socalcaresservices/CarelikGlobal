// Proposed migration 0108 (infra/aws/db/pending/production-alignment): it states, and verifies, the two manual PRODUCTION fixes of 2026-11-14 so the repository matches production.
//   * ogevia_owner may SELECT ogevia.business_documents (policy owner_definer_select) and EXECUTE ogevia.action_issue_rows.
// Three databases are built and the migration is run against each:
//   FRESH       the repository's own migrations 0001-0107: ogevia_owner owns everything, so the fixes are no-ops (apart from the policy, for parity);
//   PRODUCTION  the live baseline plus the real production upgrade SQL, then the production ownership drift (ogevia_admin owns the four tables and the 17 functions that production lists),
//               which reproduces the 2026-11-14 errors; once WITHOUT the fixes and once WITH them applied exactly as recorded;
// The point of the test is the migration's behaviour: idempotent where the fixes exist, fail-closed where the runner cannot grant, and never overwriting a different policy. SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type TestDb, type World } from "./harness.js";

const UP = readFileSync(new URL("../pending/production-alignment/0108_production_database_alignment.sql", import.meta.url), "utf8");
const DOWN = readFileSync(new URL("../pending/production-alignment/0108_production_database_alignment.down.sql", import.meta.url), "utf8");
const CAPTURE = fileURLToPath(new URL("../../../../docs/releases/2026-11-15-db-fixes-migration/CAPTURE_LIVE_DB_FIXES.sql", import.meta.url));
const FN = "ogevia.action_issue_rows(uuid,boolean,boolean,boolean,boolean,boolean,integer)";
const TABLES = ["business_document_files", "business_documents", "client_qr_cards", "missing_visit_reason_labels"];
// The 17 functions production lists as owned by ogevia_admin (schema, name; record_missing_scheduled_visit has two overloads).
const ADMIN_FUNCTIONS = [["ogevia", "action_issue_rows"], ["ogevia", "start_service_visit"], ["ogevia_api", "client_qr_checkin"], ["ogevia_api", "list_business_document_files"],
  ["ogevia_api", "list_business_documents"], ["ogevia_api", "list_expiring_authorization_hours"], ["ogevia_api", "list_missing_scheduled_visits"], ["ogevia_api", "list_missing_visit_reason_labels"],
  ["ogevia_api", "manage_client_qr"], ["ogevia_api", "open_business_document_file"], ["ogevia_api", "record_missing_scheduled_visit"], ["ogevia_api", "register_business_document_file"],
  ["ogevia_api", "save_business_document"], ["ogevia_api", "set_caregiver_zip"], ["ogevia_api", "set_client_service_zip"], ["ogevia_api", "suggest_matching_city"]];

const dbs: TestDb[] = [];
afterAll(async () => { for (const d of dbs) await d.drop(); });

/** Run SQL as `role` in one transaction (the way the runner wraps a migration); throws on failure and leaves nothing behind. */
async function asRole<T = any>(db: TestDb, role: string | null, sql: string): Promise<T[]> {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    if (role) await c.query(`set local role ${role}`);
    const r = await c.query(sql);
    await c.query("commit");
    return ((Array.isArray(r) ? r.at(-1)?.rows : r.rows) ?? []) as T[];
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
/** Everything the migration can touch, as data: the table's owner and ACL, every policy, the function's owner and ACL. */
async function snapshot(db: TestDb) {
  const q = async (sql: string) => (await db.admin.query(sql)).rows;
  return {
    table: await q("select pg_get_userbyid(relowner) o, relacl::text acl, relrowsecurity rls from pg_class where oid = 'ogevia.business_documents'::regclass"),
    policies: await q("select polname, polcmd, polpermissive, polroles::regrole[]::text roles, pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) c from pg_policy where polrelid = 'ogevia.business_documents'::regclass order by polname"),
    fn: await q(`select pg_get_userbyid(proowner) o, proacl::text acl from pg_proc where oid = '${FN}'::regprocedure`),
    effective: await q(`select has_table_privilege('ogevia_owner','ogevia.business_documents','SELECT') sel, has_function_privilege('ogevia_owner','${FN}'::regprocedure,'EXECUTE') exe`),
  };
}
const upgradeSql = (name: string) => { const r = spawnSync("python3", [fileURLToPath(new URL("../../scripts/production-ux-release.py", import.meta.url)), "sql", name], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); return r.stdout; };

async function freshDb() { const db = await createTestDb({ includeLiveTest: true, includePendingUx: true }); dbs.push(db); return db; }

/** Production as it was on 2026-11-14: live baseline, the real production upgrade, then the ownership drift. fixes=false is before the manual fixes, fixes=true after them exactly as recorded. */
async function productionDb(fixes: boolean): Promise<{ db: TestDb; w: World }> {
  const db = await createTestDb({ includeLiveTest: true }); dbs.push(db);
  const c = await db.admin.connect(); try { await c.query(upgradeSql(db.name)); } finally { c.release(); }
  const w = await seedWorld(db, 700 + dbs.length * 7);
  await db.admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='ogevia_admin') then create role ogevia_admin nologin bypassrls; end if; end $$; grant ogevia_owner to ogevia_admin;`);
  for (const t of TABLES) await db.admin.query(`alter table ogevia.${t} owner to ogevia_admin`);
  for (const [schema, name] of ADMIN_FUNCTIONS) {
    for (const row of (await db.admin.query("select p.oid::regprocedure::text as f from pg_proc p where p.pronamespace = $1::regnamespace and p.proname = $2", [schema, name])).rows) await db.admin.query(`alter function ${row.f} owner to ogevia_admin`);
  }
  if (fixes) {
    // exactly the statements of PRODUCTION_DB_CHANGES_2026-11-14.md
    await asRole(db, null, `begin; set local role ogevia_admin; grant select on ogevia.business_documents to ogevia_owner; drop policy if exists owner_definer_select on ogevia.business_documents;
      create policy owner_definer_select on ogevia.business_documents for select to ogevia_owner using (true); reset role; commit;`).catch(async () => {
      await db.admin.query(`set role ogevia_admin; grant select on ogevia.business_documents to ogevia_owner; drop policy if exists owner_definer_select on ogevia.business_documents;
        create policy owner_definer_select on ogevia.business_documents for select to ogevia_owner using (true); reset role;`);
    });
    await db.admin.query(`grant execute on function ${FN} to ogevia_owner`);
  }
  return { db, w };
}
const compliance = (db: TestDb) => asRole(db, "ogevia_app", "select count(*)::int n from ogevia_api.system_compliance_orgs()");
const notifications = (db: TestDb, w: World) => asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.list_my_notifications($1,false,30) r", [w.orgA])).rows);
const attention = (db: TestDb, w: World) => asActor(db, w.ownerA.sub, async (c) => (await c.query("select ogevia_api.get_attention_counts($1) c", [w.orgA])).rows);
const capture = (db: TestDb) => {
  const url = new URL(process.env.OGEVIA_TEST_DATABASE_URL!); url.pathname = `/${db.name}`;
  const r = spawnSync("psql", ["-X", "-q", url.toString(), "-v", "ON_ERROR_STOP=1", "-v", `expected_db=${db.name}`, "-f", CAPTURE], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0); return r.stdout;
};

describe("a database built from the repository (ogevia_owner owns everything)", () => {
  it("applies cleanly as the runner does, changes no privilege, adds only the policy, and is idempotent", async () => {
    const db = await freshDb(); const before = await snapshot(db);
    expect(before.policies).toEqual([]);
    expect(before.effective[0]).toEqual({ sel: true, exe: true });
    await asRole(db, "ogevia_owner", UP);
    const after = await snapshot(db);
    expect(after.table).toEqual(before.table); expect(after.fn).toEqual(before.fn);        // ACLs untouched
    expect(after.policies).toEqual([{ polname: "owner_definer_select", polcmd: "r", polpermissive: true, roles: "{ogevia_owner}", q: "true", c: null }]);
    await asRole(db, "ogevia_owner", UP);                                                   // again: nothing changes
    expect(await snapshot(db)).toEqual(after);
  });
  it("the capture reads the live state without writing, and says it matches once applied", async () => {
    const db = await freshDb();
    expect(capture(db)).toContain("CAPTURE VERDICT: DIFFERS (policy absent");
    await asRole(db, "ogevia_owner", UP);
    const out = capture(db);
    expect(out).toContain("CAPTURE VERDICT: MATCHES"); expect(out).toContain("Nothing was written");
  });
  it("rolling back removes the policy and never strips the owner's own privileges", async () => {
    const db = await freshDb(); await asRole(db, "ogevia_owner", UP);
    await asRole(db, "ogevia_owner", DOWN);
    const s = await snapshot(db);
    expect(s.policies).toEqual([]); expect(s.effective[0]).toEqual({ sel: true, exe: true });
    await asRole(db, "ogevia_owner", DOWN);                                                 // idempotent
  });
});

describe("production after the manual fixes (ogevia_admin owns the table and the function; the fixes are in place)", () => {
  it("the migration changes nothing and passes twice: the fixes are preserved, not re-defined", async () => {
    const { db, w } = await productionDb(true);
    expect((await compliance(db))[0].n).toBeGreaterThanOrEqual(0);                          // the defect is gone
    await notifications(db, w); await attention(db, w);
    const before = await snapshot(db);
    expect(before.table[0].o).toBe("ogevia_admin"); expect(before.fn[0].o).toBe("ogevia_admin");
    await asRole(db, "ogevia_owner", UP);                                                   // as the production runner role: needs no privilege, because nothing is missing
    expect(await snapshot(db)).toEqual(before);
    await asRole(db, "ogevia_owner", UP);
    expect(await snapshot(db)).toEqual(before);
    expect(capture(db)).toContain("CAPTURE VERDICT: MATCHES (migration 0108 would change nothing)");
  });
  it("rolling back (as the owner of the objects) restores the 2026-11-14 defect; applying again fixes it", async () => {
    const { db, w } = await productionDb(true);
    await asRole(db, "ogevia_admin", DOWN);
    await expectPgError(compliance(db), "42501", /business_documents/);
    await expectPgError(notifications(db, w), "42501");
    await asRole(db, "ogevia_admin", UP);
    expect((await compliance(db))[0].n).toBeGreaterThanOrEqual(0); await notifications(db, w);
  });
});

describe("production before the manual fixes (the 2026-11-14 defect)", () => {
  it("reproduces the production errors: the compliance sweep, notifications and attention fail with permission denied", async () => {
    const { db, w } = await productionDb(false);
    await expectPgError(compliance(db), "42501", /business_documents/);
    await expectPgError(notifications(db, w), "42501");
    await expectPgError(attention(db, w), "42501");
    expect(capture(db)).toContain("CAPTURE VERDICT: DIFFERS");
  });
  it("fails closed when the runner may not grant: a clear message, the whole migration rolled back, nothing changed", async () => {
    const { db } = await productionDb(false); const before = await snapshot(db);
    await expect(asRole(db, "ogevia_owner", UP)).rejects.toThrow(/permission denied for table business_documents|0108: .*(must be owner|still cannot)/is);   // PostgreSQL refuses the GRANT itself, or the end-state check does
    expect(await snapshot(db)).toEqual(before);
  });
  it("applied by the owner of the objects it states the privileges and the policy, adds nothing else, and fixes the errors", async () => {
    const { db, w } = await productionDb(false); const before = await snapshot(db);
    await asRole(db, "ogevia_admin", UP);
    const after = await snapshot(db);
    expect(after.effective[0]).toEqual({ sel: true, exe: true });
    expect(after.policies).toEqual([{ polname: "owner_definer_select", polcmd: "r", polpermissive: true, roles: "{ogevia_owner}", q: "true", c: null }]);
    expect(after.table[0].o).toBe("ogevia_admin"); expect(after.fn[0].o).toBe("ogevia_admin");   // ownership untouched
    expect(after.table[0].acl).toContain("ogevia_owner=r/ogevia_admin"); expect(after.fn[0].acl).toContain("ogevia_owner=X/ogevia_admin");
    expect(before.table[0].acl ?? "").not.toContain("ogevia_owner=r");
    expect((await compliance(db))[0].n).toBeGreaterThanOrEqual(0); await notifications(db, w); await attention(db, w);
    await asRole(db, "ogevia_admin", UP);                                                    // idempotent
    expect(await snapshot(db)).toEqual(after);
  });
  it.each([
    ["a policy for ALL commands", "create policy owner_definer_select on ogevia.business_documents for all to ogevia_owner using (true)"],
    ["a policy with a narrower USING clause", "create policy owner_definer_select on ogevia.business_documents for select to ogevia_owner using (organization_id is not null)"],
    ["a policy for another role", "create policy owner_definer_select on ogevia.business_documents for select to ogevia_app using (true)"],
    ["a restrictive policy", "create policy owner_definer_select on ogevia.business_documents as restrictive for select to ogevia_owner using (true)"],
  ])("refuses to overwrite %s that already uses the name, and changes nothing", async (_n, createPolicy) => {
    const { db } = await productionDb(true); await db.admin.query("drop policy owner_definer_select on ogevia.business_documents"); await db.admin.query(createPolicy);
    const before = await snapshot(db);
    await expect(asRole(db, "ogevia_admin", UP)).rejects.toThrow(/with a DIFFERENT definition .*refusing to overwrite it/s);
    expect(await snapshot(db)).toEqual(before);
    expect(capture(db)).toContain("CAPTURE VERDICT: DIFFERS (policy absent or defined differently");
  });
});

describe("the files", () => {
  it("are not loaded by the migration runner, carry a rollback, and write no data", () => {
    expect(UP).toMatch(/NOT loaded by the migration runner/); expect(DOWN).toMatch(/RESTORES THE 2026-11-14 PRODUCTION DEFECT/);
    expect(UP).not.toMatch(/\b(insert|update|delete|truncate|drop)\b/i);
    const loader = readFileSync(new URL("../scripts/migrations.ts", import.meta.url), "utf8");
    expect(loader).not.toContain("0108");
  });
});
