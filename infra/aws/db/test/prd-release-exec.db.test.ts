// Production release package, EXECUTION stages (C1 snapshot, D1 migration executor, D2 deploy-mode assembly, D3 web guard, E1 record): every script is run against a MOCKED aws CLI
// (stateful security group, snapshots and web bucket), a REAL local PostgreSQL 16 for ogevia_prd, fake cdk/vite programs, and the REAL release templates synthesized by the package build.
// Nothing here contacts AWS. The local cluster must be a throwaway: the test creates databases named ogevia_prd and ogevia_sv_test and drops them afterwards.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMigrations, migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

vi.setConfig({ testTimeout: 600000, hookTimeout: 600000 });
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const BUILD = join(REPO, "docs/releases/2026-10-19-prd-readiness/release/build-package.sh");
const MOCKSRC = fileURLToPath(new URL("./prd-release-exec-aws-mock.sh", import.meta.url));
const PROXY = readFileSync(new URL("./prd-rehearsal-proxy.cjs", import.meta.url), "utf8");
const work = mkdtempSync(join(tmpdir(), "prdexec-"));
const BIN = join(work, "bin"), MOCK = join(work, "mock"), PKGDIR = join(work, "pkg"), OUT = join(work, "before"), ROOT = join(PKGDIR, "ogevia-prd-release");
const STACKS = ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-WebHosting", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-Observability", "Ogevia-prod-NetworkEgress"];
const API = "Ogevia-prd-ServiceVerificationApi", PRD_API = "zk527zk4ua", CODE = "e80b770210c54e423d28ecf48e00f1dda9506cec";
const LIVE_HK = "4832b6ba4f8ff1b8706697326b0d76d3d96d5031265c0d6024ee10c1e194817c.zip", LIVE_IK = "e345075a65c98ef8fae929be46fb48be5c3c268702af0f409df509fb3634791b.zip";
const REF = "owner-go-20261021-01", HOSTIP = "10.20.132.179";
const SNAP = "ogevia-prod-postgres-pre-prdrelease-202610210100";
let migSha = "", rollSha = "", srcCommit = "", counter = 0; let dirtyResign: (tree: string) => unknown = () => undefined;

const sh = (cmd: string) => spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
const calls = () => (existsSync(join(MOCK, "aws-calls.log")) ? readFileSync(join(MOCK, "aws-calls.log"), "utf8") : "");
const writes = () => (existsSync(join(MOCK, "writes.log")) ? readFileSync(join(MOCK, "writes.log"), "utf8") : "");
let allWrites = "";
const clearLogs = () => { allWrites += writes(); for (const f of ["aws-calls.log", "writes.log"]) rmSync(join(MOCK, f), { force: true }); };
const sgFile = () => JSON.stringify(JSON.parse(readFileSync(join(MOCK, "sg.json"), "utf8")));
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const win = () => ({ OGEVIA_RELEASE_WINDOW_START: iso(Date.now() - 3600_000), OGEVIA_RELEASE_WINDOW_END: iso(Date.now() + 3600_000) });
const d1env = (extra: Record<string, string> = {}) => ({ OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_EXPECT_COMMIT: srcCommit, OGEVIA_EXPECT_HOST_IP: HOSTIP, OGEVIA_EXPECT_MIGRATIONS_SHA: migSha, OGEVIA_EXPECT_ROLLBACK_SHA: rollSha, OGEVIA_PREDEPLOY_SNAPSHOT_ID: SNAP, ...win(), ...extra });

function setLive(mutate?: (stack: string, t: Record<string, any>) => void) {
  for (const s of STACKS) { const t = JSON.parse(readFileSync(join(ROOT, "release-templates", `${s}.json`), "utf8")); mutate?.(s, t); writeFileSync(join(MOCK, "templates", `${s}.json`), JSON.stringify(t)); }
}
/** production API template as the baseline described it, derived from the release template (same construction as the discovery tests) */
function modelLive(): Record<string, any> {
  const t = JSON.parse(readFileSync(join(ROOT, "release-templates", `${API}.json`), "utf8")); const R = t.Resources;
  const jwt = Object.keys(R).filter((k) => R[k].Type === "AWS::ApiGatewayV2::Route" && R[k].Properties.AuthorizationType === "JWT").sort();
  let seed = 7; const pick = new Set<string>(); while (pick.size < 66) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pick.add(jwt[seed % jwt.length]!); }
  for (const k of pick) delete R[k];
  delete R.ComplianceSweep51D1109D; for (const k of Object.keys(R)) if (k.startsWith("ComplianceSweepAllow")) delete R[k];
  R.Handler886CB40B.Properties.Code.S3Key = LIVE_HK; R.IdentityHandler6F0A3417.Properties.Code.S3Key = LIVE_IK;
  R.IdentityHandler6F0A3417.Properties.Description = "Ogevia caregiver invitations: Cognito AdminCreateUser/AdminGetUser only";
  R.IdentityRole07BDF020.Properties.Description = "Ogevia caregiver invitation identity function (Cognito create/resend only)";
  for (const [pol, sid] of [["HandlerPolicy7544C855", "ClientDocumentObjects"], ["IdentityPolicyF3EE534F", "SwitchSignInsOnOff"]] as const) { const d = R[pol].Properties.PolicyDocument; d.Statement = d.Statement.filter((x: any) => x.Sid !== sid); }
  return t;
}
const setProductionState = () => setLive((s, t) => { if (s === API) t.Resources = modelLive().Resources; });
const pairs = (extra = "", version = "") => `const e={VITE_APP_ENV:"production",VITE_AUTH_PROVIDER:"cognito",VITE_COGNITO_CLIENT_ID:"4abcdefghijk",VITE_COGNITO_DOMAIN:"https://ogevia-prd.auth.us-west-2.amazoncognito.com",VITE_COGNITO_REGION:"us-west-2",VITE_COGNITO_USER_POOL_ID:"us-west-2_849AYz5J7",VITE_SV_API_BASE_URL:"https://${PRD_API}.execute-api.us-west-2.amazonaws.com"${extra}${version ? `,VITE_APP_VERSION:"${version}"` : ""}};`;
function setLiveWeb(js = pairs()) {
  rmSync(join(MOCK, "web"), { recursive: true, force: true }); mkdirSync(join(MOCK, "web/assets"), { recursive: true });
  writeFileSync(join(MOCK, "web/index.html"), '<!doctype html><script type="module" src="/assets/index-OLD111.js"></script>\n'); writeFileSync(join(MOCK, "web/assets/index-OLD111.js"), js); writeFileSync(join(MOCK, "web/assets/style-OLD.css"), "body{}");
}
async function run(script: string, args: string[] = [], env: Record<string, string> = {}, input = ""): Promise<{ code: number | null; out: string }> {
  const port = 21000 + Math.floor(Math.random() * 20000) + (counter++ % 7);
  return new Promise((resolve) => {
    const e = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, MOCK_DIR: MOCK, HOME: work, OGEVIA_PRD_BEFORE: OUT, OGEVIA_MIGRATE_PORT: String(port), OGEVIA_SG_RETRY_SLEEP: "0", OGEVIA_TUNNEL_WAIT: "10", OGEVIA_CDN_WAIT: "0", OGEVIA_SNAPSHOT_POLL: "0", ...env };
    const p = spawn("bash", [join(ROOT, "scripts", script), ...args], { env: e, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* group gone */ } resolve({ code: c, out }); });
  });
}
async function root<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> { const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
async function dbClient(name: string): Promise<pg.Client> { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); return c; }
async function ledger(): Promise<string> { const c = await dbClient("ogevia_prd"); try { const r = await c.query("select count(*)::text as n, max(version) as l from ogevia_meta.schema_migrations"); return `${r.rows[0].n}|${r.rows[0].l}`; } finally { await c.end(); } }
async function buildTo0046() {
  const c = await dbClient("ogevia_prd");
  try {
    await c.query("create schema if not exists ogevia_meta; create table if not exists ogevia_meta.schema_migrations (version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now(), applied_by text not null default current_user)");
    for (const m of loadMigrations().filter((x) => x.version <= "0046")) {
      await c.query("begin"); if (!m.runAsAdmin) await c.query("set local role ogevia_owner");
      await c.query(m.sql); await c.query("reset role");
      await c.query("insert into ogevia_meta.schema_migrations (version, name, checksum) values ($1, $2, $3)", [m.version, m.name, m.checksum]); await c.query("commit");
    }
  } finally { await c.end(); }
}
function resetSecurityGroup() {
  writeFileSync(join(MOCK, "sg.json"), JSON.stringify({ SecurityGroups: [{ GroupId: "sg-00530a1f4f7648e65", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [], Ipv6Ranges: [], PrefixListIds: [], UserIdGroupPairs: [{ GroupId: "sg-064ffce3bcbe8eb3b", UserId: "300094796789" }] }], IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }], Ipv6Ranges: [], PrefixListIds: [], UserIdGroupPairs: [] }] }] }));
}

beforeAll(async () => {
  expect(ADMIN_URL, "OGEVIA_TEST_DATABASE_URL must point at a throwaway local cluster").toMatch(/127\.0\.0\.1|localhost/);
  for (const d of [BIN, join(MOCK, "templates"), OUT]) mkdirSync(d, { recursive: true });
  copyFileSync(MOCKSRC, join(BIN, "aws")); chmodSync(join(BIN, "aws"), 0o755); writeFileSync(join(MOCK, "proxy.js"), PROXY); writeFileSync(join(MOCK, "code.zip"), "PK mock lambda zip bytes");
  writeFileSync(join(MOCK, "endpoint-policy.json"), JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: ["arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2/*", "arn:aws:s3:::ogevia-prd-signature-evidence-300094796789-us-west-2/*"] }] }));
  writeFileSync(join(MOCK, "admin.json"), JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-0ce8db2d7e5839dd5", PrivateIpAddress: HOSTIP, VpcId: "vpc-0ee9df0c38297cbc1", State: { Name: "running" }, SecurityGroups: [{ GroupId: "sg-00e01e2ca80442c1f" }], NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", PrivateIpAddresses: [{ PrivateIpAddress: HOSTIP }] }] }] }] }));
  writeFileSync(join(MOCK, "nic-by-group.json"), JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", Attachment: { InstanceId: "i-0ce8db2d7e5839dd5" } }, { NetworkInterfaceId: "eni-0bbb", Attachment: { InstanceId: "i-other" } }] }));
  writeFileSync(join(MOCK, "nic-by-ip.json"), JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", Attachment: { InstanceId: "i-0ce8db2d7e5839dd5" } }] }));
  resetSecurityGroup(); writeFileSync(join(MOCK, "snaps.txt"), `${SNAP} ${Math.floor(Date.now() / 1000)}\n`);
  const b = spawnSync("bash", [BUILD, PKGDIR], { encoding: "utf8" });
  expect(b.status, b.stdout + b.stderr).toBe(0);
  srcCommit = /source commit: ([0-9a-f]{40})/.exec(b.stdout)![1]!;
  // the working tree has uncommitted edits while the package is under development, so BUILD_INFO says DIRTY (d1 refuses that, and a test below proves it). Re-sign a CLEAN copy for the rest of the tests.
  const resign = (tree: string) => sh(`cd ${ROOT} && jq '.source_tree="${tree}"' BUILD_INFO.json > b.tmp && mv b.tmp BUILD_INFO.json && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\\./||' | xargs sha256sum > MANIFEST.sha256`);
  resign("DIRTY"); expect(JSON.parse(readFileSync(join(ROOT, "BUILD_INFO.json"), "utf8")).source_tree).toBe("DIRTY"); dirtyResign = resign;
  const info = JSON.parse(readFileSync(join(ROOT, "BUILD_INFO.json"), "utf8")); migSha = info.migrations_0047_0085_set_sha256; rollSha = info.rollback_0047_0085_set_sha256;
  await root(async (c) => { for (const n of ["ogevia_prd", "ogevia_sv_test"]) { await c.query(`drop database if exists ${n} with (force)`); await c.query(`create database ${n}`); } });
  await buildTo0046();
  setProductionState(); setLiveWeb();
});
const dirtyCase = async () => { const r = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(r.code).toBe(1); expect(r.out).toContain("DIRTY source tree"); expect(writes()).toBe(""); };
afterAll(async () => { await root(async (c) => { for (const n of ["ogevia_prd", "ogevia_sv_test"]) await c.query(`drop database if exists ${n} with (force)`); }); });

describe("the package", () => {
  it("carries the rehearsed database payload and pins it: manifest verifies; 39 migrations, 39 rollbacks, the rehearsed hashes", () => {
    const r = sh(`cd ${ROOT} && sha256sum -c --quiet MANIFEST.sha256 && ls migrations | wc -l && ls rollback | wc -l && ls verification | wc -l && wc -l < data/LEDGER_0001_0046.tsv && wc -l < data/LEDGER_0047_0085.tsv && ls scripts`);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const l = r.stdout.trim().split("\n"); expect(l.slice(0, 5)).toEqual(["39", "39", "8", "46", "39"]);
    for (const f of ["c1-snapshot-prd.sh", "d1-migrate-prd.sh", "d2-assemble-prd.sh", "d3-web-prd.sh", "e1-record-deployed-prd.sh", "window.sh", "fp-compare.py"]) expect(l).toContain(f);
    expect(migSha).toBe("ad0e2910180ddd8047347a988a903db1e2a42122cb1e73f641bf7ee7a108da49"); expect(rollSha).toBe("703c4cd9f0880b42dd38347cc2388ebb106f074647f76a3f838bab01a5f11799");
    expect(readFileSync(join(ROOT, "scripts/d1-migrate-prd.sh"), "utf8")).toContain(migSha); expect(readFileSync(join(ROOT, "scripts/d1-migrate-prd.sh"), "utf8")).toContain(rollSha);
  });
  it("p0 baseline: the mock production state is capturable (precondition for every later step)", async () => {
    const r = await run("p0-baseline-capture.sh"); expect(r.code, r.out).toBe(0);
  });
});

describe("package cleanliness", () => {
  it("d1 refuses a package built from a DIRTY source tree, then accepts the same package re-signed clean", async () => {
    await dirtyCase(); dirtyResign("clean");
    expect((await run("p0-baseline-capture.sh")).code).toBe(0);
  });
});

describe("C1 snapshot", () => {
  it("refuses outside the window, without the approval reference and on a wrong phrase; creates exactly one named snapshot after the phrase and verifies it", async () => {
    clearLogs();
    const o = await run("c1-snapshot-prd.sh", ["create"], { OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_RELEASE_WINDOW_START: "2020-01-01T00:00:00Z", OGEVIA_RELEASE_WINDOW_END: "2020-01-01T02:00:00Z" }, "SNAPSHOT-NOW\n"); expect(o.code).toBe(1); expect(o.out).toContain("not inside a valid release window");
    const n = await run("c1-snapshot-prd.sh", ["create"], win(), "SNAPSHOT-NOW\n"); expect(n.code).toBe(1); expect(n.out).toContain("approval reference");
    const w = await run("c1-snapshot-prd.sh", ["create"], { OGEVIA_DEPLOY_APPROVAL: REF, ...win() }, "no\n"); expect(w.code).toBe(0); expect(w.out).toContain("Declined"); expect(writes()).toBe("");
    const r = await run("c1-snapshot-prd.sh", ["create"], { OGEVIA_DEPLOY_APPROVAL: REF, ...win() }, "SNAPSHOT-NOW\n");
    expect(r.code, r.out).toBe(0); expect(r.out).toMatch(/SNAPSHOT VERIFIED: ogevia-prod-postgres-pre-prdrelease-\d{12}/);
    expect(writes().split("\n").filter((l) => l.startsWith("rds create-db-snapshot"))).toHaveLength(1); expect(writes()).toContain("--db-instance-identifier ogevia-prod-postgres");
    expect(existsSync(join(OUT, "predeploy-snapshot-id.txt"))).toBe(true);
  });
  it("verify is read-only and rejects a stale, unencrypted, unavailable, wrongly named or out-of-window snapshot", async () => {
    clearLogs();
    expect((await run("c1-snapshot-prd.sh", ["verify"], { OGEVIA_PREDEPLOY_SNAPSHOT_ID: SNAP })).code).toBe(0); expect(writes()).toBe("");
    const t = async (env: Record<string, string>, text: string) => { const r = await run("c1-snapshot-prd.sh", ["verify"], { OGEVIA_PREDEPLOY_SNAPSHOT_ID: SNAP, ...env }); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); };
    await t({ MOCK_SNAP_AGE: "90000" }, "minutes ago; the limit"); await t({ MOCK_SNAP_ENC: "false" }, "not a manual, encrypted"); await t({ MOCK_SNAP_STATUS: "creating" }, "not available");
    await t({ OGEVIA_RELEASE_WINDOW_START: "2020-01-01T00:00:00Z", OGEVIA_RELEASE_WINDOW_END: "2020-01-01T02:00:00Z" }, "outside the release window");
    await t({ OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0085-202610192111" }, "does not match");
    const nf = await run("c1-snapshot-prd.sh", ["verify"], { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-prdrelease-209901010000" }); expect(nf.code).toBe(1); expect(nf.out).toContain("cannot read snapshot");
  });
});

describe("D1 production migration executor (real PostgreSQL, mocked AWS)", () => {
  it("refuses every missing or wrong pin BEFORE any access is proposed, and opens no window", async () => {
    clearLogs(); const sg0 = sgFile();
    const cases: [Record<string, string>, string][] = [
      [{ OGEVIA_DEPLOY_APPROVAL: "x" }, "approval reference"], [{ OGEVIA_EXPECT_COMMIT: "0".repeat(40) }, "not the approved"], [{ OGEVIA_EXPECT_MIGRATIONS_SHA: "0".repeat(64) }, "approved (and rehearsed) set"],
      [{ OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0085-202610192111" }, "pre-release snapshot"], [{ OGEVIA_RELEASE_WINDOW_START: "" }, "OGEVIA_RELEASE_WINDOW_START"],
      [{ OGEVIA_RELEASE_WINDOW_START: iso(Date.now() + 3600_000), OGEVIA_RELEASE_WINDOW_END: iso(Date.now() + 7200_000) }, "has not started"], [{ OGEVIA_RELEASE_WINDOW_START: iso(Date.now() - 7200_000), OGEVIA_RELEASE_WINDOW_END: iso(Date.now() - 3600_000) }, "ended at"],
      [{ MOCK_SNAP_AGE: "90000" }, "outside the release window"], [{ MOCK_SNAP_ENC: "false" }, "not available, manual, encrypted"], [{ MOCK_SNAP_STATUS: "creating" }, "not available, manual, encrypted"], [{ OGEVIA_EXPECT_HOST_IP: "10.20.132.1" }, "OGEVIA_EXPECT_HOST_IP"],
    ];
    for (const [env, text] of cases) { const r = await run("d1-migrate-prd.sh", ["migrate"], d1env(env), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(r.code, `${text}: ${r.out}`).toBe(1); expect(r.out, text).toContain(text); }
    expect(writes()).toBe(""); expect(sgFile()).toBe(sg0); expect(await ledger()).toBe("46|0046");
    for (const bad of ["", "nonsense", "migrate nonsense", "rollback extra"]) expect((await run("d1-migrate-prd.sh", bad ? bad.split(" ") : [], d1env())).code).toBe(2);
  });
  it("refuses a dirty/tampered package and a Lambda that does not serve production, and when the release gate fails (production changed after the baseline)", async () => {
    clearLogs();
    const wrongEnv = await run("d1-migrate-prd.sh", ["migrate"], d1env({ MOCK_LAMBDA_DB: "ogevia_sv_test" }), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(wrongEnv.code).toBe(1); expect(wrongEnv.out).toContain("Not the production environment");
    setLive((s, t) => { if (s === API) { t.Resources = modelLive().Resources; t.Resources.Surprise = { Type: "AWS::SQS::Queue", Properties: {} }; } });
    const gate = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(gate.code).toBe(1); expect(gate.out).toContain("the release gate failed"); expect(writes()).toBe("");
    setProductionState();
    writeFileSync(join(ROOT, "stray.txt"), "x"); const s1 = await run("d1-migrate-prd.sh", ["migrate"], d1env()); expect(s1.code).toBe(1); expect(s1.out).toContain("not in the manifest"); rmSync(join(ROOT, "stray.txt"));
    const f = join(ROOT, "migrations/0050_create_deadlines_and_plan_status.sql"); const orig = sh(`ls ${ROOT}/migrations | sed -n 4p`).stdout.trim(); const target = join(ROOT, "migrations", orig); const o2 = readFileSync(target, "utf8");
    writeFileSync(target, o2 + "\n-- tampered\n"); const s2 = await run("d1-migrate-prd.sh", ["migrate"], d1env()); expect(s2.code).toBe(1); expect(s2.out).toContain("do not match MANIFEST"); writeFileSync(target, o2); void f;
    expect(writes()).toBe("");
  });
  it("a wrong phrase declines with nothing changed; a window opened for a ledger that is not 46|0046 stops, and the security group is restored", async () => {
    clearLogs(); const sg0 = sgFile();
    const d = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "yes please\n"); expect(d.code).toBe(0); expect(d.out).toContain("Declined"); expect(writes()).toBe(""); expect(sgFile()).toBe(sg0);
    const c = await dbClient("ogevia_prd"); await c.query("delete from ogevia_meta.schema_migrations where version = '0046'"); await c.end();
    const r = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("not exactly 46|0046"); expect(r.out).toContain("RESTORED (verified)"); expect(sgFile()).toBe(sg0); expect(writes()).toContain("authorize sg-00530a1f4f7648e65 10.20.132.179/32"); expect(writes()).toContain("revoke sg-00530a1f4f7648e65 10.20.132.179/32");
    expect(existsSync(join(OUT, "db-at-0085.ok"))).toBe(false);
    const c2 = await dbClient("ogevia_prd"); await c2.query("insert into ogevia_meta.schema_migrations (version, name, checksum) select '0046', name, checksum from ogevia_meta.schema_migrations where version = '0045'"); await c2.query("update ogevia_meta.schema_migrations set name = (select name from ogevia_meta.schema_migrations where version = '0045') where false"); await c2.end();
    // the re-inserted 0046 row carries 0045's checksum: DRIFT must stop the run even though the count is 46
    const dr = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(dr.code).toBe(1); expect(dr.out).toContain("DRIFT"); expect(sgFile()).toBe(sg0);
    const c3 = await dbClient("ogevia_prd"); const m = loadMigrations().find((x) => x.version === "0046")!; await c3.query("update ogevia_meta.schema_migrations set name = $1, checksum = $2 where version = '0046'", [m.name, m.checksum]); await c3.end();
    expect(await ledger()).toBe("46|0046");
  });
  it("a migration that cannot complete (advisory lock held) fails the run: no marker, ledger unchanged, security group restored", async () => {
    clearLogs(); const sg0 = sgFile(); const holder = await dbClient("ogevia_prd"); await holder.query("select pg_advisory_lock(4317001)");
    try {
      const r = await run("d1-migrate-prd.sh", ["migrate"], d1env({ OGEVIA_MIGRATE_FILE_TIMEOUT: "3" }), "OPEN-5432-WINDOW-MIGRATE-PRD\n");
      expect(r.code, r.out).toBe(1); expect(r.out).toContain("MIGRATION FAILED at 0047"); expect(r.out).toContain("DO NOT deploy the API or web"); expect(r.out).toContain("RESTORED (verified)");
    } finally { await holder.end(); }
    expect(sgFile()).toBe(sg0); expect(existsSync(join(OUT, "db-at-0085.ok"))).toBe(false); expect(await ledger()).toBe("46|0046");
  });
  it("migrates 0047-0085: ledger 85|0085, checksums, 8 verification files, data unchanged, marker written, window closed and the group identical, master secret read once", async () => {
    clearLogs(); const sg0 = sgFile();
    const r = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n");
    expect(r.code, r.out).toBe(0);
    for (const t of ["snapshot " + SNAP, "release gate (read-only)", "ledger before: 46 migrations applied, latest 0046", "ledger checksums equal the repository's files (46 rows)", "ledger after: 85 migrations applied, latest 0085", "all 85 ledger checksums equal", "PASS existing data unchanged", "RESTORED (verified)", "SECURITY GROUP: restored and verified identical to the original", "NEXT (do not wait)"]) expect(r.out, t).toContain(t);
    expect((r.out.match(/PASS verification /g) ?? []).length).toBe(8); expect(r.out).not.toContain("FAIL");
    expect(await ledger()).toBe("85|0085"); expect(readFileSync(join(OUT, "db-at-0085.ok"), "utf8").trim()).toBe("85|0085"); expect(readFileSync(join(OUT, "db-at-0085.snapshot"), "utf8").trim()).toBe(SNAP);
    expect(sgFile()).toBe(sg0); const w = writes().split("\n").filter(Boolean);
    expect(w.filter((l) => l.startsWith("authorize"))).toEqual(["authorize sg-00530a1f4f7648e65 10.20.132.179/32 TEMP-prdmigrate-" + /TEMP-prdmigrate-(\S+)/.exec(writes())![1]]);
    expect(w.filter((l) => l.startsWith("revoke"))).toHaveLength(1); expect(w.filter((l) => l === "secret read")).toHaveLength(1);
    expect(readFileSync(join(MOCK, "writes.log"), "utf8")).toContain("ssm start-session"); expect(calls()).not.toMatch(/ogevia_sv_test/);
    expect(existsSync(join(OUT, "window", "OPEN"))).toBe(false);
    const again = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(again.code).toBe(1); expect(again.out).toContain("not exactly 46|0046");
  });
  it("the verified marker satisfies the API deploy guard's migration prerequisite (and nothing else is bypassed)", async () => {
    const asm = join(work, "empty-asm"); mkdirSync(asm, { recursive: true }); const cdk = join(work, "cdk-ver"); writeFileSync(cdk, '#!/usr/bin/env bash\necho "2.1143.0 (x)"\n'); chmodSync(cdk, 0o755);
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => { const p = spawn("bash", [join(ROOT, "scripts/deploy-guard-prd.sh"), "deploy", API], { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, MOCK_DIR: MOCK, HOME: work, OGEVIA_PRD_BEFORE: OUT, OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_PRD_ASSEMBLY: asm, OGEVIA_CDK_BIN: cdk, OGEVIA_PREDEPLOY_SNAPSHOT_ID: SNAP }, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("close", (c) => resolve({ code: c, out })); });
    expect(r.code, r.out).toBe(1); expect(r.out).not.toContain("migrated to 0085 BEFORE"); expect(r.out).toContain("the assembly is not the approved release"); // past the marker, snapshot and gate; stopped by the (empty) assembly
  });
  it("rollback needs BOTH phrases, drops back to 46|0046, removes the marker, compares with the baseline, and restores the group", async () => {
    clearLogs(); const sg0 = sgFile();
    const one = await run("d1-migrate-prd.sh", ["rollback"], d1env(), "OPEN-5432-WINDOW-ROLLBACK-PRD\nnope\n"); expect(one.code).toBe(0); expect(one.out).toContain("Declined"); expect(writes()).toBe(""); expect(await ledger()).toBe("85|0085");
    const badSha = await run("d1-migrate-prd.sh", ["rollback"], d1env({ OGEVIA_EXPECT_ROLLBACK_SHA: "0".repeat(64) }), "x\n"); expect(badSha.code).toBe(1); expect(badSha.out).toContain("approved set");
    const r = await run("d1-migrate-prd.sh", ["rollback"], d1env(), "OPEN-5432-WINDOW-ROLLBACK-PRD\nROLLBACK-DROPS-DATA-ogevia_prd\n");
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("ledger after: 46 migrations applied, latest 0046"); expect(r.out).toContain("PASS schema equals the baseline"); expect(r.out).toContain("RESTORED (verified)");
    expect(await ledger()).toBe("46|0046"); expect(existsSync(join(OUT, "db-at-0085.ok"))).toBe(false); expect(sgFile()).toBe(sg0);
    const re = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(re.code, re.out).toBe(0); expect(await ledger()).toBe("85|0085");
  });
  it("an interrupted window: if the rule cannot be removed the run exits 3 with exact manual steps, the marker stays, and --restore-only verifies the restoration", async () => {
    clearLogs(); const sg0 = sgFile();
    const r = await run("d1-migrate-prd.sh", ["migrate"], d1env({ MOCK_REVOKE_FAIL: "1" }), "OPEN-5432-WINDOW-MIGRATE-PRD\n");
    expect(r.code, r.out).toBe(3); expect(r.out).toContain("NOT RESTORED"); expect(r.out).toContain("revoke-security-group-ingress"); expect(existsSync(join(OUT, "window", "OPEN"))).toBe(true); expect(sgFile()).not.toBe(sg0);
    const blocked = await run("d1-migrate-prd.sh", ["migrate"], d1env(), "OPEN-5432-WINDOW-MIGRATE-PRD\n"); expect(blocked.code).toBe(1); expect(blocked.out).toContain("marked OPEN");
    const fix = await run("d1-migrate-prd.sh", ["--restore-only"]); expect(fix.code, fix.out).toBe(0); expect(fix.out).toContain("RESTORED (verified)"); expect(sgFile()).toBe(sg0); expect(existsSync(join(OUT, "window", "OPEN"))).toBe(false);
    const none = await run("d1-migrate-prd.sh", ["--restore-only"]); expect(none.code).toBe(0); expect(none.out).toContain("nothing to restore");
  });
  it("uses only the permitted AWS verbs and never names the TEST database", () => {
    for (const l of calls().split("\n").filter(Boolean)) expect(l.split(" ").slice(0, 2).join(" "), l).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda get-function-configuration|rds (describe-db-instances|describe-db-snapshots)|ec2 (describe-instances|describe-network-interfaces|describe-security-groups|authorize-security-group-ingress|revoke-security-group-ingress)|ssm start-session|secretsmanager get-secret-value)$/);
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
  });
});

describe("D2 deploy-mode assembly workflow", () => {
  const OP = join(work, "opkg"), ASM = join(work, "asm-out");
  const fakeCdk = `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo "\${FAKE_CDK_VERSION:-2.1143.0} (build x)"; exit 0; fi
[[ "$1" == synth ]] || exit 9
echo "$*" > "$FAKE_CDK_LOG"; echo "approval=$OGEVIA_DEPLOY_APPROVAL" >> "$FAKE_CDK_LOG"
while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && OUTD="$2"; shift; done
mkdir -p "$OUTD"; TAG="\${FAKE_TAG:-approved-$OGEVIA_DEPLOY_APPROVAL}"
for S in Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability; do
  jq --arg v "$TAG" 'walk(if type=="object" and .Key=="ogevia:deployment-status" then .Value=$v elif type=="object" and has("ogevia:deployment-status") then .["ogevia:deployment-status"]=$v else . end)' "$RELEASE_TPL/$S.json" > "$OUTD/$S.template.json"; done
for h in eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda 7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759; do mkdir -p "$OUTD/asset.$h"; done
echo '{}' > "$OUTD/manifest.json"; [[ -n "\${FAKE_EXTRA:-}" ]] && echo '{}' > "$OUTD/Ogevia-prod-NetworkEgress.template.json"; exit 0
`;
  const env = (extra: Record<string, string> = {}) => ({ OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_OPERATOR_PKG: OP, OGEVIA_PRD_ASSEMBLY_DIR: ASM, FAKE_CDK_LOG: join(work, "cdk.log"), RELEASE_TPL: join(ROOT, "release-templates"), ...extra });
  const rehash = () => sh(`cd ${OP} && find . -type f ! -name PACKAGE_MANIFEST.sha256 -not -path '*/node_modules/*' -printf '%P\\n' | LC_ALL=C sort | xargs -d '\\n' sha256sum > PACKAGE_MANIFEST.sha256`);
  beforeAll(() => {
    mkdirSync(join(OP, "infra/aws/node_modules/.bin"), { recursive: true }); writeFileSync(join(OP, "infra/aws/node_modules/.bin/cdk"), fakeCdk); chmodSync(join(OP, "infra/aws/node_modules/.bin/cdk"), 0o755);
    writeFileSync(join(OP, "BUILD_INFO.json"), JSON.stringify({ code_commit: CODE })); writeFileSync(join(OP, "README"), "x"); rehash();
  });
  it("synthesizes in deploy mode with the approval reference, proves the assembly equals the release (templates, assets, approval tag) and writes the guard's environment file", async () => {
    const r = await run("d2-assemble-prd.sh", [], env()); expect(r.code, r.out).toBe(0);
    for (const t of ["PASS Ogevia-prd-ServiceVerificationApi equals the release template", "every ogevia:deployment-status tag", "carries approved-" + REF, "ASSEMBLY OK", "ASSEMBLY READY"]) expect(r.out, t).toContain(t);
    expect(readFileSync(join(work, "cdk.log"), "utf8")).toContain("synth --quiet --no-notices -c env=prd -c mode=deploy -o " + ASM); expect(readFileSync(join(work, "cdk.log"), "utf8")).toContain("approval=" + REF);
    const e = readFileSync(join(OUT, "assembly.env"), "utf8"); expect(e).toContain(`export OGEVIA_DEPLOY_APPROVAL=${REF}`); expect(e).toContain(`export OGEVIA_PRD_ASSEMBLY=${ASM}`); expect(e).toContain(`export OGEVIA_CDK_BIN=${OP}/infra/aws/node_modules/.bin/cdk`);
    const g = sh(`source ${OUT}/assembly.env && OGEVIA_PRD_BEFORE=${OUT} MOCK_DIR=${MOCK} HOME=${work} PATH=${BIN}:$PATH bash ${ROOT}/scripts/deploy-guard-prd.sh check ${API}`); expect(g.status, g.stdout + g.stderr).toBe(0); expect(g.stdout).toContain("CHECK PASSED");
  });
  it("refuses a missing, malformed or placeholder approval reference, a wrong code commit, a damaged operator package, a missing or wrong-version CDK, and an assembly directory inside the package", async () => {
    for (const [e, text] of [[{ OGEVIA_DEPLOY_APPROVAL: "" }, "approval reference"], [{ OGEVIA_DEPLOY_APPROVAL: "short" }, "approval reference"], [{ OGEVIA_DEPLOY_APPROVAL: "APPROVAL-REF-PENDING-OWNER" }, "placeholder"], [{ OGEVIA_OPERATOR_PKG: "" }, "OGEVIA_OPERATOR_PKG"], [{ FAKE_CDK_VERSION: "2.1000.0" }, "not version 2.1143.0"], [{ OGEVIA_PRD_ASSEMBLY_DIR: join(OP, "asm") }, "outside the operator package"], [{ OGEVIA_PRD_ASSEMBLY_DIR: "/etc/asm" }, "under /tmp or your home"]] as [Record<string, string>, string][]) {
      const r = await run("d2-assemble-prd.sh", [], env(e)); expect(r.code, `${text}: ${r.out}`).toBe(1); expect(r.out).toContain(text);
    }
    writeFileSync(join(OP, "BUILD_INFO.json"), JSON.stringify({ code_commit: "f".repeat(40) })); rehash(); const c = await run("d2-assemble-prd.sh", [], env()); expect(c.code).toBe(1); expect(c.out).toContain("not built from the approved code commit");
    writeFileSync(join(OP, "BUILD_INFO.json"), JSON.stringify({ code_commit: CODE })); rehash();
    writeFileSync(join(OP, "README"), "tampered"); const m = await run("d2-assemble-prd.sh", [], env()); expect(m.code).toBe(1); expect(m.out).toContain("PACKAGE_MANIFEST"); writeFileSync(join(OP, "README"), "x"); rehash();
    rmSync(join(OP, "infra/aws/node_modules/.bin/cdk")); const n = await run("d2-assemble-prd.sh", [], env()); expect(n.code).toBe(1); expect(n.out).toContain("dependencies are not installed");
    writeFileSync(join(OP, "infra/aws/node_modules/.bin/cdk"), fakeCdk); chmodSync(join(OP, "infra/aws/node_modules/.bin/cdk"), 0o755); rehash();
  });
  it("rejects an assembly that is not the release: another approval value in the tags, an extra stack, a different template", async () => {
    const t = await run("d2-assemble-prd.sh", [], env({ FAKE_TAG: "someone-elses-ref" })); expect(t.code).toBe(1); expect(t.out).toContain("the deploy-mode tag for approval reference");
    const x = await run("d2-assemble-prd.sh", [], env({ FAKE_EXTRA: "1" })); expect(x.code).toBe(1); expect(x.out).toContain("the assembly holds");
    const good = await run("d2-assemble-prd.sh", [], env()); expect(good.code, good.out).toBe(0);
    const f = join(ASM, `${API}.template.json`); const j = JSON.parse(readFileSync(f, "utf8")); j.Resources.ExtraBucket = { Type: "AWS::S3::Bucket", Properties: {} }; writeFileSync(f, JSON.stringify(j));
    const chk = spawnSync("python3", ["-I", "-B", join(ROOT, "scripts/prd_assembly_check.py"), "--assembly", ASM, "--release-templates", join(ROOT, "release-templates"), "--approval", REF], { encoding: "utf8" }); expect(chk.status).toBe(1); expect(chk.stdout).toContain("differs from the approved release template");
  });
});

describe("D3 production web guard", () => {
  const OP = join(work, "wpkg"), WEBOUT = join(work, "web-out");
  const fakeVite = `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do [[ "$1" == --outDir ]] && OUTD="$2"; shift; done
mkdir -p "$OUTD/assets"; { echo -n 'const e={'; env | grep '^VITE_' | LC_ALL=C sort | sed -E 's/^([^=]*)=(.*)$/\\1:"\\2"/' | paste -sd, ; echo -n "\${FAKE_VITE_EXTRA:-}"; echo '};'; } > "$OUTD/assets/index-NEW222.js"
echo '<!doctype html><script type="module" src="/assets/index-NEW222.js"></script>' > "$OUTD/index.html"; echo 'body{}' > "$OUTD/assets/style-NEW.css"; [[ -n "\${FAKE_VITE_CONFIG:-}" ]] && echo '{}' > "$OUTD/config.json"; exit 0
`;
  const env = (extra: Record<string, string> = {}) => ({ OGEVIA_OPERATOR_PKG: OP, OGEVIA_EXPECT_COMMIT: CODE, OGEVIA_PRD_WEB_OUT: WEBOUT, OGEVIA_DEPLOY_APPROVAL: REF, ...extra });
  const rehash = () => sh(`cd ${OP} && find . -type f ! -name PACKAGE_MANIFEST.sha256 -not -path '*/node_modules/*' -printf '%P\\n' | LC_ALL=C sort | xargs -d '\\n' sha256sum > PACKAGE_MANIFEST.sha256`);
  const liveJs = () => readFileSync(join(MOCK, "web/assets/index-OLD111.js"), "utf8");
  beforeAll(async () => {
    mkdirSync(join(OP, "apps/web/node_modules/.bin"), { recursive: true }); writeFileSync(join(OP, "apps/web/node_modules/.bin/vite"), fakeVite); chmodSync(join(OP, "apps/web/node_modules/.bin/vite"), 0o755);
    writeFileSync(join(OP, "BUILD_INFO.json"), JSON.stringify({ code_commit: CODE })); rehash();
    setLiveWeb(); setLive(); rmSync(join(OUT, "web-before"), { recursive: true, force: true }); const p0 = await run("p0-baseline-capture.sh"); expect(p0.code, p0.out).toBe(0); setProductionState();
  });
  it("build reuses production's embedded values, adds VITE_APP_VERSION = the code commit, and accepts only that difference", async () => {
    const r = await run("d3-web-prd.sh", ["build"], env()); expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("exactly the production values plus"); expect(r.out).toContain("WEB BUILD READY");
    const js = readFileSync(join(WEBOUT, "assets/index-NEW222.js"), "utf8"); expect(js).toContain(`VITE_APP_VERSION:"${CODE}"`); expect(js).toContain('VITE_APP_ENV:"production"'); expect(js).toContain(`${PRD_API}.execute-api`); expect(js).toContain('VITE_COGNITO_CLIENT_ID:"4abcdefghijk"');
    expect(existsSync(join(OUT, "web-build.sha256"))).toBe(true); expect(readFileSync(join(OUT, "web-build.commit"), "utf8").trim()).toBe(CODE);
    expect(writes()).not.toContain("s3 sync"); // build changes nothing in AWS
  });
  it("build refuses a wrong commit, a damaged package, an unexpected embedded value, a config.json in the output, and a non-production or version-carrying live bundle", async () => {
    for (const [e, text] of [[{ OGEVIA_EXPECT_COMMIT: "0".repeat(40) }, "approved code commit"], [{ FAKE_VITE_EXTRA: ',VITE_SURPRISE:"1"' }, "differ from production's plus the version"], [{ FAKE_VITE_CONFIG: "1" }, "config.json"]] as [Record<string, string>, string][]) { const r = await run("d3-web-prd.sh", ["build"], env(e)); expect(r.code, `${text}: ${r.out}`).toBe(1); expect(r.out).toContain(text); }
    writeFileSync(join(OP, "x"), "1"); const m = await run("d3-web-prd.sh", ["build"], env()); expect(m.code).toBe(1); expect(m.out).toContain("not in its manifest"); rmSync(join(OP, "x"));
    const keep = readFileSync(join(OUT, "served-main.js"), "utf8");
    writeFileSync(join(OUT, "served-main.js"), keep.replace('VITE_APP_ENV:"production"', 'VITE_APP_ENV:"test"')); const t = await run("d3-web-prd.sh", ["build"], env()); expect(t.code).toBe(1); expect(t.out).toContain("not marked");
    writeFileSync(join(OUT, "served-main.js"), keep.replace("};", ',VITE_APP_VERSION:"abc"};')); const v = await run("d3-web-prd.sh", ["build"], env()); expect(v.code).toBe(1); expect(v.out).toContain("already carries a version");
    writeFileSync(join(OUT, "served-main.js"), keep.replace(PRD_API, "s0epy5rgzb")); const a = await run("d3-web-prd.sh", ["build"], env()); expect(a.code).toBe(1); expect(a.out).toContain("not the production API");
    writeFileSync(join(OUT, "served-main.js"), keep); const ok = await run("d3-web-prd.sh", ["build"], env()); expect(ok.code, ok.out).toBe(0);
  });
  it("publish refuses without each prerequisite: the migration marker, the API post-check marker, the approval, an intact recovery capture, a matching build manifest; and on a wrong phrase changes nothing", async () => {
    clearLogs(); const before = sh(`cd ${MOCK}/web && find . -type f | sort | xargs sha256sum`).stdout;
    writeFileSync(join(OUT, "db-at-0085.ok"), "85|0085\n"); rmSync(join(OUT, "api-at-release.ok"), { force: true });
    const a = await run("d3-web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(a.code).toBe(1); expect(a.out).toContain("api-at-release.ok");
    writeFileSync(join(OUT, "api-at-release.ok"), "newsha\n");
    writeFileSync(join(OUT, "db-at-0085.ok"), "46|0046\n"); const d = await run("d3-web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(d.code).toBe(1); expect(d.out).toContain("database is not migrated"); writeFileSync(join(OUT, "db-at-0085.ok"), "85|0085\n");
    const n = await run("d3-web-prd.sh", ["publish"], env({ OGEVIA_DEPLOY_APPROVAL: "x" }), "PUBLISH-WEB-Ogevia-prd\n"); expect(n.code).toBe(1); expect(n.out).toContain("approval reference");
    writeFileSync(join(OUT, "web-before/index.html"), "damaged"); const c = await run("d3-web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(c.code).toBe(1); expect(c.out).toContain("recovery capture"); writeFileSync(join(OUT, "web-before/index.html"), readFileSync(join(MOCK, "web/index.html")));
    writeFileSync(join(WEBOUT, "assets/style-NEW.css"), "tampered"); const t = await run("d3-web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(t.code).toBe(1); expect(t.out).toContain("does not match its manifest"); writeFileSync(join(WEBOUT, "assets/style-NEW.css"), "body{}\n");
    const w = await run("d3-web-prd.sh", ["publish"], env(), "publish\n"); expect(w.code).toBe(0); expect(w.out).toContain("Declined");
    writeFileSync(join(MOCK, "web/index.html"), readFileSync(join(MOCK, "web/index.html"), "utf8") + "<!-- someone published -->"); const ch = await run("d3-web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(ch.code).toBe(1); expect(ch.out).toContain("changed since the capture"); writeFileSync(join(MOCK, "web/index.html"), readFileSync(join(OUT, "web-before/index.html")));
    expect(writes()).toBe(""); expect(sh(`cd ${MOCK}/web && find . -type f | sort | xargs sha256sum`).stdout).toBe(before);
  });
  it("publish uploads (no --delete), invalidates, and verifies the served page: byte-identical index, VITE_APP_VERSION = the commit, production environment, only the production API host", async () => {
    clearLogs();
    const r = await run("d3-web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(r.code, r.out).toBe(0);
    for (const t of ["the served index.html is byte-identical", `the bundle carries VITE_APP_VERSION:"${CODE}"`, 'built for production (VITE_APP_ENV:"production")', "no other API host in the bundle", "PUBLISHED AND VERIFIED"]) expect(r.out, t).toContain(t);
    const w = writes(); expect(w).toContain("s3 sync"); expect(w).toContain("cloudfront create-invalidation --distribution-id EMOCK123"); expect(w).toContain("--cache-control no-cache"); expect(w).not.toContain("--delete");
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
    expect(existsSync(join(MOCK, "web/assets/index-OLD111.js"))).toBe(true); // the previous bundle stays: nothing is deleted
    const v = await run("d3-web-prd.sh", ["verify"], env()); expect(v.code, v.out).toBe(0); expect(v.out).toContain("WEB VERIFIED");
  });
  it("verify FAILS when the served page is not the build, carries the wrong version or environment, or calls another API", async () => {
    const idx = readFileSync(join(MOCK, "web/index.html"), "utf8"); const mainJs = join(MOCK, "web/assets/index-NEW222.js"); const js = readFileSync(mainJs, "utf8");
    writeFileSync(join(MOCK, "web/index.html"), idx + "<!-- other -->"); const a = await run("d3-web-prd.sh", ["verify"], env()); expect(a.code).toBe(1); expect(a.out).toContain("differs from");
    writeFileSync(join(MOCK, "web/index.html"), idx);
    writeFileSync(mainJs, js.replace(CODE, "1".repeat(40))); const b = await run("d3-web-prd.sh", ["verify"], env()); expect(b.code).toBe(1); expect(b.out).toContain("version string is");
    writeFileSync(mainJs, js.replace('VITE_APP_ENV:"production"', 'VITE_APP_ENV:"test"')); const c = await run("d3-web-prd.sh", ["verify"], env()); expect(c.code).toBe(1); expect(c.out).toContain("not production");
    writeFileSync(mainJs, js.replace("};", ',X:"https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com"};')); const d = await run("d3-web-prd.sh", ["verify"], env()); expect(d.code).toBe(1); expect(d.out).toContain("another API host");
    writeFileSync(mainJs, js);
  });
  it("rollback-verify proves the recovery source; rollback restores a damaged/missing captured file and the captured index.html, verified against the capture; nothing is deleted", async () => {
    clearLogs(); const rv = await run("d3-web-prd.sh", ["rollback-verify"], env()); expect(rv.code, rv.out).toBe(0); expect(rv.out).toContain("ROLLBACK SOURCE OK"); expect(rv.out).toContain("every captured file is in the bucket"); expect(writes()).toBe("");
    rmSync(join(MOCK, "web/assets/style-OLD.css")); writeFileSync(join(MOCK, "web/assets/index-OLD111.js"), "damaged");
    const rv2 = await run("d3-web-prd.sh", ["rollback-verify"], env()); expect(rv2.code).toBe(0); expect(rv2.out).toContain("missing from the bucket: assets/style-OLD.css"); expect(rv2.out).toContain("size differs: assets/index-OLD111.js");
    const no = await run("d3-web-prd.sh", ["rollback"], env(), "yes\n"); expect(no.code).toBe(0); expect(no.out).toContain("Declined");
    const r = await run("d3-web-prd.sh", ["rollback"], env(), "RESTORE-WEB-Ogevia-prd\n"); expect(r.code, r.out).toBe(0);
    for (const t of ["restored assets/style-OLD.css", "restored assets/index-OLD111.js", "ROLLED BACK AND VERIFIED", "no version string (as captured before the release)"]) expect(r.out, t).toContain(t);
    expect(readFileSync(join(MOCK, "web/index.html"), "utf8")).toBe(readFileSync(join(OUT, "web-before/index.html"), "utf8")); expect(liveJs()).toBe(readFileSync(join(OUT, "web-before/assets/index-OLD111.js"), "utf8"));
    expect(existsSync(join(MOCK, "web/assets/index-NEW222.js"))).toBe(true); expect(writes()).not.toContain("--delete");
  });
});

describe("E1 deployed record (read-only) and the end-to-end order on mocks", () => {
  const e1env = (extra: Record<string, string> = {}) => ({ OGEVIA_EXPECT_COMMIT: CODE, OGEVIA_TARBALL_SHA256: "a".repeat(64), OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_PRD_WEB_OUT: join(work, "web-out"), ...extra });
  it("records only when every artifact maps to the release; fails on an unchanged Lambda, a wrong asset, an ERROR event, a disabled sweep rule, a missing marker or a web that is not the release", async () => {
    // simulate "API deployed": live templates = release templates, Lambda code changed, marker present
    setLive(); writeFileSync(join(MOCK, "code.zip"), "PK new lambda zip bytes"); writeFileSync(join(OUT, "api-at-release.ok"), "newsha\n"); writeFileSync(join(OUT, "db-at-0085.ok"), "85|0085\n");
    const pub = await run("d3-web-prd.sh", ["publish"], { OGEVIA_OPERATOR_PKG: join(work, "wpkg"), OGEVIA_EXPECT_COMMIT: CODE, OGEVIA_PRD_WEB_OUT: join(work, "web-out"), OGEVIA_DEPLOY_APPROVAL: REF }, "PUBLISH-WEB-Ogevia-prd\n"); expect(pub.code, pub.out).toBe(0);
    clearLogs(); const ok = await run("e1-record-deployed-prd.sh", [], e1env()); expect(ok.code, ok.out).toBe(0);
    for (const t of ["the migration marker says 85|0085", "the DEPLOYED stack's Handler asset is the release's pinned build", "ComplianceSweep rule", "no ERROR event in the last 30 minutes in mock-log-group", "the served web is the release build", "DEPLOYED SHA          : " + CODE, "RECORDED"]) expect(ok.out, t).toContain(t);
    expect(readFileSync(join(OUT, "DEPLOYED_RECORD.txt"), "utf8")).toContain("pre-release snapshot  : " + SNAP);
    const t = async (env: Record<string, string>, text: string) => { const r = await run("e1-record-deployed-prd.sh", [], e1env(env)); expect(r.code, `${text}: ${r.out}`).toBe(1); expect(r.out).toContain(text); };
    await t({ MOCK_LOG_ERRORS: "2" }, "ERROR events in mock-log-group"); await t({ MOCK_RULE_STATE: "DISABLED" }, "no ENABLED ComplianceSweep rule"); await t({ MOCK_LAMBDA_ENV: "test" }, "wrong");
    writeFileSync(join(MOCK, "code.zip"), "PK mock lambda zip bytes"); await t({}, "equals the one before the release"); writeFileSync(join(MOCK, "code.zip"), "PK new lambda zip bytes");
    setProductionState(); await t({}, "the deployed Handler asset is"); setLive();
    rmSync(join(OUT, "db-at-0085.ok")); await t({}, "no 85|0085 marker"); writeFileSync(join(OUT, "db-at-0085.ok"), "85|0085\n");
    const idx = readFileSync(join(MOCK, "web/index.html"), "utf8"); writeFileSync(join(MOCK, "web/index.html"), idx + "x"); await t({}, "web verification failed"); writeFileSync(join(MOCK, "web/index.html"), idx);
    const u = await run("e1-record-deployed-prd.sh", [], { OGEVIA_EXPECT_COMMIT: "bad" }); expect(u.code).toBe(2);
    for (const l of calls().split("\n").filter(Boolean)) expect(l.split(" ").slice(0, 2).join(" "), l).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda get-function-configuration|events describe-rule|logs filter-log-events)$/);
  });
  it("all mocked AWS write verbs across the whole file are exactly: snapshot create, SG authorize/revoke, ssm session, secret read, s3 sync/cp to the production bucket only, one invalidation kind", () => {
    const allowed = /^(rds create-db-snapshot|authorize sg-00530a1f4f7648e65 10\.20\.132\.179\/32|revoke sg-00530a1f4f7648e65 10\.20\.132\.179\/32|ssm start-session|secret read|s3 sync|s3 cp|cloudfront create-invalidation --distribution-id EMOCK123)/;
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
    for (const l of (allWrites + writes()).split("\n").filter(Boolean)) expect(l, l).toMatch(allowed);
    expect(allWrites + writes()).not.toContain("--delete");
  });
});
