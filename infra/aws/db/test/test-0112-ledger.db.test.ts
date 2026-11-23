// TEST_0112_LEDGER.sh against a local disposable database that has the current TEST ledger (110/0111). Nothing here touches AWS.
// Proves: the guards refuse the wrong database and the wrong state; apply records the ledger row in the same transaction; verify passes;
// rollback removes the objects and the row together; a failed apply leaves nothing behind.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const TCDIR = join(root, "docs/releases/2026-11-20-test-plan/toolchain");
const script = join(TCDIR, "TEST_0112_LEDGER.sh");
const name = `ogevia_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const u = new URL(ADMIN_URL);
let db: pg.Client;
let backup = "";

function run(mode: string, extra: Record<string, string | undefined> = {}, dbName = name) {
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: dbName, OGEVIA_LOCAL_REHEARSAL: "1", REPO: root, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return spawnSync("bash", [script, mode], { encoding: "utf8", env });
}
const ledger = async () => (await db.query<{ n: string; l: string }>("select count(*)::text n, max(version) l from ogevia_meta.schema_migrations")).rows[0]!;
const objects = async () => (await db.query<{ n: string }>("select count(*)::text n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('list_assignment_history')")).rows[0]!.n;
const APPROVED = { OGEVIA_DEPLOY_APPROVAL: "rehearsal-approval-ref" };

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await migrate(db, () => {}, { includePendingUx: true });
  const dir0 = mkdtempSync(join(tmpdir(), "bk-0109-")); const b0 = join(dir0, "ogevia_sv_test-pre.dump"); writeFileSync(b0, "synthetic backup stand-in");
  writeFileSync(`${b0}.sha256`, `${spawnSync("sha256sum", [b0], { encoding: "utf8" }).stdout.split(" ")[0]!}  ogevia_sv_test-pre.dump\n`);
  const r0 = spawnSync("bash", [join(TCDIR, "TEST_0109_LEDGER.sh"), "apply"], { encoding: "utf8", env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: name, OGEVIA_LOCAL_REHEARSAL: "1", REPO: root, OGEVIA_DEPLOY_APPROVAL: "rehearsal-0109", OGEVIA_TEST_BACKUP: b0 } });
  if (r0.status !== 0) throw new Error("could not set up the 108/0109 baseline: " + r0.stderr + r0.stdout);
  const r1 = spawnSync("bash", [join(TCDIR, "TEST_0110_LEDGER.sh"), "apply"], { encoding: "utf8", env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: name, OGEVIA_LOCAL_REHEARSAL: "1", OGEVIA_DEPLOY_APPROVAL: "rehearsal-approval-ref", OGEVIA_TEST_BACKUP: b0 } });
  if (r1.status !== 0) throw new Error("could not set up the 109/0110 baseline: " + r1.stderr + r1.stdout);
  const r2 = spawnSync("bash", [join(TCDIR, "TEST_0111_LEDGER.sh"), "apply"], { encoding: "utf8", env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: name, OGEVIA_LOCAL_REHEARSAL: "1", OGEVIA_DEPLOY_APPROVAL: "rehearsal-approval-ref", OGEVIA_TEST_BACKUP: b0 } });
  if (r2.status !== 0) throw new Error("could not set up the 110/0111 baseline: " + r2.stderr + r2.stdout);
  const dir = mkdtempSync(join(tmpdir(), "bk-0109-"));
  backup = join(dir, "ogevia_sv_test-rehearsal.dump");
  writeFileSync(backup, "synthetic backup stand-in");
  const sum = spawnSync("sha256sum", [backup], { encoding: "utf8" }).stdout.split(" ")[0]!;
  writeFileSync(`${backup}.sha256`, `${sum}  ogevia_sv_test-rehearsal.dump\n`);
});
afterAll(async () => {
  await db?.end();
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end();
});

const BASE = { n: "110", l: "0111" };
const UP_SHA = "e6c78065d02dc426b4661cc96d1673c46621005388c3a085d6c1511061d538b2";
const SHA_0111 = "d09dbb181b37e7d49c7127ee71962c63c7709bc72ee5187b588d6da6cb4926ed";

describe("TEST_0112_LEDGER.sh", () => {
  it("the rehearsal database has the current TEST ledger: 110 rows, last 0111, no 0112 objects", async () => {
    expect(await ledger()).toEqual(BASE);
    expect(await objects()).toBe("0");
  });

  it("refuses an unknown mode, and a database that is not the isolated TEST one, before connecting to anything", () => {
    expect(run("delete").status).toBe(2);
    const wrongName = run("probe", { OGEVIA_LOCAL_REHEARSAL: undefined }, name);
    expect(wrongName.status).toBe(2); expect(wrongName.stderr).toContain("PGDATABASE must be ogevia_sv_test");
    const prd = run("probe", { OGEVIA_LOCAL_REHEARSAL: undefined }, "ogevia_prd");
    expect(prd.status).toBe(2); expect(prd.stderr).toContain("ogevia_sv_test");
    const remote = run("probe", { PGHOST: "ogevia-prod-postgres.example.invalid" });
    expect(remote.status).toBe(2); expect(remote.stderr).toContain("rehearsal is local only");
  });

  it("refuses a file that differs from the pinned bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-0112-"));
    for (const f of ["infra/aws/db/pending/migrations/0112_assignment_history.sql", "infra/aws/db/pending/rollback/0112_assignment_history.down.sql"]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(root, f), join(dir, f));
    }
    writeFileSync(join(dir, "infra/aws/db/pending/migrations/0112_assignment_history.sql"), "-- changed\nselect 1;\n");
    const r = run("probe", { REPO: dir });
    expect(r.status).toBe(2); expect(r.stderr).toContain("differs from the pinned bytes");
  });

  it("probe is read-only and passes on the baseline; it refuses when 0111 is not recorded with its checksum", async () => {
    const r = run("probe");
    expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("PROBE OK");
    expect(await ledger()).toEqual(BASE);
    await db.query("update ogevia_meta.schema_migrations set checksum = repeat('0', 64) where version = '0111'");
    const bad = run("probe"); expect(bad.status).toBe(2); expect(bad.stderr).toContain("not the baseline");
    await db.query(`update ogevia_meta.schema_migrations set checksum = '${SHA_0111}' where version = '0111'`);
  });

  it("apply refuses without an approval reference or without a verified backup, and changes nothing", async () => {
    expect(run("apply", { OGEVIA_TEST_BACKUP: backup }).stderr).toContain("OGEVIA_DEPLOY_APPROVAL");
    expect(run("apply", { ...APPROVED }).stderr).toContain("OGEVIA_TEST_BACKUP");
    writeFileSync(`${backup}.bad`, "x"); writeFileSync(`${backup}.bad.sha256`, `${"0".repeat(64)}  ogevia_sv_test-rehearsal.dump.bad\n`);
    const badSum = run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: `${backup}.bad` });
    expect(badSum.status).toBe(2); expect(badSum.stderr).toContain("backup checksum");
    expect(await ledger()).toEqual(BASE); expect(await objects()).toBe("0");
  });

  it("verify and rollback refuse before 0112 is applied", () => {
    expect(run("verify").status).toBe(1);
    const r = run("rollback", { ...APPROVED });
    expect(r.status).toBe(2); expect(r.stderr).toContain("not recorded as applied");
  });

  it("apply records the ledger row and the objects in one transaction; verify passes (every check); a second apply is refused", async () => {
    const r = run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: backup });
    expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("APPLIED 0112");
    expect(await ledger()).toEqual({ n: "111", l: "0112" }); expect(await objects()).toBe("1");
    expect((await db.query("select name, checksum from ogevia_meta.schema_migrations where version = '0112'")).rows[0]).toEqual({ name: "0112_assignment_history.sql", checksum: UP_SHA });
    const v = run("verify");
    expect(v.status, v.stderr + v.stdout).toBe(0); expect(v.stdout).toContain("VERIFIED"); expect(v.stdout).toMatch(/VERIFY_0112 \(present\/present\): 9 checks, 0 failing/);
    expect(run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: backup }).status).toBe(2);
    expect(await ledger()).toEqual({ n: "111", l: "0112" });
    expect(run("probe").status).toBe(2);
  });

  it("verify fails when the 0112 ledger row's checksum was altered, without changing anything", async () => {
    await db.query("update ogevia_meta.schema_migrations set checksum = repeat('0', 64) where version = '0112'");
    const v = run("verify"); expect(v.status).toBe(1); expect(v.stdout).toContain("checksum differs");
    expect(run("rollback", { ...APPROVED }).status).toBe(2);
    await db.query(`update ogevia_meta.schema_migrations set checksum = '${UP_SHA}' where version = '0112'`);
    expect(await objects()).toBe("1");
  });

  it("rollback removes the objects, the tables and the ledger row together and returns to the baseline", async () => {
    const r = run("rollback", { ...APPROVED });
    expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("ROLLED BACK 0112");
    expect(await ledger()).toEqual(BASE); expect(await objects()).toBe("0");
    expect(run("probe").status).toBe(0);
  });

  it("a failing apply (the function already exists) rolls the whole transaction back: no ledger row and nothing half-applied", async () => {
    await db.query("create function ogevia_api.list_assignment_history(uuid, text, uuid, integer) returns integer language sql as $$ select 1 $$");   // makes CREATE FUNCTION fail
    try {
      const r = run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: backup });
      expect(r.status).toBe(2); expect(r.stderr).toMatch(/pre-check failed|apply failed/);   // the pre-check refuses an existing object before anything is written
    } finally { await db.query("drop function ogevia_api.list_assignment_history(uuid, text, uuid, integer)"); }
    expect(await ledger()).toEqual(BASE); expect(await objects()).toBe("0");
    expect(run("probe").status).toBe(0);
  });
});
