// The test-data cleanup preview (db/preview/test_data_cleanup_preview.sql) runs with the real psql, reports counts only, and changes nothing.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_URL, createTestDb, seedWorld, type TestDb, type World } from "./harness.js";

const FILE = join(__dirname, "../preview/test_data_cleanup_preview.sql");
let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

const run = (slug: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db.name}`;
  return spawnSync("psql", [u.toString(), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", `org_slug=${slug}`, "-f", FILE], { encoding: "utf8" });
};
const slugOf = async (id: string) => (await db.admin.query("select slug from ogevia.organizations where id = $1", [id])).rows[0].slug as string;
const totals = async () => (await db.admin.query(
  `select (select count(*) from ogevia.clients) c, (select count(*) from ogevia.audit_events) a, (select count(*) from ogevia.service_visits) v,
          (select count(*) from ogevia.shifts) s, (select count(*) from ogevia.caregiver_records) r, (select count(*) from ogevia.client_authorizations) z`)).rows[0];

describe("test-data cleanup preview", () => {
  it("is declared read only and ends with a rollback", () => {
    const sql = readFileSync(FILE, "utf8");
    expect(sql).toMatch(/^begin read only;$/m);
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(sql).not.toMatch(/^\s*(insert|update|delete|truncate|drop|alter|create|grant|revoke)\b/im);
  });

  it("runs against a populated agency, prints every section with counts, and leaves the database exactly as it was", async () => {
    const before = await totals();
    const r = run(await slugOf(w.orgA));
    expect(r.status, r.stderr).toBe(0);
    for (const h of ["== A.", "== B1.", "== B2.", "== C1.", "== C2.", "== C3.", "== C4.", "== C5.", "== D1.", "== D2.", "== E.", "== E2."]) expect(r.stdout, h).toContain(h);
    expect(r.stdout).toMatch(/\bclients\s*\|\s*[2-9]/); // org A has at least its two synthetic clients
    expect(r.stdout).toMatch(/client_authorizations\s*\|\s*client\s*\|\s*[1-9]/); // section E names the protected table and how many clients hold it
    expect(await totals()).toEqual(before);
  });

  it("is count only: no client codes, caregiver codes or names appear in the output", async () => {
    const r = run(await slugOf(w.orgA));
    const people = (await db.admin.query(
      `select client_code as v from ogevia.clients union all select caregiver_code from ogevia.caregiver_records
       union all select first_name from ogevia.caregiver_records union all select last_name from ogevia.caregiver_records
       union all select display_name from ogevia.app_users`)).rows.map((x) => String(x.v)).filter((v) => v.length >= 3);
    expect(people.length).toBeGreaterThan(0);
    for (const v of people) expect(r.stdout, `output must not contain "${v}"`).not.toContain(v);
    expect(r.stdout).not.toMatch(/Synthetic/i);
  });

  it("reports zero business rows for an agency with no records, and fails cleanly for an unknown agency", async () => {
    const { rows } = await db.admin.query("insert into ogevia.organizations (slug, display_name) values ('empty-agency', 'empty-agency') returning id");
    expect(rows).toHaveLength(1);
    const r = run("empty-agency");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/\bclients\s*\|\s*[1-9]/);
    const unknown = run("no-such-agency");
    expect(unknown.status, unknown.stderr).toBe(0);
    expect(unknown.stdout).toContain("(0 rows)");
  });
});
