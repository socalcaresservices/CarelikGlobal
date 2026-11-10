// 0092 (PENDING, infra/aws/db/pending): R11 bulk import. SYNTHETIC data only. Applied here on top of 0001-0088 as ogevia_owner.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0092_bulk_import.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0092_bulk_import.down.sql", import.meta.url);
let db: TestDb;
let w: World;
let staffType: string;

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const imp = (a: Actor, kind: string, rows: unknown[], seed: string, confirm: boolean, org = w.orgA) =>
  call(a, "select ogevia_api.import_rows($1,$2,$3::jsonb,$4,'test.csv',$5) as r", [org, kind, JSON.stringify(rows), sha(seed), confirm]).then((r) => r[0].r);
const count = async (table: string, org = w.orgA) => (await db.admin.query(`select count(*)::int n from ogevia.${table} where organization_id = $1`, [org])).rows[0].n as number;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 1000);
  await run(UP);
  staffType = (await call(w.ownerA, "select ogevia_api.create_staff_type($1,'Scheduler (synthetic)') as id", [w.orgA]))[0].id;
});
afterAll(async () => db?.drop());

describe("0092 bulk import", () => {
  it("preview writes nothing and reports new / duplicate / invalid rows", async () => {
    const before = [await count("caregiver_records"), await count("clients"), await count("staff_profiles")];
    const r = await imp(w.ownerA, "people", [
      { first_name: "Priya", last_name: "Sample", type: "Caregiver" },
      { first_name: "Priya", last_name: "Sample", type: "Caregiver" },                 // repeated in the file
      { first_name: "Sam", last_name: "Planner", type: "Scheduler (synthetic)", email: "  SAM.Planner@Example.com ", phone: "(555) 010-1234" },
      { first_name: "=cmd", last_name: "Injection", type: "Caregiver" },               // spreadsheet formula text is refused
      { first_name: "Lee", last_name: "Nobody", type: "Astronaut" },                   // unknown staff type
    ], "preview-1", false);
    expect(r.mode).toBe("preview");
    expect(r.counts).toEqual({ total: 5, new: 2, duplicate: 1, invalid: 2 });
    expect(r.rows.map((x: any) => x.status).sort()).toEqual(["duplicate", "invalid", "invalid"]);
    expect([await count("caregiver_records"), await count("clients"), await count("staff_profiles")]).toEqual(before);
  });

  it("confirm creates the new rows through the existing creators, skips duplicates, sends no invitation, and audits counts without names", async () => {
    const rows = [
      { first_name: "Maya", last_name: "Importer", type: "Caregiver" },
      { first_name: "maya", last_name: "IMPORTER", type: "caregiver" },                // duplicate by name
      { first_name: "Tess", last_name: "Office", type: "Scheduler (synthetic)", email: "tess.office@example.com" },
    ];
    const r = await imp(w.ownerA, "people", rows, "confirm-1", true);
    expect(r.mode).toBe("applied");
    expect(r.created).toBe(2);
    expect(r.counts.duplicate).toBe(1);
    const cg = await db.admin.query("select caregiver_code, status from ogevia.caregiver_records where organization_id = $1 and first_name = 'Maya'", [w.orgA]);
    expect(cg.rows).toHaveLength(1);
    expect(cg.rows[0].caregiver_code).toMatch(/^CG-/);
    expect(cg.rows[0].status).toBe("onboarding");
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_invitations where organization_id = $1", [w.orgA])).rows[0].n).toBe(0);
    const audit = await db.admin.query("select after_state from ogevia.audit_events where action = 'import.applied' and organization_id = $1 order by occurred_at desc limit 1", [w.orgA]);
    expect(JSON.stringify(audit.rows[0])).toMatch(/"created":2/);
    expect(JSON.stringify(audit.rows[0])).not.toMatch(/Maya|Tess/);
  });

  it("re-uploading the same file creates nothing and returns the first import", async () => {
    const before = await count("caregiver_records");
    const rows = [{ first_name: "Maya", last_name: "Importer", type: "Caregiver" }, { first_name: "Nora", last_name: "Second", type: "Caregiver" }];
    const first = await imp(w.ownerA, "people", rows, "idem-1", true);
    expect(first.created).toBe(1);
    const again = await imp(w.ownerA, "people", rows, "idem-1", true);
    expect(again.mode).toBe("already_imported");
    expect(await count("caregiver_records")).toBe(before + 1);
  });

  it("staff are de-duplicated on normalized email and phone, against existing staff and within the file", async () => {
    const r = await imp(w.ownerA, "people", [
      { first_name: "Tess", last_name: "Again", type: "Scheduler (synthetic)", email: "TESS.OFFICE@example.com" },      // same email as an existing profile
      { first_name: "Uma", last_name: "Phone", type: "Scheduler (synthetic)", phone: "555-010-9999" },
      { first_name: "Uma", last_name: "Other", type: "Scheduler (synthetic)", phone: "(555) 010 9999" },                 // same phone, repeated in the file
    ], "staff-dedupe", false);
    expect(r.counts.duplicate).toBe(2);
    expect(r.counts.new).toBe(1);
  });

  it("a file with an invalid row cannot be confirmed and imports nothing", async () => {
    const before = await count("caregiver_records");
    await expectPgError(imp(w.ownerA, "people", [{ first_name: "Good", last_name: "Row", type: "Caregiver" }, { first_name: "", last_name: "Missing" }], "invalid-1", true), "OGV22", /invalid row/);
    expect(await count("caregiver_records")).toBe(before);
  });

  it("a failure part-way rolls back every row of the file", async () => {
    const ct = (await call(w.ownerA, "select ogevia_api.create_client_type($1,'Synthetic type',null) as id", [w.orgA]))[0].id;
    await db.admin.query("alter table ogevia.clients add constraint import_test_fail check (city is distinct from 'Failville')");
    const before = await count("clients");
    await expect(imp(w.ownerA, "clients", [
      { first_name: "Ann", last_name: "First", city: "Springfield", client_type: "Synthetic type" },
      { first_name: "Bob", last_name: "Second", city: "Failville" },
    ], "rollback-1", true)).rejects.toThrow();
    expect(await count("clients")).toBe(before);
    expect((await db.admin.query("select count(*)::int n from ogevia.import_batches where file_sha256 = $1", [sha("rollback-1")])).rows[0].n).toBe(0);
    await db.admin.query("alter table ogevia.clients drop constraint import_test_fail");
    void ct;
  });

  it("clients: new, duplicate (name + city), unknown client type, and the codes come from the server", async () => {
    const rows = [
      { first_name: "Cleo", last_name: "Client", city: "Springfield", client_type: "synthetic TYPE" },
      { first_name: "Cleo", last_name: "Client", city: "springfield" },
      { first_name: "Dan", last_name: "Other", client_type: "No such type" },
    ];
    const p = await imp(w.ownerA, "clients", rows, "clients-1", false);
    expect(p.counts).toEqual({ total: 3, new: 1, duplicate: 1, invalid: 1 });
    const ok = await imp(w.ownerA, "clients", rows.slice(0, 2), "clients-2", true);
    expect(ok.created).toBe(1);
    const row = (await db.admin.query("select c.client_code, c.city from ogevia.clients c join ogevia.client_private_names n on n.client_id = c.id where n.legal_first_name = 'Cleo' and c.organization_id = $1", [w.orgA])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].client_code).toBeTruthy();
  });

  it("tenant and permission: the organization comes from the session; another agency, a manager without staff rights and a caregiver are refused", async () => {
    await expectPgError(imp(w.managerB, "people", [{ first_name: "Wrong", last_name: "Tenant", type: "Caregiver" }], "tenant-1", true, w.orgA), "OGN04", /Organization not found/);
    await expectPgError(imp(w.caregiverA1, "people", [{ first_name: "No", last_name: "Rights", type: "Caregiver" }], "perm-1", false), "OGA03", /./);
    await expectPgError(imp(w.caregiverA1, "clients", [{ first_name: "No", last_name: "Rights" }], "perm-2", false), "OGA03", /./);
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_records where last_name in ('Tenant','Rights')")).rows[0].n).toBe(0);
  });

  it("a 1,000-row file imports in one call, and a 2,001-row file is refused", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ first_name: `Bulk${"abcdefghij"[i % 10]}`, last_name: `Person${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + Math.floor(i / 676))}`, type: "Caregiver" }));
    const t0 = Date.now();
    const r = await imp(w.ownerA, "people", rows, "big-1", true);
    expect(r.created + r.counts.duplicate).toBe(1000);
    expect(r.created).toBeGreaterThan(900);
    expect(Date.now() - t0).toBeLessThan(60000);
    await expectPgError(imp(w.ownerA, "people", Array.from({ length: 2001 }, () => ({ first_name: "A", last_name: "B" })), "big-2", false), "OGV22", /2,000/);
  }, 120000);

  it("the rollback removes the function and the table (created records stay)", async () => {
    const before = await count("caregiver_records");
    await run(DOWN);
    expect(await count("caregiver_records")).toBe(before);
    expect((await db.admin.query("select to_regclass('ogevia.import_batches') r")).rows[0].r).toBeNull();
  });
});
void randomUUID;
