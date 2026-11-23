// docs/releases/2026-11-15-signin-override-production/VERIFY_PRODUCTION_DB.sql, run against a production-shaped database:
// migrations 0001-0102 (the accepted live baseline), then the real production upgrade SQL (0103-0107, 107 ledger rows). The deploy script refuses to
// continue unless this SQL prints "VERDICT: PASS" against production, so the verdict must pass when production is right and fail for each thing that can be wrong. SYNTHETIC data only.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness.js";

let db: TestDb;
const verifySql = fileURLToPath(new URL("../../../../docs/releases/2026-11-15-signin-override-production/VERIFY_PRODUCTION_DB.sql", import.meta.url));
const upgrade = () => spawnSync("python3", [fileURLToPath(new URL("../../scripts/production-ux-release.py", import.meta.url)), "sql", db.name], { encoding: "utf8" });
const verify = (expectedDb: string | null = db.name) => {
  const url = new URL(process.env.OGEVIA_TEST_DATABASE_URL!); url.pathname = `/${db.name}`;
  const r = spawnSync("psql", ["-X", "-q", url.toString(), "-v", "ON_ERROR_STOP=1", ...(expectedDb ? ["-v", `expected_db=${expectedDb}`] : []), "-f", verifySql], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
};

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  const sql = upgrade(); expect(sql.status, sql.stderr).toBe(0);
  const c = await db.admin.connect();
  try { await c.query(sql.stdout); } finally { c.release(); }
});
afterAll(async () => db?.drop());

describe("VERIFY_PRODUCTION_DB.sql verdict", () => {
  it("passes on a production-shaped database and writes nothing", async () => {
    const before = (await db.admin.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n;
    const out = verify();
    expect(out).toContain("VERDICT: PASS");
    expect(out).not.toContain("VERDICT: FAIL");
    expect(out).toContain("Nothing was written");
    expect((await db.admin.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n).toBe(before);
  });

  it("fails when the database is not ogevia_prd (the default expected name)", () => {
    const out = verify(null);
    expect(out).toContain("VERDICT: FAIL");
    expect(out).toContain("production database");
  });

  it.each([
    ["the permission is missing from the administrator role", "delete from ogevia.role_permissions where permission_key = 'caregivers.signin_override' and role = 'organization_admin'",
      "insert into ogevia.role_permissions (role, permission_key) values ('organization_admin', 'caregivers.signin_override')", "only owner and admin roles hold the permission"],
    ["a manager also holds the permission", "insert into ogevia.role_permissions (role, permission_key) values ('manager', 'caregivers.signin_override')",
      "delete from ogevia.role_permissions where role = 'manager' and permission_key = 'caregivers.signin_override'", "only owner and admin roles hold the permission"],
    ["the application role cannot execute the approval function", "revoke execute on function ogevia_api.approve_signin_override(uuid,uuid,text) from ogevia_app",
      "grant execute on function ogevia_api.approve_signin_override(uuid,uuid,text) to ogevia_app", "ogevia_app may execute, PUBLIC may not"],
    ["PUBLIC can execute the list function", "grant execute on function ogevia_api.list_signin_overrides(uuid) to public",
      "revoke execute on function ogevia_api.list_signin_overrides(uuid) from public", "ogevia_app may execute, PUBLIC may not"],
    ["the table is owned by another role (the 2026-11-14 defect class)", "alter table ogevia.caregiver_signin_overrides owner to ogevia_readonly",
      "alter table ogevia.caregiver_signin_overrides owner to ogevia_owner", "table and functions owned by ogevia_owner"],
    ["the function owner cannot execute a helper the approval calls", "revoke execute on function ogevia.write_audit(uuid, text, text, uuid, jsonb, jsonb, text) from ogevia_owner",
      "grant execute on function ogevia.write_audit(uuid, text, text, uuid, jsonb, jsonb, text) to ogevia_owner", "ogevia_owner may execute everything the path calls"],
    ["the ledger is short of a row", "delete from ogevia_meta.schema_migrations where version = '0107'",
      "insert into ogevia_meta.schema_migrations(version,name,checksum) select '0107', '0107_standard_document_types.sql', 'b0a28f483462a826aac0c9bb1e8e7b4ad8d26bfea80156668ab80874508f8d91'", "ledger has 107 rows"],
    ["the append-only trigger is disabled", "alter table ogevia.caregiver_signin_overrides disable trigger caregiver_signin_overrides_append_only",
      "alter table ogevia.caregiver_signin_overrides enable trigger caregiver_signin_overrides_append_only", "append-only trigger enabled"],
  ])("fails when %s", async (_name, breakIt, restore, expected) => {
    // Some of these statements need the exact signature of write_audit; read it from the catalog instead of trusting the literal above.
    const sig = (await db.admin.query("select p.oid::regprocedure::text s from pg_proc p where p.proname = 'write_audit' and p.pronamespace = 'ogevia'::regnamespace")).rows[0].s as string;
    const fix = (q: string) => q.replace("ogevia.write_audit(uuid, text, text, uuid, jsonb, jsonb, text)", sig);
    await db.admin.query(fix(breakIt));
    try {
      const out = verify();
      expect(out).toContain("VERDICT: FAIL");
      expect(out).toContain(expected);
    } finally { await db.admin.query(fix(restore)); }
    expect(verify()).toContain("VERDICT: PASS");   // and everything is back to passing
  });
});
