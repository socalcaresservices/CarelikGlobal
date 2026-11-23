// The production-upgrade REHEARSAL package (docs/releases/2026-10-19-prd-readiness/rehearsal): every script is run against a MOCKED aws CLI and a REAL local PostgreSQL 16.
// Nothing here contacts AWS. The mock refuses any call it does not know, and the tests assert that production (ogevia-prod-postgres and sg-00530a1f4f7648e65) is never modified.
// The local cluster must be a throwaway: the test creates databases named ogevia_prd and ogevia_sv_test (the names the scripts hard-code) and drops them afterwards.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diffFingerprints, fingerprint } from "../scripts/fingerprint.js";
import { loadMigrations, migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

vi.setConfig({ testTimeout: 600000, hookTimeout: 600000 });
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const BUILD = join(REPO, "docs/releases/2026-10-19-prd-readiness/rehearsal/build-package.sh");
const work = mkdtempSync(join(tmpdir(), "prdreh-"));
const MOCK = join(work, "mock"); const BIN = join(work, "bin"); const OUT = join(work, "out"); const PKGDIR = join(work, "pkg");
mkdirSync(MOCK, { recursive: true }); mkdirSync(BIN, { recursive: true });
const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const REH = `ogevia-prd-rehearsal-${TODAY}`;
const PROD_JSON = {
  DBInstanceIdentifier: "ogevia-prod-postgres", DBInstanceStatus: "available", PubliclyAccessible: false, StorageEncrypted: true, DBInstanceClass: "db.t4g.micro",
  Engine: "postgres", EngineVersion: "18.3", AllocatedStorage: 20, StorageType: "gp3", MultiAZ: false, KmsKeyId: "arn:aws:kms:us-west-2:300094796789:key/11111111-2222-3333-4444-555555555555",
  VpcSecurityGroups: [{ VpcSecurityGroupId: "sg-00530a1f4f7648e65" }], DBSubnetGroup: { DBSubnetGroupName: "ogevia-subnets", VpcId: "vpc-0ee9df0c38297cbc1" },
  DBParameterGroups: [{ DBParameterGroupName: "default.postgres18" }], Endpoint: { Address: "prod.example.internal" },
  MasterUserSecret: { SecretArn: "arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-abc-123" }, TagList: [],
};
const ADMIN_JSON = { Reservations: [{ Instances: [{ InstanceId: "i-0ce8db2d7e5839dd5", PrivateIpAddress: "10.20.132.179", VpcId: "vpc-0ee9df0c38297cbc1", NetworkInterfaces: [{ PrivateIpAddresses: [{ PrivateIpAddress: "10.20.132.179" }] }] }] }] };

const AWS_MOCK = readFileSync(new URL("./prd-rehearsal-aws-mock.sh", import.meta.url), "utf8");
const PROXY = readFileSync(new URL("./prd-rehearsal-proxy.cjs", import.meta.url), "utf8");

let counter = 0;
async function run(script: string, args: string[] = [], env: Record<string, string> = {}, input = ""): Promise<{ code: number | null; out: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000) + (counter++ % 7);
  return new Promise((resolve) => {
    const e = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, MOCK_DIR: MOCK, HOME: work, OGEVIA_REHEARSAL_DIR: OUT, OGEVIA_REHEARSAL_PORT: String(port), OGEVIA_SG_RETRY_SLEEP: "0", OGEVIA_TUNNEL_WAIT: "10", ...env };
    const p = spawn("bash", [join(PKGDIR, "ogevia-prd-rehearsal/scripts", script), ...args], { env: e, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* group already gone */ } resolve({ code: c, out }); });
  });
}
const calls = () => (existsSync(join(MOCK, "aws-calls.log")) ? readFileSync(join(MOCK, "aws-calls.log"), "utf8") : "");
const state = () => (existsSync(join(OUT, "state.env")) ? readFileSync(join(OUT, "state.env"), "utf8") : "");
const nowWindow = () => ({ OGEVIA_RELEASE_WINDOW_START: new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, "Z"), OGEVIA_RELEASE_WINDOW_END: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, "Z") });
let migSha = "", rollSha = "";

async function root<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> { const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
async function dbClient(name: string): Promise<pg.Client> { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); return c; }
async function ledger(name: string): Promise<string> { const c = await dbClient(name); try { const r = await c.query("select count(*)::text as n, max(version) as l from ogevia_meta.schema_migrations"); return `${r.rows[0].n}|${r.rows[0].l}`; } finally { await c.end(); } }
async function buildTo0046(name: string) {
  const c = await dbClient(name);
  try {
    await c.query("create schema if not exists ogevia_meta; create table if not exists ogevia_meta.schema_migrations (version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now(), applied_by text not null default current_user)");
    for (const m of loadMigrations().filter((x) => x.version <= "0046")) {
      await c.query("begin"); if (!m.runAsAdmin) await c.query("set local role ogevia_owner");
      await c.query(m.sql); await c.query("reset role");
      await c.query("insert into ogevia_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)", [m.version, m.name, m.checksum]); await c.query("commit");
    }
  } finally { await c.end(); }
}

beforeAll(async () => {
  expect(ADMIN_URL, "OGEVIA_TEST_DATABASE_URL must point at a throwaway local cluster").toMatch(/127\.0\.0\.1|localhost/);
  writeFileSync(join(MOCK, "prod.json"), JSON.stringify(PROD_JSON)); writeFileSync(join(MOCK, "admin.json"), JSON.stringify(ADMIN_JSON)); writeFileSync(join(MOCK, "proxy.js"), PROXY);
  writeFileSync(join(BIN, "aws"), AWS_MOCK); chmodSync(join(BIN, "aws"), 0o755);
  const b = spawnSync("bash", [BUILD, PKGDIR], { encoding: "utf8" });
  expect(b.status, b.stdout + b.stderr).toBe(0);
  migSha = /migrations set sha256: ([0-9a-f]{64})/.exec(b.stdout)![1]!; rollSha = /rollback set sha256:\s+([0-9a-f]{64})/.exec(b.stdout)![1]!;
  await root(async (c) => { for (const n of ["ogevia_prd", "ogevia_sv_test"]) { await c.query(`drop database if exists ${n} with (force)`); await c.query(`create database ${n}`); } });
  await buildTo0046("ogevia_prd");
  const t = await dbClient("ogevia_sv_test"); try { await migrate(t); } finally { await t.end(); }
});
afterAll(async () => { await root(async (c) => { for (const n of ["ogevia_prd", "ogevia_sv_test"]) await c.query(`drop database if exists ${n} with (force)`); }); });

describe("the package", () => {
  it("is built reproducibly with 39 migrations, 39 rollbacks, ledger lists of 46 and 39 and a manifest that verifies", () => {
    const r = spawnSync("bash", ["-c", `cd ${PKGDIR}/ogevia-prd-rehearsal && sha256sum -c --quiet MANIFEST.sha256 && ls migrations | wc -l && ls rollback | wc -l && wc -l < data/LEDGER_0001_0046.tsv && wc -l < data/LEDGER_0047_0085.tsv`], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["39", "39", "46", "39"]);
    expect(migSha).toMatch(/^[0-9a-f]{64}$/); expect(rollSha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AWS side (R0, R1, R2) with a mocked aws", () => {
  it("R0 preflight records the production facts and changes nothing", async () => {
    const r = await run("r0-preflight.sh");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("the installed AWS CLI knows all 11 restore parameters"); expect(r.out).toContain("R0 PASSED");
    const j = JSON.parse(readFileSync(join(OUT, "r0.json"), "utf8"));
    expect(j).toMatchObject({ class: "db.t4g.micro", vpc: "vpc-0ee9df0c38297cbc1", adminIp: "10.20.132.179", endpoint: "prod.example.internal" });
    for (const l of calls().split("\n").filter(Boolean)) expect(l, `R0 must only read: ${l}`).toMatch(/^(sts get-caller-identity|rds describe-|ec2 describe-)|--generate-cli-skeleton/);
  });
  it("R1 refuses outside the window, a wrong phrase, and a snapshot of the wrong instance, then creates and verifies exactly one named snapshot", async () => {
    const out = await run("r1-snapshot.sh", ["create"], { OGEVIA_RELEASE_WINDOW_START: "2020-01-01T00:00:00Z", OGEVIA_RELEASE_WINDOW_END: "2020-01-01T02:00:00Z" }, "SNAPSHOT-NOW\n");
    expect(out.code).toBe(1); expect(out.out).toContain("outside the release window");
    const wrong = await run("r1-snapshot.sh", ["create"], nowWindow(), "no\n");
    expect(wrong.code).toBe(1); expect(wrong.out).toContain("phrase was not typed"); expect(calls()).not.toContain("create-db-snapshot");
    const r = await run("r1-snapshot.sh", ["create"], nowWindow(), "SNAPSHOT-NOW\n");
    expect(r.code, r.out).toBe(0); expect(r.out).toMatch(/SNAPSHOT VERIFIED: ogevia-prod-postgres-pre-rehearsal-\d{12}/);
    expect(calls().split("\n").filter((l) => l.startsWith("rds create-db-snapshot"))).toHaveLength(1);
    const v = await run("r1-snapshot.sh", ["verify"], nowWindow()); expect(v.code, v.out).toBe(0);
    const bad = await run("r1-snapshot.sh", ["verify"], { ...nowWindow(), MOCK_SNAP_INSTANCE: "some-other-instance" }); expect(bad.code).toBe(1); expect(bad.out).toContain("not ogevia-prod-postgres");
    const unenc = await run("r1-snapshot.sh", ["verify"], { ...nowWindow(), MOCK_SNAP_ENC: "false" }); expect(unenc.code).toBe(1); expect(unenc.out).toContain("not encrypted");
  });
  it("R2 restores to a NEW instance with its OWN security group, never touching production or the shared group", async () => {
    const wrong = await run("r2-restore.sh", ["restore"], {}, "RESTORE-wrong\n");
    expect(wrong.code).toBe(1); expect(calls()).not.toContain("create-security-group");
    const r = await run("r2-restore.sh", ["restore"], {}, `RESTORE-${REH}\n`);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain(`RESTORE VERIFIED: ${REH} at rehearsal.example.internal`);
    const c = calls();
    expect(c).toContain("create-security-group --group-name " + REH + "-sg");
    expect(c).toMatch(/authorize-security-group-ingress --group-id sg-0a1b2c3d4e5f60718 .*10\.20\.132\.179\/32/);
    expect(c).toMatch(/restore-db-instance-from-db-snapshot --db-instance-identifier ogevia-prd-rehearsal-\d{8} .*--vpc-security-group-ids sg-0a1b2c3d4e5f60718 --no-publicly-accessible/);
    expect(c).not.toMatch(/--group-id sg-00530a1f4f7648e65/); expect(c).not.toMatch(/(modify-db-instance|delete-db-instance|reboot)/);
    expect(state()).toContain(`REH_ID=${REH}`); expect(state()).toContain("REH_ENDPOINT=rehearsal.example.internal");
    const v = await run("r2-restore.sh", ["verify"]); expect(v.code, v.out).toBe(0);
    const again = await run("r2-restore.sh", ["restore"], {}, `RESTORE-${REH}\n`); expect(again.code).toBe(1); expect(again.out).toContain("already exists");
    const sameEp = await run("r2-restore.sh", ["verify"], { MOCK_REH_ENDPOINT: "prod.example.internal" }); expect(sameEp.code).toBe(1); expect(sameEp.out).toContain("equals production's");
    const noTag = await run("r2-restore.sh", ["verify"], { MOCK_NO_TAG: "1" }); expect(noTag.code).toBe(1); expect(noTag.out).toContain("not tagged");
  });
});

describe("database side (R3-R6) against a real local PostgreSQL and the mocked aws", () => {
  it("R3 refuses an unusable login, then records the baseline: ledger 46|0046, checksums equal the repository, fingerprints of the copy and of the TEST database", async () => {
    const badPw = await run("r3-baseline.sh", [], { MOCK_USERNAME: "no_such_login" });
    expect(badPw.code).toBe(1); expect(badPw.out).toContain("cannot log in to the copy");
    const r = await run("r3-baseline.sh");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("ledger: 46 migrations applied, latest 0046"); expect(r.out).toContain("equal the repository's files"); expect(r.out).toContain("BASELINE RECORDED");
    expect(existsSync(join(OUT, "baseline-fp.tsv"))).toBe(true); expect(existsSync(join(OUT, "baseline-fp-test.tsv"))).toBe(true);
    expect(readFileSync(join(MOCK, "ssm-params.log"), "utf8")).toContain("host=rehearsal.example.internal,portNumber=5432");
    expect(readFileSync(join(MOCK, "ssm-params.log"), "utf8")).not.toContain("prod.example.internal");
  });
  it("R3 reports DRIFT and stops when a ledger checksum differs from the repository", async () => {
    const c = await dbClient("ogevia_prd"); await c.query("update ogevia_meta.schema_migrations set checksum = 'deadbeef' where version = '0010'"); await c.end();
    const r = await run("r3-baseline.sh");
    expect(r.code).toBe(1); expect(r.out).toContain("DRIFT"); expect(r.out).toContain("0010"); expect(r.out).toContain("would refuse");
    const c2 = await dbClient("ogevia_prd"); await c2.query("update ogevia_meta.schema_migrations set checksum = (select checksum from ogevia_meta.schema_migrations s2 where false) where false"); await c2.end();
    // restore the true checksum from the package's list
    const sum = readFileSync(join(PKGDIR, "ogevia-prd-rehearsal/data/LEDGER_0001_0046.tsv"), "utf8").split("\n").find((l) => l.startsWith("0010\t"))!.split("\t")[1]!;
    const c3 = await dbClient("ogevia_prd"); await c3.query("update ogevia_meta.schema_migrations set checksum = $1 where version = '0010'", [sum]); await c3.end();
    const again = await run("r3-baseline.sh"); expect(again.code, again.out).toBe(0);
  });
  it("R4 refuses without the pinned hash, with a wrong hash, with a tampered package and with a wrong phrase; changes nothing", async () => {
    expect((await run("r4-migrate.sh")).out).toContain("OGEVIA_EXPECT_MIGRATIONS_SHA");
    const wrong = await run("r4-migrate.sh", [], { OGEVIA_EXPECT_MIGRATIONS_SHA: "0".repeat(64) }, `MIGRATE-${REH}\n`); expect(wrong.code).toBe(1); expect(wrong.out).toContain("not the approved");
    const declined = await run("r4-migrate.sh", [], { OGEVIA_EXPECT_MIGRATIONS_SHA: migSha }, "no\n"); expect(declined.code).toBe(1); expect(declined.out).toContain("phrase was not typed");
    expect(await ledger("ogevia_prd")).toBe("46|0046");
    const resumeEarly = await run("r4-migrate.sh", ["--resume"], { OGEVIA_EXPECT_MIGRATIONS_SHA: migSha }, `MIGRATE-${REH}\n`); expect(resumeEarly.code).toBe(1); expect(resumeEarly.out).toContain("contiguous ledger between 0047 and 0084");
    const f = join(PKGDIR, "ogevia-prd-rehearsal/migrations"); const name = spawnSync("bash", ["-c", `ls ${f} | head -1`], { encoding: "utf8" }).stdout.trim();
    const orig = readFileSync(join(f, name), "utf8"); writeFileSync(join(f, name), orig + "\n-- tampered\n");
    const tam = await run("r4-migrate.sh", [], { OGEVIA_EXPECT_MIGRATIONS_SHA: migSha }, `MIGRATE-${REH}\n`); writeFileSync(join(f, name), orig);
    expect(tam.code).toBe(1); expect(tam.out).toMatch(/MANIFEST|FAILED/); expect(await ledger("ogevia_prd")).toBe("46|0046");
  });
  it("R4 stops cleanly at a failing file (ledger consistent, that file rolled back) and --resume finishes after the cause is removed", async () => {
    const c = await dbClient("ogevia_prd"); await c.query("create table ogevia.agency_visit_rules (id int)"); await c.end();
    const r = await run("r4-migrate.sh", [], { OGEVIA_EXPECT_MIGRATIONS_SHA: migSha }, `MIGRATE-${REH}\n`);
    expect(r.code).toBe(1); expect(r.out).toContain("MIGRATION FAILED at 0050_"); expect(r.out).toContain("rolled back");
    expect(await ledger("ogevia_prd")).toBe("49|0049");
    const d = await dbClient("ogevia_prd"); await d.query("drop table ogevia.agency_visit_rules"); await d.end();
    const res = await run("r4-migrate.sh", ["--resume"], { OGEVIA_EXPECT_MIGRATIONS_SHA: migSha }, `MIGRATE-${REH}\n`);
    expect(res.code, res.out).toBe(0); expect(res.out).toContain("ledger after: 85 migrations applied, latest 0085");
    expect(await ledger("ogevia_prd")).toBe("85|0085");
    const lines = readFileSync(join(OUT, "migrate.log"), "utf8").trim().split("\n"); expect(lines.length).toBe(36);
  });
  it("psql-applied migrations produce exactly the schema the repository's runner produces (same keys, same digests), and the SQL fingerprint equals the TypeScript one", async () => {
    const t = await dbClient("ogevia_sv_test"); const ts = await fingerprint(t, { data: false }); await t.end();
    const p = await dbClient("ogevia_prd"); const tsPrd = await fingerprint(p, { data: false }); await p.end();
    expect(diffFingerprints(ts, tsPrd), "runner-built TEST schema vs psql-built production-copy schema").toEqual([]);
  });
  it("R5 verifies: ledger checksums, the repository verification set, schema parity with the TEST copy, existing data unchanged", async () => {
    const r = await run("r5-verify.sh");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("all 85 ledger checksums equal the repository's files"); expect(r.out).toMatch(/schema parity with the copy of TEST/); expect(r.out).toMatch(/existing data unchanged/); expect(r.out).toContain("VERIFIED:");
    expect(r.out).not.toContain("FAIL");
    const sqlFp = Object.fromEntries(readFileSync(join(OUT, "after-fp.tsv"), "utf8").split("\n").filter(Boolean).map((l) => l.split("\t") as [string, string]));
    const p = await dbClient("ogevia_prd"); const tsFp = await fingerprint(p, { data: false }); await p.end();
    const sqlSchema = Object.fromEntries(Object.entries(sqlFp).filter(([k]) => !k.startsWith("data:")));
    expect(diffFingerprints(sqlSchema, tsFp), "SQL fingerprint vs TypeScript fingerprint").toEqual([]);
  });
  it("R5 detects a changed row in an existing table (C4) and a schema difference from the TEST copy (C3)", async () => {
    const exec = async (sql: string) => { const c = await dbClient("ogevia_prd"); try { await c.query(sql); } finally { await c.end(); } };
    try {
      await exec("insert into ogevia.app_users (cognito_sub, display_name) values ('00000000-0000-4000-8000-0000000000aa', 'tamper')");
      const r = await run("r5-verify.sh"); expect(r.code).toBe(1); expect(r.out).toContain("row-count-changed ogevia.app_users");
    } finally { await exec("delete from ogevia.app_users where cognito_sub = '00000000-0000-4000-8000-0000000000aa'"); }
    try {
      await exec("alter table ogevia.shifts add column rehearsal_drift int");
      const s = await run("r5-verify.sh"); expect(s.code).toBe(1); expect(s.out).toContain("column:ogevia.shifts.rehearsal_drift");
    } finally { await exec("alter table ogevia.shifts drop column if exists rehearsal_drift"); }
    const ok = await run("r5-verify.sh"); expect(ok.code, ok.out).toBe(0);
  });
  it("R6 refuses a wrong rollback hash and a wrong phrase, then rolls 0085 back to 0047: ledger 46|0046, schema equals the baseline except the 11 kept objects", async () => {
    const wrong = await run("r6-rollback.sh", [], { OGEVIA_EXPECT_ROLLBACK_SHA: "1".repeat(64) }, `ROLLBACK-${REH}\n`); expect(wrong.code).toBe(1); expect(wrong.out).toContain("not the approved");
    const declined = await run("r6-rollback.sh", [], { OGEVIA_EXPECT_ROLLBACK_SHA: rollSha }, "no\n"); expect(declined.code).toBe(1); expect(await ledger("ogevia_prd")).toBe("85|0085");
    const r = await run("r6-rollback.sh", [], { OGEVIA_EXPECT_ROLLBACK_SHA: rollSha }, `ROLLBACK-${REH}\n`);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("ROLLED BACK"); expect(r.out).toContain("ledger after: 46 migrations applied, latest 0046");
    expect(await ledger("ogevia_prd")).toBe("46|0046");
    expect(readFileSync(join(OUT, "rollback.log"), "utf8").trim().split("\n")).toHaveLength(39);
  });
});

describe("teardown (R8) and the guarantees about production", () => {
  it("R8 plan changes nothing; execute needs the exact phrase, deletes only the tagged rehearsal instance and its own group, and keeps the snapshot unless asked", async () => {
    const plan = await run("r8-teardown.sh", ["plan"]); expect(plan.code, plan.out).toBe(0); expect(plan.out).toContain("PLAN ONLY"); expect(plan.out).toContain("is KEPT");
    const noTag = await run("r8-teardown.sh", ["execute"], { MOCK_NO_TAG: "1" }, `DELETE-${REH}\n`); expect(noTag.code).toBe(1); expect(noTag.out).toContain("not tagged"); expect(calls()).not.toContain("delete-db-instance");
    const wrong = await run("r8-teardown.sh", ["execute"], {}, "DELETE-ogevia-prod-postgres\n"); expect(wrong.code).toBe(1); expect(calls()).not.toContain("delete-db-instance");
    writeFileSync(join(MOCK, "sg-busy"), "2");
    const r = await run("r8-teardown.sh", ["execute"], {}, `DELETE-${REH}\n`);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("TEARDOWN DONE");
    expect(calls()).toContain(`delete-db-instance --db-instance-identifier ${REH} --skip-final-snapshot`);
    expect(calls()).not.toContain("delete-db-snapshot"); expect(existsSync(join(MOCK, "reh.env"))).toBe(false); expect(existsSync(join(MOCK, "sg.env"))).toBe(false);
    expect(existsSync(join(MOCK, "snap.env"))).toBe(true);
    const snap = await run("r8-teardown.sh", ["execute", "--also-snapshot"], {}, `DELETE-${REH}\nDELETE-SNAPSHOT-${state().match(/SNAP_ID=(\S+)/)![1]}\n`);
    expect(snap.code, snap.out).toBe(0); expect(calls()).toContain("delete-db-snapshot"); expect(existsSync(join(MOCK, "snap.env"))).toBe(false);
  });
  it("across the whole run: no call modified production, the shared security group, or anything the mock did not know", () => {
    const c = calls();
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
    expect(c).not.toMatch(/--group-id sg-00530a1f4f7648e65/); expect(c).not.toMatch(/modify-db-instance/);
    expect(c).not.toMatch(/delete-db-instance --db-instance-identifier ogevia-prod-postgres/); expect(c).not.toMatch(/(cloudformation|lambda|cognito|s3 |s3api|route53)/);
    expect(c).not.toMatch(/revoke-security-group/);
  });
});
