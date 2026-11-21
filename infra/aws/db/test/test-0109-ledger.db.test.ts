// TEST_0109_LEDGER.sh against a local disposable database that has the accepted TEST ledger (107/0107). Nothing here touches AWS.
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
const script = join(root, "docs/releases/2026-11-20-test-plan/toolchain/TEST_0109_LEDGER.sh");
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
const objects = async () => (await db.query<{ n: string }>("select count(*)::text n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'ogevia_api' and p.proname in ('cancel_staff_document_request','retire_document_type','mark_staff_care_notifications_read')")).rows[0]!.n;
const APPROVED = { OGEVIA_DEPLOY_APPROVAL: "rehearsal-approval-ref" };

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`create database ${name}`); await admin.end();
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await migrate(db, () => {}, { includePendingUx: true });
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

describe("TEST_0109_LEDGER.sh", () => {
  it("the rehearsal database has the accepted TEST ledger: 107 rows, last 0107, no 0109", async () => {
    expect(await ledger()).toEqual({ n: "107", l: "0107" });
    expect(await objects()).toBe("0");
  });

  it("refuses an unknown mode, and a database that is not the isolated TEST one, before connecting to anything", () => {
    expect(run("delete").status).toBe(2);
    const wrongName = run("probe", { OGEVIA_LOCAL_REHEARSAL: undefined }, name);   // without the rehearsal flag the name must be ogevia_sv_test
    expect(wrongName.status).toBe(2); expect(wrongName.stderr).toContain("PGDATABASE must be ogevia_sv_test");
    const prd = run("probe", { OGEVIA_LOCAL_REHEARSAL: undefined }, "ogevia_prd");
    expect(prd.status).toBe(2); expect(prd.stderr).toContain("ogevia_sv_test");
    const remote = run("probe", { PGHOST: "ogevia-prod-postgres.example.invalid" });
    expect(remote.status).toBe(2); expect(remote.stderr).toContain("rehearsal is local only");
    const badRehearsal = run("probe", {}, "ogevia_sv_test");
    expect(badRehearsal.status).toBe(2); expect(badRehearsal.stderr).toContain("ogevia_test_");
  });

  it("refuses a file that differs from the pinned bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "repo-0109-"));
    for (const f of ["infra/aws/db/pending/migrations/0109_request_cleanup.sql", "infra/aws/db/pending/rollback/0109_request_cleanup.down.sql"]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(root, f), join(dir, f));
    }
    writeFileSync(join(dir, "infra/aws/db/pending/migrations/0109_request_cleanup.sql"), "-- changed\nselect 1;\n");
    const r = run("probe", { REPO: dir });
    expect(r.status).toBe(2); expect(r.stderr).toContain("differs from the pinned bytes");
  });

  it("probe is read-only and passes on the baseline", async () => {
    const r = run("probe");
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("PROBE OK");
    expect(await ledger()).toEqual({ n: "107", l: "0107" });
  });

  it("apply refuses without an approval reference or without a verified backup, and changes nothing", async () => {
    const noApproval = run("apply", { OGEVIA_TEST_BACKUP: backup });
    expect(noApproval.status).toBe(2); expect(noApproval.stderr).toContain("OGEVIA_DEPLOY_APPROVAL");
    const noBackup = run("apply", { ...APPROVED });
    expect(noBackup.status).toBe(2); expect(noBackup.stderr).toContain("OGEVIA_TEST_BACKUP");
    writeFileSync(`${backup}.bad`, "x"); writeFileSync(`${backup}.bad.sha256`, `${"0".repeat(64)}  ogevia_sv_test-rehearsal.dump.bad\n`);
    const badSum = run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: `${backup}.bad` });
    expect(badSum.status).toBe(2); expect(badSum.stderr).toContain("backup checksum");
    expect(await ledger()).toEqual({ n: "107", l: "0107" }); expect(await objects()).toBe("0");
  });

  it("verify and rollback refuse before 0109 is applied", () => {
    expect(run("verify").status).toBe(1);
    const r = run("rollback", { ...APPROVED });
    expect(r.status).toBe(2); expect(r.stderr).toContain("not recorded as applied");
  });

  it("apply records the ledger row and the objects in one transaction; verify passes; a second apply is refused", async () => {
    const r = run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: backup });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("APPLIED 0109");
    expect(await ledger()).toEqual({ n: "108", l: "0109" });
    expect(await objects()).toBe("3");
    const row = (await db.query("select name, checksum from ogevia_meta.schema_migrations where version = '0109'")).rows[0];
    expect(row).toEqual({ name: "0109_request_cleanup.sql", checksum: "2c0ebb9e91e5a88d52f4cd323a82c7b691fb85197c74f80ca98ee774642cd25b" });
    const v = run("verify");
    expect(v.status, v.stderr + v.stdout).toBe(0); expect(v.stdout).toContain("VERIFIED");
    const again = run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: backup });
    expect(again.status).toBe(2);
    expect(await ledger()).toEqual({ n: "108", l: "0109" });
    const probe = run("probe");
    expect(probe.status).toBe(2);   // no longer the baseline
  });

  it("verify fails when the ledger row's checksum was altered, without changing anything", async () => {
    await db.query("update ogevia_meta.schema_migrations set checksum = repeat('0', 64) where version = '0109'");
    const v = run("verify");
    expect(v.status).toBe(1); expect(v.stdout).toContain("checksum differs");
    const rb = run("rollback", { ...APPROVED });
    expect(rb.status).toBe(2);
    await db.query("update ogevia_meta.schema_migrations set checksum = '2c0ebb9e91e5a88d52f4cd323a82c7b691fb85197c74f80ca98ee774642cd25b' where version = '0109'");
    expect(await objects()).toBe("3");
  });

  it("rollback removes the objects and the ledger row together and returns to the baseline", async () => {
    const r = run("rollback", { ...APPROVED });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("ROLLED BACK 0109");
    expect(await ledger()).toEqual({ n: "107", l: "0107" });
    expect(await objects()).toBe("0");
    expect(run("probe").status).toBe(0);
  });

  it("a failing apply (the migration stops part-way) rolls the whole transaction back: no objects, no columns, no ledger row", async () => {
    const owner = (await db.query<{ o: string }>("select tableowner o from pg_tables where schemaname = 'ogevia' and tablename = 'document_types'")).rows[0]!.o;
    await db.query("alter table ogevia.document_types owner to postgres");   // the migration's second ALTER TABLE now fails, after the first one succeeded
    try {
      const r = run("apply", { ...APPROVED, OGEVIA_TEST_BACKUP: backup });
      expect(r.status).toBe(2); expect(r.stderr).toContain("apply failed");
    } finally { await db.query(`alter table ogevia.document_types owner to ${owner}`); }
    expect(await ledger()).toEqual({ n: "107", l: "0107" });
    expect(await objects()).toBe("0");
    const cols = await db.query("select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'ogevia' and ((table_name = 'staff_documents' and column_name in ('cancelled_by','cancel_reason')) or (table_name = 'document_types' and column_name in ('retired_by','retired_at')))");
    expect(cols.rows.map((r) => r.c)).toEqual([]);
    expect(run("probe").status).toBe(0);   // still the clean baseline
  });
});
