// The production CLEANUP wrapper (docs/releases/2026-10-25-prd-cleanup/scripts/f-cleanup-prd.sh) runs against a MOCKED aws CLI (the same mocks as the authentication-separation test) and a REAL local PostgreSQL named ogevia_prd
// (migrated from zero, synthetic rows). It needs the throwaway cluster on 127.0.0.1:5432 with TLS (the rehearsal proxy and the window script require it). Nothing contacts AWS.
// The local cluster must be a throwaway: this test creates and drops a database named ogevia_prd.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
let SCRIPTS = "";   // the copied package (docs/releases/2026-10-25-prd-cleanup/scripts), set in beforeAll
const FIXTURE_BEFORE = join(REPO, "infra/aws/test/fixtures/auth-separation/before");
const FIXTURE_DEPLOYED = join(REPO, "infra/aws/test/fixtures/auth-separation/deployed");   // what is live after the authentication release (candidate 9e8582b)
const MOCK_AWS = fileURLToPath(new URL("./auth-cutover-aws-mock.sh", import.meta.url));
const MOCK_BASE = fileURLToPath(new URL("./prd-release-exec-aws-mock.sh", import.meta.url));
const MOCK_CURL = fileURLToPath(new URL("./auth-cutover-curl-mock.sh", import.meta.url));
const PROXY = readFileSync(new URL("./prd-rehearsal-proxy.cjs", import.meta.url), "utf8");
const work = mkdtempSync(join(tmpdir(), "authcut-"));
const BIN = join(work, "bin"), MOCK = join(work, "mock"), OUT = join(work, "before"), NEWT = join(work, "new-templates"), SITEDIR = join(MOCK, "web");
const S = (p: string) => join(MOCK, "state", p);

const id26 = (p: string) => (p + "0".repeat(26)).slice(0, 26);
const SHARED = "us-west-2_849AYz5J7", NEWPOOL = "us-west-2_PRDMOCK01";
const LEGACY = "1i27abbina08fvg1i9u8vprgo9", PILOT_CLIENT = "7po3lrme6a1clkqvif9b7sr9td", OLD_PRD_CLIENT = "2af4ao08h1pl3u2grhg1cr49ma", NEWCLIENT = id26("prdmockclient");
const PRD_API = "zk527zk4ua", PILOT_API = "s0epy5rgzb", HANDLER_FN = "Ogevia-prd-ServiceVerificationApi-Handler886CB40B-MOCK", ID_FN = "Ogevia-prd-IdentityAdmin";
const SITE = `file://${SITEDIR}`;
const OLD_SUB = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", NEW_SUB = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa", MGR_SUB = "cccccccc-3333-4333-8333-cccccccccccc";
const EMAIL = "admin@example.org", REF = "owner-go-auth-20261021", HOSTIP = "10.20.132.179";
const shared = `https://cognito-idp.us-west-2.amazonaws.com/${SHARED}`, prdIssuer = `https://cognito-idp.us-west-2.amazonaws.com/${NEWPOOL}`;
const DOMAIN_NEW = "https://ogevia-prd-mock.auth.us-west-2.amazoncognito.com", DOMAIN_SHARED = "https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com";
const cspWith = (d: string) => `default-src 'self'; script-src 'self'; connect-src 'self' https://*.execute-api.us-west-2.amazonaws.com ${d}; form-action 'self' ${d}; frame-ancestors 'none'`;
const GOOD_CSP = cspWith(DOMAIN_NEW), OLD_CSP = cspWith(DOMAIN_SHARED);
let counter = 0;

const j = (p: string, v: unknown) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };
const calls = () => (existsSync(join(MOCK, "aws-calls.log")) ? readFileSync(join(MOCK, "aws-calls.log"), "utf8") : "");
const writes = () => (existsSync(join(MOCK, "writes.log")) ? readFileSync(join(MOCK, "writes.log"), "utf8") : "");
const clearLogs = () => { for (const f of ["aws-calls.log", "writes.log", "unexpected.log", "cdk-argv.log", "last-invoke-payload.json"]) rmSync(join(MOCK, f), { force: true }); };
const sgFile = () => JSON.stringify(JSON.parse(readFileSync(join(MOCK, "sg.json"), "utf8")));
const outputs = (o: Record<string, string>) => Object.entries(o).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }));
const stack = (name: string, out: Record<string, string> = {}, o: { status?: string; tp?: boolean } = {}) =>
  j(S(`stacks/${name}.json`), { Stacks: [{ StackName: name, StackStatus: o.status ?? "UPDATE_COMPLETE", EnableTerminationProtection: o.tp ?? true, Outputs: outputs(out) }] });

function setAccount(post: boolean) {
  rmSync(S("stacks"), { recursive: true, force: true });
  for (const n of ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-Observability", "Ogevia-prod-NetworkEgress"]) stack(n);
  stack("Ogevia-prd-WebHosting", { WebOrigin: SITE, SiteBucketName: "ogevia-prd-webhosting-mock", DistributionId: "EMOCK123", TestAppClientId: OLD_PRD_CLIENT });
  stack("Ogevia-prd-ServiceVerificationApi", { ApiUrl: `https://${PRD_API}.execute-api.us-west-2.amazonaws.com` });
  stack("Ogevia-prod-ServiceVerificationApi", { ApiUrl: `https://${PILOT_API}.execute-api.us-west-2.amazonaws.com` });
  if (post) stack("Ogevia-prd-Auth", { UserPoolId: NEWPOOL, AppClientId: NEWCLIENT, ManagedLoginDomain: "https://ogevia-prd-mock.auth.us-west-2.amazoncognito.com", UserPoolArn: `arn:aws:cognito-idp:us-west-2:300094796789:userpool/${NEWPOOL}` });
  j(S("resources/Ogevia-prd-ServiceVerificationApi.json"), { StackResourceSummaries: [{ ResourceType: "AWS::Lambda::Function", LogicalResourceId: "Handler886CB40B", PhysicalResourceId: HANDLER_FN }, { ResourceType: "AWS::Lambda::Function", LogicalResourceId: "IdentityHandler6F0A3417", PhysicalResourceId: ID_FN }] });
  rmSync(join(MOCK, "live"), { recursive: true, force: true }); cpSync(FIXTURE_BEFORE, join(MOCK, "live"), { recursive: true });
  j(S("cognito/" + SHARED + ".json"), {
    pool: { MfaConfiguration: "ON" },
    clients: [{ ClientId: LEGACY, ClientName: "ogevia-web" }, { ClientId: OLD_PRD_CLIENT, ClientName: "ogevia-web-prd" }, { ClientId: PILOT_CLIENT, ClientName: "ogevia-web-prod-test-slice" }],
    users: { [EMAIL]: { sub: OLD_SUB, status: "CONFIRMED", enabled: true }, "mgr@example.org": { sub: MGR_SUB, status: "CONFIRMED", enabled: true } },
  });
  rmSync(S("cognito/" + NEWPOOL + ".json"), { force: true });
  if (post) j(S("cognito/" + NEWPOOL + ".json"), {
    pool: { MfaConfiguration: "ON", DeletionProtection: "ACTIVE", UserPoolTier: "ESSENTIALS", AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } },
    clients: [{ ClientId: NEWCLIENT, ClientName: "ogevia-web-prd", CallbackURLs: [`${SITE}/auth/callback`], LogoutURLs: [`${SITE}/`] }],
    users: { [EMAIL]: { sub: NEW_SUB, status: "FORCE_CHANGE_PASSWORD", enabled: true } },
  });
  j(S(`authorizers/${PILOT_API}.json`), { Items: [{ JwtConfiguration: { Issuer: shared, Audience: [LEGACY, PILOT_CLIENT] } }] });
  j(S(`authorizers/${PRD_API}.json`), { Items: [{ JwtConfiguration: post ? { Issuer: prdIssuer, Audience: [NEWCLIENT] } : { Issuer: shared, Audience: [LEGACY, OLD_PRD_CLIENT] } }] });
  j(S(`lambda/${HANDLER_FN}.json`), { Environment: { Variables: post
    ? { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd", COGNITO_USER_POOL_ID: NEWPOOL, COGNITO_APP_CLIENT_ID: NEWCLIENT, OGEVIA_FORBIDDEN_POOL_IDS: SHARED }
    : { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd", COGNITO_USER_POOL_ID: SHARED, COGNITO_APP_CLIENT_ID: `${LEGACY},${OLD_PRD_CLIENT}` } } });
  j(S(`lambda/${ID_FN}.json`), { Environment: { Variables: { COGNITO_USER_POOL_ID: post ? NEWPOOL : SHARED } } });
  j(S("snapshot.json"), { Status: "available", DBInstanceIdentifier: "ogevia-prod-postgres", SnapshotCreateTime: new Date(Date.now() - 600_000).toISOString().replace(/\.\d+Z$/, "Z") });
  j(S("invoke-response.json"), { ok: true, sub: NEW_SUB, existingAccount: false });
  j(S("api-rules.json"), {});
}
function resetSecurityGroup() {
  writeFileSync(join(MOCK, "sg.json"), JSON.stringify({ SecurityGroups: [{ GroupId: "sg-00530a1f4f7648e65", IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [], Ipv6Ranges: [], PrefixListIds: [], UserIdGroupPairs: [{ GroupId: "sg-064ffce3bcbe8eb3b", UserId: "300094796789" }] }], IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }], Ipv6Ranges: [], PrefixListIds: [], UserIdGroupPairs: [] }] }] }));
}

async function run(script: string, args: string[] = [], env: Record<string, string> = {}, input = ""): Promise<{ code: number | null; out: string }> {
  const port = 21000 + Math.floor(Math.random() * 20000) + (counter++ % 7);
  const e = {
    ...process.env, PATH: `${BIN}:${process.env.PATH}`, MOCK_DIR: MOCK, HOME: work, OGEVIA_PRD_BEFORE: OUT, OGEVIA_MIGRATE_PORT: String(port), OGEVIA_SG_RETRY_SLEEP: "0",
    OGEVIA_TUNNEL_WAIT: "10", OGEVIA_CDN_WAIT: "0", REAL_CURL: spawnSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim(), MOCK_PG_USER: new URL(ADMIN_URL).username || "postgres",
    MOCK_CSP: GOOD_CSP, OGEVIA_CURL: join(BIN, "curl"), OGEVIA_CDK_DIR: work, OGEVIA_CDK_BIN: join(BIN, "cdk"), OGEVIA_VITE_BIN: join(BIN, "vite"), OGEVIA_WEB_SRC: work, ...env,
  };
  return new Promise((resolve) => {
    const p = spawn("bash", [join(SCRIPTS, script), ...args], { env: e, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* group gone */ } resolve({ code: c, out }); });
  });
}
const dbUrl = (name: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; return u.toString(); };
async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> { const c = new pg.Client({ connectionString: dbUrl("ogevia_prd") }); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
const q = <T = any>(sql: string, p: unknown[] = []) => db(async (c) => (await c.query(sql, p)).rows as T[]);

const CLEAN_REL = "docs/releases/2026-10-25-prd-cleanup";
const REL = ["docs/releases/2026-10-19-prd-readiness/release/scripts", "docs/releases/2026-10-21-auth-separation/scripts", CLEAN_REL];
const CLEAN_REF = "owner-go-cleanup-20261025";
const EXP = { OGEVIA_CLEANUP_EXPECT_CLIENTS: "2", OGEVIA_CLEANUP_EXPECT_AUTHS: "2", OGEVIA_CLEANUP_EXPECT_SHIFTS: "1" };
const PH = { counts: "OPEN-5432-WINDOW-CLEANUP-COUNTS\n", dryrun: "OPEN-5432-WINDOW-CLEANUP-DRYRUN\n", commit: "OPEN-5432-WINDOW-CLEANUP-COMMIT\nDELETE-PRD-SYNTHETIC-DATA\n" };
const SEED = join(REPO, "infra/aws/db/deploy");
const ORG = "7e570000-0000-4000-8000-000000000001", CLIENT = "7e570000-0000-4000-8000-0000000000c1", AUTHZ = "7e570000-0000-4000-8000-0000000000a1", SERVICE = "7e570000-0000-4000-8000-0000000000e1";
const env = (extra: Record<string, string> = {}) => ({ OGEVIA_DEPLOY_APPROVAL: CLEAN_REF, OGEVIA_EXPECT_HOST_IP: HOSTIP, ...extra });
const fingerprint = async () => JSON.stringify(await q(`select c.relname t, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from ogevia.%I', c.relname), false, true, '')))[1]::text n
  from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'ogevia' and c.relkind = 'r' order by 1`));
const guardsNotEnabled = async () => Number((await q(`select count(*)::int n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ogevia' and not t.tgisinternal and t.tgenabled <> 'O'`))[0].n);
const n = async (sql: string) => Number((await q(sql))[0].n);
const snapshot = (o: Record<string, unknown> = {}) => j(S("snapshot.json"), { Status: "available", SnapshotType: "manual", Encrypted: true, DBInstanceIdentifier: "ogevia-prod-postgres", SnapshotCreateTime: new Date(Date.now() - 600_000).toISOString().replace(/\.\d+Z$/, "Z"), ...o });
const opened = () => /^authorize /m.test(writes());
const SNAPID = "ogevia-prod-postgres-pre-cleanup-202610251200";
const countsSql = () => join(work, "pkg", CLEAN_REL, "sql/prd-cleanup-readonly-counts.sql");
let countsSqlOriginal = "";

function psqlSeed(file: string, vars: Record<string, string>) {
  const args = [dbUrl("ogevia_prd"), "-q", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`]), "-f", "-"];
  const r = spawnSync("psql", args, { input: "set role ogevia_owner;\n" + readFileSync(join(SEED, file), "utf8"), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`seed ${file} failed: ${r.stderr}`);
}

beforeAll(async () => {
  expect(ADMIN_URL, "OGEVIA_TEST_DATABASE_URL must point at a throwaway local cluster on 127.0.0.1:5432").toMatch(/127\.0\.0\.1|localhost/);
  for (const d of [BIN, join(MOCK, "state"), OUT]) mkdirSync(d, { recursive: true });
  copyFileSync(MOCK_AWS, join(BIN, "aws")); copyFileSync(MOCK_BASE, join(MOCK, "..", "prd-release-exec-aws-mock.sh"));
  copyFileSync(MOCK_BASE, join(BIN, "prd-release-exec-aws-mock.sh")); copyFileSync(MOCK_CURL, join(BIN, "curl"));
  for (const f of ["aws", "curl", "prd-release-exec-aws-mock.sh"]) chmodSync(join(BIN, f), 0o755);
  writeFileSync(join(MOCK, "proxy.js"), PROXY);
  writeFileSync(join(MOCK, "admin.json"), JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-0ce8db2d7e5839dd5", PrivateIpAddress: HOSTIP, VpcId: "vpc-0ee9df0c38297cbc1", State: { Name: "running" }, SecurityGroups: [{ GroupId: "sg-00e01e2ca80442c1f" }], NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", PrivateIpAddresses: [{ PrivateIpAddress: HOSTIP }] }] }] }] }));
  writeFileSync(join(MOCK, "nic-by-group.json"), JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", Attachment: { InstanceId: "i-0ce8db2d7e5839dd5" } }, { NetworkInterfaceId: "eni-0bbb", Attachment: { InstanceId: "i-other" } }] }));
  writeFileSync(join(MOCK, "nic-by-ip.json"), JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", Attachment: { InstanceId: "i-0ce8db2d7e5839dd5" } }] }));
  writeFileSync(join(MOCK, "snaps.txt"), "");
  // the package under test, copied with its relative layout (common.sh finds window.sh/lib.sh relative to itself)
  for (const rel of REL) cpSync(join(REPO, rel), join(work, "pkg", rel), { recursive: true });
  SCRIPTS = join(work, "pkg", CLEAN_REL, "scripts"); countsSqlOriginal = readFileSync(countsSql(), "utf8");
  const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect();
  await root.query("drop database if exists ogevia_prd with (force)"); await root.query("create database ogevia_prd"); await root.end();
  const c = new pg.Client({ connectionString: dbUrl("ogevia_prd") }); await c.connect();
  try { await migrate(c as never); } finally { await c.end(); }
  // synthetic rows: the repo's own synthetic seeds (an organization, 2 clients, 2 authorizations, 2 caregivers, a caregiver and a manager membership), plus a shift, a visit (guarded table) and an audit event
  psqlSeed("02_seed_synthetic_test_slice.sql", { caregiver_sub: OLD_SUB, manager_sub: MGR_SUB });
  psqlSeed("03_seed_care_acceptance.sql", { caregiver_a_sub: NEW_SUB, caregiver_b_sub: "dddddddd-4444-4444-8444-dddddddddddd", caregiver_a_code: "CGA1", caregiver_b_code: "CGB1", caregiver_a_first: "A", caregiver_a_last: "S", caregiver_b_first: "B", caregiver_b_last: "S" });
  const d = new pg.Client({ connectionString: dbUrl("ogevia_prd") }); await d.connect();
  try {
    await d.query("set role ogevia_owner");
    const uid = (await d.query("select id from ogevia.app_users order by created_at limit 1")).rows[0].id;
    const cg = (await d.query("select id from ogevia.caregiver_records limit 1")).rows[0].id;
    await d.query("insert into ogevia.shifts(organization_id, client_id, starts_at, ends_at) values ($1, $2, now() + interval '1 day', now() + interval '1 day 2 hours')", [ORG, CLIENT]);
    await d.query(`insert into ogevia.service_visits(organization_id, client_id, client_code_snapshot, caregiver_name_snapshot, caregiver_record_id, service_authorization_id, service_id, service_date, time_in, visit_number_snapshot, created_by)
      values ($1, $2, 'C-TEST', 'Synthetic CG', $3, $4, $5, current_date, now(), 'V-1', $6)`, [ORG, CLIENT, cg, AUTHZ, SERVICE, uid]);
    await d.query("insert into ogevia.audit_events(organization_id, actor_user_id, action, entity_type, occurred_at) values ($1, $2, 'test.event', 'organization', now())", [ORG, uid]);
  } finally { await d.end(); }
});
afterAll(async () => {
  const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect(); await root.query("drop database if exists ogevia_prd with (force)"); await root.end();
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => { setAccount(true); snapshot(); resetSecurityGroup(); clearLogs(); rmSync(join(OUT, "window"), { recursive: true, force: true }); writeFileSync(countsSql(), countsSqlOriginal); });

describe("F cleanup wrapper (mocked AWS, real local ogevia_prd): counts", () => {
  it("counts: read-only. Opens and closes the window, restores the security group, changes no row, and never names ogevia_sv_test", async () => {
    const before = await fingerprint(), sg0 = sgFile();
    const r = await run("f-cleanup-prd.sh", ["counts"], env(), PH.counts);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("read-only counts completed"); expect(r.out).toContain("RESTORED (verified)"); expect(r.out).toContain("restored and verified identical to the original");
    expect(sgFile()).toBe(sg0); expect(existsSync(join(OUT, "window/OPEN"))).toBe(false);
    expect(opened()).toBe(true); expect(writes()).toMatch(/^revoke /m);
    expect(await fingerprint()).toBe(before); expect(await guardsNotEnabled()).toBe(0);
    for (const line of r.out.split("\n").filter((l) => l.includes("ogevia_sv_test"))) expect(line, "only the window script's own disclaimer may mention the TEST database").toContain("never names, connects to or queries it");
    expect(calls()).not.toContain("ogevia_sv_test"); expect(writes()).not.toMatch(/snapshot/);
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
  });
  it("counts: the counts case in the script never calls the read-write helper or the cleanup SQL (static)", () => {
    const text = readFileSync(join(SCRIPTS, "f-cleanup-prd.sh"), "utf8");
    const block = text.slice(text.indexOf("  counts)\n    RO "), text.indexOf("  dryrun|commit)"));
    expect(block.length).toBeGreaterThan(50); expect(block).toContain("RO -d"); expect(block).not.toMatch(/\bRW\b|prd-synthetic-cleanup|do_commit/);
  });
  it("counts: a deletion injected into the counts SQL (even with its own read-only declaration removed) is REFUSED by the wrapper's read-only session; nothing changes; the window is still closed and verified", async () => {
    const before = await fingerprint(), sg0 = sgFile();
    writeFileSync(countsSql(), countsSqlOriginal.replace("begin read only;", "begin;").replace("rollback;", "delete from ogevia.organization_memberships;\nrollback;"));
    expect(readFileSync(countsSql(), "utf8")).toContain("delete from ogevia.organization_memberships");   // nothing references memberships and no guard blocks it: only the read-only session stops it
    const r = await run("f-cleanup-prd.sh", ["counts"], env(), PH.counts);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/read-only transaction/); expect(r.out).toContain("the read-only counts failed");
    expect(await fingerprint()).toBe(before); expect(await n("select count(*)::int n from ogevia.organization_memberships")).toBeGreaterThan(0);
    expect(sgFile()).toBe(sg0); expect(existsSync(join(OUT, "window/OPEN"))).toBe(false); expect(r.out).toContain("restored and verified identical to the original");
  });
  it("a wrong window phrase declines before anything is changed", async () => {
    const sg0 = sgFile();
    const r = await run("f-cleanup-prd.sh", ["counts"], env(), "yes\n");
    expect(r.out).toContain("Declined. Nothing was changed."); expect(opened()).toBe(false); expect(sgFile()).toBe(sg0);
  });
  it("refuses without the approval reference, with a bad mode, and when an earlier window is still marked OPEN", async () => {
    let r = await run("f-cleanup-prd.sh", ["counts"], { OGEVIA_DEPLOY_APPROVAL: "" }, PH.counts); expect(r.code).toBe(1); expect(r.out).toContain("OGEVIA_DEPLOY_APPROVAL"); expect(opened()).toBe(false);
    r = await run("f-cleanup-prd.sh", ["delete"], env()); expect(r.code).toBe(2);
    mkdirSync(join(OUT, "window"), { recursive: true }); writeFileSync(join(OUT, "window/OPEN"), "{}");
    r = await run("f-cleanup-prd.sh", ["counts"], env(), PH.counts); expect(r.code).toBe(1); expect(r.out).toContain("--restore-only"); expect(opened()).toBe(false);
  });
  it("if the rule cannot be removed: exit 3, NOT RESTORED is stated, the marker stays, and --restore-only then removes it and verifies", async () => {
    const sg0 = sgFile();
    const r = await run("f-cleanup-prd.sh", ["counts"], env({ MOCK_REVOKE_FAIL: "1" }), PH.counts);
    expect(r.code, r.out).toBe(3); expect(r.out).toMatch(/NOT RESTORED|could NOT/i); expect(existsSync(join(OUT, "window/OPEN"))).toBe(true);
    const fix = await run("f-cleanup-prd.sh", ["--restore-only"], env());
    expect(fix.code, fix.out).toBe(0); expect(existsSync(join(OUT, "window/OPEN"))).toBe(false); expect(sgFile()).toBe(sg0);
  });
});

describe("F cleanup wrapper: dryrun and commit guards", () => {
  it("dryrun: runs the real cleanup SQL, keeps NOTHING, leaves every guard enabled, restores the security group", async () => {
    const before = await fingerprint(), sg0 = sgFile();
    const r = await run("f-cleanup-prd.sh", ["dryrun"], env(EXP), PH.dryrun);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("DRY RUN: this transaction will be rolled back"); expect(r.out).toContain("dryrun completed"); expect(r.out).toContain("0 guards not enabled");
    expect(await fingerprint()).toBe(before); expect(await guardsNotEnabled()).toBe(0); expect(sgFile()).toBe(sg0); expect(existsSync(join(OUT, "window/OPEN"))).toBe(false);
  });
  it("dryrun: counts that differ from the owner's numbers abort inside the database; nothing changes; the window is closed", async () => {
    const before = await fingerprint(), sg0 = sgFile();
    const r = await run("f-cleanup-prd.sh", ["dryrun"], env({ ...EXP, OGEVIA_CLEANUP_EXPECT_CLIENTS: "4" }), PH.dryrun);
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("ABORT: found clients=2");
    expect(await fingerprint()).toBe(before); expect(await guardsNotEnabled()).toBe(0); expect(sgFile()).toBe(sg0); expect(existsSync(join(OUT, "window/OPEN"))).toBe(false);
  });
  it("dryrun and commit refuse non-numeric or missing expected counts before opening anything", async () => {
    let r = await run("f-cleanup-prd.sh", ["dryrun"], env({ ...EXP, OGEVIA_CLEANUP_EXPECT_SHIFTS: "x; drop table" }), PH.dryrun); expect(r.code).toBe(1); expect(opened()).toBe(false);
    r = await run("f-cleanup-prd.sh", ["commit"], env({ OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }), PH.commit); expect(r.code).toBe(1); expect(opened()).toBe(false);
  });
  it("commit is refused BEFORE the window opens without a fresh, manual, encrypted snapshot of ogevia-prod-postgres", async () => {
    const before = await fingerprint();
    const cases: [string, Record<string, string>, Record<string, unknown>][] = [
      ["no snapshot id", {}, {}],
      ["wrong name pattern", { OGEVIA_CLEANUP_SNAPSHOT_ID: "ogevia-prod-postgres-pre-testdata-202610231702" }, {}],
      ["3 hours old", { OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }, { SnapshotCreateTime: new Date(Date.now() - 3 * 3600_000).toISOString().replace(/\.\d+Z$/, "Z") }],
      ["not encrypted", { OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }, { Encrypted: false }],
      ["automated, not manual", { OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }, { SnapshotType: "automated" }],
      ["another instance", { OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }, { DBInstanceIdentifier: "other" }],
      ["still creating", { OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }, { Status: "creating" }],
    ];
    for (const [label, e, snap] of cases) {
      snapshot(snap); clearLogs();
      const r = await run("f-cleanup-prd.sh", ["commit"], env({ ...EXP, ...e }), PH.commit);
      expect(r.code, `${label}: ${r.out}`).toBe(1); expect(opened(), label).toBe(false);
    }
    expect(await fingerprint()).toBe(before);
  });
  it("commit: a wrong second phrase declines; nothing is opened or deleted", async () => {
    const before = await fingerprint();
    const r = await run("f-cleanup-prd.sh", ["commit"], env({ ...EXP, OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }), "OPEN-5432-WINDOW-CLEANUP-COMMIT\nno\n");
    expect(r.out).toContain("Declined. Nothing was changed."); expect(opened()).toBe(false); expect(await fingerprint()).toBe(before);
  });
});

describe("F cleanup wrapper: commit (LAST: it deletes the synthetic rows in the local ogevia_prd)", () => {
  it("commit: deletes everything in scope, keeps configuration and audit, restores the guards and the security group", async () => {
    const sg0 = sgFile();
    const audit0 = await n("select count(*)::int n from ogevia.audit_events"), mgr0 = await n("select count(*)::int n from ogevia.organization_memberships where role <> 'caregiver'");
    const r = await run("f-cleanup-prd.sh", ["commit"], env({ ...EXP, OGEVIA_CLEANUP_SNAPSHOT_ID: SNAPID }), PH.commit);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("COMMIT requested"); expect(r.out).toContain("commit completed"); expect(r.out).toContain("0 guards not enabled");
    for (const t of ["clients", "client_authorizations", "shifts", "service_visits", "caregiver_records"]) expect(await n(`select count(*)::int n from ogevia.${t}`), t).toBe(0);
    expect(await n("select count(*)::int n from ogevia.organization_memberships where role = 'caregiver'")).toBe(0);
    expect(await n("select count(*)::int n from ogevia.organization_memberships where role <> 'caregiver'")).toBe(mgr0);
    expect(await n("select count(*)::int n from ogevia.organizations")).toBe(1);
    expect(await n("select count(*)::int n from ogevia.audit_events")).toBe(audit0 + 1);
    expect(await n("select count(*)::int n from ogevia.audit_events where action = 'platform.synthetic_data_cleanup'")).toBe(1);
    expect(await guardsNotEnabled()).toBe(0); expect(sgFile()).toBe(sg0); expect(existsSync(join(OUT, "window/OPEN"))).toBe(false);
    await expect(q("set role ogevia_owner; delete from ogevia.audit_events")).rejects.toThrow();   // the audit guard still bites after the cleanup
  });
});
