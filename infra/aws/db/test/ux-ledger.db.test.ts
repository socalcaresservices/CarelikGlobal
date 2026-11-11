// Exercise the actual prepared operator transaction on a disposable local database.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_URL, createTestDb, type TestDb } from "./harness.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => db?.drop());
const pending = new URL("../pending/", import.meta.url);
const script = readFileSync(new URL("../../../../docs/releases/2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DB.sh", import.meta.url), "utf8");
const fn = script.slice(script.indexOf("guarded_psql() {"), script.indexOf('\n\ncase "$MODE"', script.indexOf("guarded_psql() {")));
function run(stem: string, direction: "apply" | "rollback") {
  const checksum = createHash("sha256").update(readFileSync(new URL(`migrations/${stem}.sql`, pending))).digest("hex");
  const file = fileURLToPath(new URL(direction === "apply" ? `migrations/${stem}.sql` : `rollback/${stem}.down.sql`, pending)).replaceAll("\\", "/");
  const url = new URL(ADMIN_URL);
  return spawnSync("bash", ["-c", `declare -A UP_SHA=([${stem}]=${checksum}); DB="$PGDATABASE"; ${fn}\nguarded_psql "$MIGRATION_FILE" '${stem}' '${direction}'`], {
    encoding: "utf8", env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: db.name, MIGRATION_FILE: file },
  });
}
it("validates a TEST-only logical backup and refuses corruption or the wrong database", () => {
  const url = new URL(ADMIN_URL); url.pathname = `/${db.name}`;
  const file = join(mkdtempSync(join(tmpdir(), "ux-backup-")), "test.dump");
  const dump = spawnSync("pg_dump", ["--format=custom", "--dbname", url.toString(), "--file", file], { encoding: "utf8" });
  expect(dump.status, dump.stderr).toBe(0);
  const unixFile = process.platform === "win32" ? file.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`) : file;
  writeFileSync(file + ".sha256", `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${unixFile}\n`);
  writeFileSync(file + ".meta", `${db.name}|${Math.floor(Date.now() / 1000)}\n`);
  const backupFn = script.slice(script.indexOf("backup_check() {"), script.indexOf("\nfor c in psql", script.indexOf("backup_check() {")));
  const check = () => spawnSync("bash", ["-c", `stop() { echo "$*"; exit 2; }; MODE=apply; DB="$EXPECTED_DB"; ${backupFn}\nbackup_check`], { encoding: "utf8", env: { ...process.env, OGEVIA_TEST_BACKUP: unixFile, EXPECTED_DB: db.name } });
  expect(check().status).toBe(0);
  writeFileSync(file + ".meta", `wrong_database|${Math.floor(Date.now() / 1000)}\n`);
  expect(check().status).not.toBe(0);
  writeFileSync(file + ".meta", `${db.name}|${Math.floor(Date.now() / 1000)}\n`);
  writeFileSync(file, "corrupt archive");
  expect(check().status).not.toBe(0);
});
it("records checksums atomically, refuses reapply, and removes only rolled-back ledger rows", async () => {
  const stems = readdirSync(new URL("migrations/", pending)).filter((f) => /^010[3-7]_.*\.sql$/.test(f)).sort().map((f) => f.slice(0, -4));
  expect(stems).toHaveLength(5);
  await db.admin.query(`create function ogevia_meta.reject_ux_ledger() returns trigger language plpgsql as $$ begin raise exception 'Synthetic ledger failure'; end $$;
    create trigger reject_ux_ledger before insert on ogevia_meta.schema_migrations for each row execute function ogevia_meta.reject_ux_ledger()`);
  expect(run(stems[0]!, "apply").status).not.toBe(0);
  expect((await db.admin.query("select to_regclass('ogevia.caregiver_signin_overrides') r")).rows[0].r).toBeNull();
  expect((await db.admin.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n).toBe(88);
  await db.admin.query("drop trigger reject_ux_ledger on ogevia_meta.schema_migrations; drop function ogevia_meta.reject_ux_ledger()");
  for (const stem of stems) { const r = run(stem, "apply"); expect(r.status, r.stderr + r.stdout).toBe(0); }
  const ledger = await db.admin.query("select version, checksum from ogevia_meta.schema_migrations where version >= '0090' order by version");
  expect(ledger.rows.map((r) => r.version)).toEqual(["0103", "0104", "0105", "0106", "0107"]);
  expect(ledger.rows.map((r) => r.checksum)).toEqual(stems.map((s) => createHash("sha256").update(readFileSync(new URL(`migrations/${s}.sql`, pending))).digest("hex")));
  const retry = run(stems[0]!, "apply"); expect(retry.status).not.toBe(0); expect(retry.stdout).toContain("already recorded");
  for (const stem of [...stems].reverse()) { const r = run(stem, "rollback"); expect(r.status, r.stderr + r.stdout).toBe(0); }
  expect((await db.admin.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n).toBe(88);
  expect(run(stems[0]!, "rollback").status).not.toBe(0);
});
it("the operator rollback handles a release stopped after only two files applied", async () => {
  const stems = readdirSync(new URL("migrations/", pending)).filter((f) => /^010[3-7]_.*\.sql$/.test(f)).sort().map((f) => f.slice(0, -4));
  for (const stem of stems.slice(0, 2)) { const r = run(stem, "apply"); expect(r.status, r.stderr + r.stdout).toBe(0); }
  const array = stems.map((s) => `[${s}]=${createHash("sha256").update(readFileSync(new URL(`migrations/${s}.sql`, pending))).digest("hex")}`).join(" ");
  const start = script.indexOf("    for n in 0107_standard_document_types");
  const loop = script.slice(start, script.indexOf("    state; vrun absent", start));
  const url = new URL(ADMIN_URL);
  const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replaceAll("\\", "/");
  const r = spawnSync("bash", ["-c", `declare -A UP_SHA=(${array}); DB="$PGDATABASE"; stop() { echo "$*"; exit 2; }; ro() { psql -X -At -d "$DB" -c "$1"; }; ${fn}\n${loop}`], { encoding: "utf8", env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: db.name, REPO: repo } });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  expect((await db.admin.query("select count(*)::int n from ogevia_meta.schema_migrations")).rows[0].n).toBe(88);
  expect((await db.admin.query("select to_regclass('ogevia.caregiver_signin_overrides') r")).rows[0].r).toBeNull();
});
