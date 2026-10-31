// The production authentication-separation OPERATOR scripts (docs/releases/2026-10-21-auth-separation/scripts) run against a MOCKED aws CLI, fake curl/cdk/vite, the REAL
// gate with REAL synthesized templates, and a REAL local PostgreSQL named ogevia_prd (migrated from zero, synthetic rows). Nothing contacts AWS.
// The local cluster must be a throwaway: this test creates and drops a database named ogevia_prd.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOgeviaApp } from "../../lib/app.js";
import { ENVIRONMENTS } from "../../lib/config.js";
import { newApp } from "../../test/helpers.js";
import { migrate } from "../scripts/migrations.js";
import { ADMIN_URL } from "./harness.js";

// This file tests the authentication-separation scripts against snapshots taken before the staff routes existed. The staff-routes switch is held OFF for production here so
// the tests keep proving what they were written to prove; the staff routes are covered by staff-routes-switch.test.ts and the production gate for the staff-management release.
const withoutStaffRoutes = (env: "prod" | "prd") => (env === "prd" ? { ...ENVIRONMENTS.prd, features: { staffManagement: false } } : ENVIRONMENTS[env]);

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPTS = join(REPO, "docs/releases/2026-10-21-auth-separation/scripts");
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
function setSite(js: string) {
  rmSync(SITEDIR, { recursive: true, force: true }); mkdirSync(join(SITEDIR, "assets"), { recursive: true });
  writeFileSync(join(SITEDIR, "index.html"), '<!doctype html><script type="module" src="/assets/index-OLD111.js"></script>\n');
  writeFileSync(join(SITEDIR, "assets/index-OLD111.js"), js);
}
const pairsJs = (p: Record<string, string>) => `const e={${Object.entries(p).map(([k, v]) => `${k}:"${v}"`).join(",")}};`;
const OLD_BUNDLE = pairsJs({
  VITE_APP_ENV: "production", VITE_AUTH_PROVIDER: "cognito", VITE_COGNITO_REGION: "us-west-2", VITE_COGNITO_USER_POOL_ID: SHARED, VITE_COGNITO_CLIENT_ID: OLD_PRD_CLIENT,
  VITE_COGNITO_DOMAIN: "https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com", VITE_COGNITO_REDIRECT_URI: `${SITE}/auth/callback`, VITE_COGNITO_LOGOUT_URI: `${SITE}/`,
  VITE_COGNITO_REFRESH_PERSISTENCE: "session", VITE_SV_API_BASE_URL: `https://${PRD_API}.execute-api.us-west-2.amazonaws.com`, VITE_APP_VERSION: "e80b770",
});

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
const counts = async () => JSON.stringify((await q(`select (select count(*) from ogevia.organizations) o, (select count(*) from ogevia.app_users) u, (select count(*) from ogevia.organization_memberships) m, (select count(*) from ogevia.caregiver_records) c`))[0]);

const stackTemplates = (name: string) => Template.fromStack(buildOgeviaApp(newApp(), withoutStaffRoutes(name === "prod" ? "prod" : "prd"), "plan").find(() => true)!.stack);
void stackTemplates;

beforeAll(async () => {
  expect(ADMIN_URL, "OGEVIA_TEST_DATABASE_URL must point at a throwaway local cluster").toMatch(/127\.0\.0\.1|localhost/);
  for (const d of [BIN, join(MOCK, "state"), OUT, NEWT]) mkdirSync(d, { recursive: true });
  copyFileSync(MOCK_AWS, join(BIN, "aws")); copyFileSync(MOCK_BASE, join(MOCK, "..", "prd-release-exec-aws-mock.sh")); // the mock delegates to it by relative path
  copyFileSync(MOCK_BASE, join(BIN, "prd-release-exec-aws-mock.sh")); copyFileSync(MOCK_CURL, join(BIN, "curl"));
  writeFileSync(join(BIN, "cdk"), '#!/usr/bin/env bash\necho "$*" >> "$MOCK_DIR/cdk-argv.log"; echo "approval=${OGEVIA_DEPLOY_APPROVAL:-}" >> "$MOCK_DIR/cdk-argv.log"; exit ${FAKE_CDK_EXIT:-0}\n');
  writeFileSync(join(BIN, "vite"), `#!/usr/bin/env bash
out=""; while [[ $# -gt 0 ]]; do [[ "$1" == --outDir ]] && out="$2"; shift; done
mkdir -p "$out/assets"; name="index-NEW$RANDOM.js"
{ echo -n "const e={"; for k in $(compgen -e | grep '^VITE_' | sort); do v="\${!k}"; [[ -n "$FAKE_VITE_STALE" ]] && case "$k" in VITE_COGNITO_USER_POOL_ID) v="${SHARED}" ;; VITE_COGNITO_CLIENT_ID) v="${OLD_PRD_CLIENT}" ;; esac; echo -n "$k:\\"$v\\","; done; echo "};"; } > "$out/assets/$name"
echo "<!doctype html><script type=\\"module\\" src=\\"/assets/$name\\"></script>" > "$out/index.html"
`);
  for (const f of ["aws", "curl", "cdk", "vite", "prd-release-exec-aws-mock.sh"]) chmodSync(join(BIN, f), 0o755);
  writeFileSync(join(MOCK, "proxy.js"), PROXY); writeFileSync(join(MOCK, "code.zip"), "PK mock");
  writeFileSync(join(MOCK, "admin.json"), JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-0ce8db2d7e5839dd5", PrivateIpAddress: HOSTIP, VpcId: "vpc-0ee9df0c38297cbc1", State: { Name: "running" }, SecurityGroups: [{ GroupId: "sg-00e01e2ca80442c1f" }], NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", PrivateIpAddresses: [{ PrivateIpAddress: HOSTIP }] }] }] }] }));
  writeFileSync(join(MOCK, "nic-by-group.json"), JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", Attachment: { InstanceId: "i-0ce8db2d7e5839dd5" } }, { NetworkInterfaceId: "eni-0bbb", Attachment: { InstanceId: "i-other" } }] }));
  writeFileSync(join(MOCK, "nic-by-ip.json"), JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: "eni-0aaa", Attachment: { InstanceId: "i-0ce8db2d7e5839dd5" } }] }));
  writeFileSync(join(MOCK, "snaps.txt"), ""); writeFileSync(join(MOCK, "templates-unused"), "");
  // the NEW templates this code synthesizes
  for (const env of ["prd", "prod"] as const) for (const p of buildOgeviaApp(newApp(), withoutStaffRoutes(env), "plan")) {
    if (env === "prod" && p.stack.stackName !== "Ogevia-prod-NetworkEgress") continue;
    const tpl = Template.fromStack(p.stack).toJSON();
    // This release did not change the API's code; the API code has changed since (staff routes), so its Lambda asset references are pinned to the deployed ones.
    if (p.stack.stackName === "Ogevia-prd-ServiceVerificationApi") {
      const live = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/fixtures/auth-separation/deployed/Ogevia-prd-ServiceVerificationApi.json", import.meta.url)), "utf8"));
      for (const [id, r] of Object.entries<any>(tpl.Resources)) if (r.Type === "AWS::Lambda::Function" && live.Resources[id]?.Properties?.Code) r.Properties.Code = live.Resources[id].Properties.Code;
    }
    writeFileSync(join(NEWT, `${p.stack.stackName}.json`), JSON.stringify(tpl));
  }
  // ogevia_prd: all migrations, a synthetic agency, its owner (OLD sign-in), a manager, a caregiver record
  const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect();
  await root.query("drop database if exists ogevia_prd with (force)"); await root.query("create database ogevia_prd"); await root.end();
  const c = new pg.Client({ connectionString: dbUrl("ogevia_prd") }); await c.connect();
  try {
    await migrate(c as never);
    await c.query("insert into ogevia.organizations (slug, display_name, timezone) values ('socal-care-services', 'SoCal Care Services', 'America/Los_Angeles')");
    await c.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Production Admin'), ($2, 'A Manager')", [OLD_SUB, MGR_SUB]);
    await c.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) select o.id, u.id, case when u.cognito_sub = $1 then 'organization_owner'::ogevia.system_role else 'manager'::ogevia.system_role end, 'active' from ogevia.organizations o, ogevia.app_users u where o.slug = 'socal-care-services'", [OLD_SUB]);
    await c.query("insert into ogevia.caregiver_records (organization_id, caregiver_code, first_name, last_name, status) select id, 'CG-0001', 'Synthetic', 'Caregiver', 'active' from ogevia.organizations");
  } finally { await c.end(); }
});
afterAll(async () => {
  const root = new pg.Client({ connectionString: ADMIN_URL }); await root.connect(); await root.query("drop database if exists ogevia_prd with (force)"); await root.end();
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => { setAccount(false); resetSecurityGroup(); clearLogs(); rmSync(join(OUT, "auth"), { recursive: true, force: true }); rmSync(join(OUT, "window"), { recursive: true, force: true }); });

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("A deploy: check (read-only gate)", () => {
  const env = () => ({ OGEVIA_AUTH_NEW_TEMPLATES: NEWT });
  it("passes on the real before/after pair, writes only the marker, and changes nothing in AWS", async () => {
    const r = await run("a-deploy-prd.sh", ["check"], env());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PASS Ogevia-prd-Auth does not exist yet");
    expect(r.out).toContain("PASS: Ogevia-prd-Auth is new");
    expect(r.out).toContain("CHECK PASSED");
    expect(existsSync(join(OUT, "auth/gate.ok"))).toBe(true);
    expect(writes()).toBe("");
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
  });
  it("records the shared pool's clients and the pilot authorizer as they are now (the post-checks compare with them)", async () => {
    await run("a-deploy-prd.sh", ["check"], env());
    expect(JSON.parse(readFileSync(join(OUT, "auth/shared-pool-clients-before.json"), "utf8"))).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(OUT, "auth/pilot-authorizer-before.json"), "utf8"))[0].Audience).toEqual([LEGACY, PILOT_CLIENT].sort());
  });
  it("REFUSES when the Auth stack already exists, when a stack lacks termination protection, or when a stack is mid-update", async () => {
    stack("Ogevia-prd-Auth", {}); let r = await run("a-deploy-prd.sh", ["check"], env()); expect(r.code).toBe(1); expect(r.out).toContain("already exists");
    setAccount(false); stack("Ogevia-prd-Observability", {}, { tp: false }); r = await run("a-deploy-prd.sh", ["check"], env()); expect(r.code).toBe(1); expect(r.out).toContain("NO termination protection");
    setAccount(false); stack("Ogevia-prd-Observability", {}, { status: "UPDATE_IN_PROGRESS" }); r = await run("a-deploy-prd.sh", ["check"], env()); expect(r.code).toBe(1); expect(r.out).toContain("not a settled status");
    expect(existsSync(join(OUT, "auth/gate.ok"))).toBe(false);
  });
  it("REFUSES when production drifted from what the package expects (an unexpected live difference), and writes no marker", async () => {
    const t = JSON.parse(readFileSync(join(MOCK, "live/Ogevia-prd-EvidenceStorage.json"), "utf8")); t.Description = "someone changed this"; writeFileSync(join(MOCK, "live/Ogevia-prd-EvidenceStorage.json"), JSON.stringify(t));
    const r = await run("a-deploy-prd.sh", ["check"], env());
    expect(r.code).toBe(1); expect(r.out).toContain("Ogevia-prd-EvidenceStorage"); expect(existsSync(join(OUT, "auth/gate.ok"))).toBe(false);
  });
  it("REFUSES without the new templates and with a bad usage", async () => {
    expect((await run("a-deploy-prd.sh", ["check"])).code).toBe(1);
    expect((await run("a-deploy-prd.sh", ["everything"])).code).toBe(2);
    expect((await run("a-deploy-prd.sh", [])).code).toBe(2);
  });
});

describe("A deploy: the guarded deployment", () => {
  const base = (extra: Record<string, string> = {}) => ({ OGEVIA_AUTH_NEW_TEMPLATES: NEWT, OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-auth-202610211500", ...extra });
  const PHRASE = "DEPLOY-Ogevia-prd-Auth-and-Api\n";
  const argv = () => (existsSync(join(MOCK, "cdk-argv.log")) ? readFileSync(join(MOCK, "cdk-argv.log"), "utf8") : "");
  it("refuses without the gate marker, the approval reference, or a snapshot id, and runs no cdk", async () => {
    expect((await run("a-deploy-prd.sh", ["deploy"], base(), PHRASE)).out).toContain("run 'bash a-deploy-prd.sh check' first");
    await run("a-deploy-prd.sh", ["check"], base());
    expect((await run("a-deploy-prd.sh", ["deploy"], base({ OGEVIA_DEPLOY_APPROVAL: "x" }), PHRASE)).out).toContain("approval reference");
    expect((await run("a-deploy-prd.sh", ["deploy"], base({ OGEVIA_PREDEPLOY_SNAPSHOT_ID: "" }), PHRASE)).out).toContain("OGEVIA_PREDEPLOY_SNAPSHOT_ID");
    expect(argv()).toBe("");
  });
  it("refuses a stale gate marker, a missing snapshot, and an old snapshot", async () => {
    await run("a-deploy-prd.sh", ["check"], base());
    writeFileSync(join(OUT, "auth/gate.ok"), `x x ${Math.floor(Date.now() / 1000) - 7200}\n`);
    expect((await run("a-deploy-prd.sh", ["deploy"], base(), PHRASE)).out).toContain("old (limit 3600)");
    await run("a-deploy-prd.sh", ["check"], base());
    rmSync(S("snapshot.json")); expect((await run("a-deploy-prd.sh", ["deploy"], base(), PHRASE)).out).toContain("not found");
    setAccount(false); j(S("snapshot.json"), { Status: "available", DBInstanceIdentifier: "ogevia-prod-postgres", SnapshotCreateTime: new Date(Date.now() - 90_000_000).toISOString().replace(/\.\d+Z$/, "Z") });
    await run("a-deploy-prd.sh", ["check"], base()); expect((await run("a-deploy-prd.sh", ["deploy"], base(), PHRASE)).out).toContain("hours old");
    expect(argv()).toBe("");
  });
  it("a wrong phrase stops with nothing changed", async () => {
    await run("a-deploy-prd.sh", ["check"], base());
    const r = await run("a-deploy-prd.sh", ["deploy"], base(), "yes\n");
    expect(r.code).toBe(0); expect(r.out).toContain("Declined"); expect(argv()).toBe("");
  });
  it("with the phrase it runs EXACTLY the two-stack cdk deploy and nothing else", async () => {
    await run("a-deploy-prd.sh", ["check"], base());
    const r = await run("a-deploy-prd.sh", ["deploy"], base(), PHRASE);
    expect(r.code, r.out).toBe(0);
    const [line, approval] = argv().trim().split("\n");
    expect(line).toBe("deploy -c env=prd -c mode=deploy --exclusively Ogevia-prd-Auth Ogevia-prd-ServiceVerificationApi --require-approval broadening --no-notices");
    expect(approval).toBe(`approval=${REF}`);
    for (const forbidden of ["--all", "--force", "--hotswap", "--no-rollback", "Ogevia-prod", "WebHosting", "Observability", "*"]) expect(line).not.toContain(forbidden);
  });
  it("a failed cdk deploy is reported and not treated as success", async () => {
    await run("a-deploy-prd.sh", ["check"], base());
    const r = await run("a-deploy-prd.sh", ["deploy"], base({ FAKE_CDK_EXIT: "1" }), PHRASE);
    expect(r.code).toBe(1); expect(r.out).toContain("cdk deploy failed"); expect(r.out).not.toContain("DEPLOYED. Now run");
  });
  it("the repeated check inside deploy refuses if production drifted after the first check", async () => {
    await run("a-deploy-prd.sh", ["check"], base());
    const t = JSON.parse(readFileSync(join(MOCK, "live/Ogevia-prd-DatabaseSecret.json"), "utf8")); t.Description = "drifted"; writeFileSync(join(MOCK, "live/Ogevia-prd-DatabaseSecret.json"), JSON.stringify(t));
    const r = await run("a-deploy-prd.sh", ["deploy"], base(), PHRASE); expect(r.code).toBe(1); expect(argv()).toBe("");
  });
});

describe("A deploy: post-checks", () => {
  const post = async (extra: Record<string, string> = {}) => run("a-deploy-prd.sh", ["post"], { OGEVIA_AUTH_NEW_TEMPLATES: NEWT, ...extra });
  const before = async () => { await run("a-deploy-prd.sh", ["check"], { OGEVIA_AUTH_NEW_TEMPLATES: NEWT }); };
  beforeEach(async () => { await before(); setAccount(true); j(S("api-rules.json"), {}); });
  it("passes when production trusts exactly its own pool and client, the pilot is unchanged, and anonymous calls get 401", async () => {
    const r = await post(); expect(r.code, r.out).toBe(0);
    for (const s of ["MFA ON", "deletion protection ACTIVE", "self sign-up disabled", "exactly one client", "callback and logout return only to the production site", "issuer = production pool, audience = the one production client",
      "API Lambda: production pool and client, shared pool forbidden", "production invitations: the identity function acts on the production pool only", "the shared pool's clients are unchanged", "the pilot API authorizer is unchanged"]) expect(r.out, s).toContain(s);
    expect(writes()).toBe("");
  });
  it.each([
    ["the audience still includes the legacy client", () => j(S(`authorizers/${PRD_API}.json`), { Items: [{ JwtConfiguration: { Issuer: prdIssuer, Audience: [NEWCLIENT, LEGACY] } }] }), "not exactly the production pool and client"],
    ["the issuer is still the shared pool", () => j(S(`authorizers/${PRD_API}.json`), { Items: [{ JwtConfiguration: { Issuer: shared, Audience: [NEWCLIENT] } }] }), "not exactly the production pool and client"],
    ["the API Lambda does not forbid the shared pool", () => j(S(`lambda/${HANDLER_FN}.json`), { Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd", COGNITO_USER_POOL_ID: NEWPOOL, COGNITO_APP_CLIENT_ID: NEWCLIENT } } }), "API Lambda settings are wrong"],
    ["the API Lambda points at the test database", () => j(S(`lambda/${HANDLER_FN}.json`), { Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_sv_test", COGNITO_USER_POOL_ID: NEWPOOL, COGNITO_APP_CLIENT_ID: NEWCLIENT, OGEVIA_FORBIDDEN_POOL_IDS: SHARED } } }), "database changed"],
    ["the identity function is still on the shared pool", () => j(S(`lambda/${ID_FN}.json`), { Environment: { Variables: { COGNITO_USER_POOL_ID: SHARED } } }), "not on the production pool"],
    ["the identity function has an extra variable", () => j(S(`lambda/${ID_FN}.json`), { Environment: { Variables: { COGNITO_USER_POOL_ID: NEWPOOL, EXTRA: "1" } } }), "not on the production pool"],
    ["MFA is not ON", () => { const p = JSON.parse(readFileSync(S(`cognito/${NEWPOOL}.json`), "utf8")); p.pool.MfaConfiguration = "OPTIONAL"; j(S(`cognito/${NEWPOOL}.json`), p); }, "MFA is not ON"],
    ["deletion protection is off", () => { const p = JSON.parse(readFileSync(S(`cognito/${NEWPOOL}.json`), "utf8")); p.pool.DeletionProtection = "INACTIVE"; j(S(`cognito/${NEWPOOL}.json`), p); }, "deletion protection is not ACTIVE"],
    ["self sign-up is enabled", () => { const p = JSON.parse(readFileSync(S(`cognito/${NEWPOOL}.json`), "utf8")); p.pool.AdminCreateUserConfig.AllowAdminCreateUserOnly = false; j(S(`cognito/${NEWPOOL}.json`), p); }, "self sign-up is NOT disabled"],
    ["the client returns to another origin", () => { const p = JSON.parse(readFileSync(S(`cognito/${NEWPOOL}.json`), "utf8")); p.clients[0].CallbackURLs.push("http://localhost:5173/auth/callback"); j(S(`cognito/${NEWPOOL}.json`), p); }, "callback/logout URLs are not exactly"],
    ["the production pool has a second client", () => { const p = JSON.parse(readFileSync(S(`cognito/${NEWPOOL}.json`), "utf8")); p.clients.push({ ClientId: id26("another"), ClientName: "x" }); j(S(`cognito/${NEWPOOL}.json`), p); }, "does not have exactly one client"],
    ["the shared pool lost a client", () => { const p = JSON.parse(readFileSync(S(`cognito/${SHARED}.json`), "utf8")); p.clients.pop(); j(S(`cognito/${SHARED}.json`), p); }, "shared pool's clients changed"],
    ["the pilot authorizer changed", () => j(S(`authorizers/${PILOT_API}.json`), { Items: [{ JwtConfiguration: { Issuer: prdIssuer, Audience: [NEWCLIENT] } }] }), "pilot API authorizer changed"],
  ])("FAILS when %s", async (_l, mutate, text) => {
    mutate(); const r = await post(); expect(r.code).toBe(1); expect(r.out).toContain(text);
  });
  it("FAILS when an API answers an anonymous call with anything but 401", async () => {
    j(S("api-rules.json"), { [PRD_API]: { "*": 200 } }); const r = await post(); expect(r.code).toBe(1); expect(r.out).toContain("returned 200");
  });
  it("FAILS when the production pool equals the shared pool", async () => {
    stack("Ogevia-prd-Auth", { UserPoolId: SHARED, AppClientId: NEWCLIENT, ManagedLoginDomain: "https://x.auth.us-west-2.amazoncognito.com" }); const r = await post(); expect(r.code).toBe(1); expect(r.out).toContain("equals the shared pool");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("B administrator: invitation uses the production pool", () => {
  const env = (extra: Record<string, string> = {}) => ({ OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_ADMIN_EMAIL: EMAIL, ...extra });
  const PH = "INVITE-PRD-ADMIN\n";
  beforeEach(() => setAccount(true));
  it("invokes ONLY the production identity function, confirms the sign-in exists in the PRODUCTION pool, and prints no email, id or password", async () => {
    const r = await run("b-admin-prd.sh", ["invite"], env(), PH);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("the production identity function acts on the production pool only");
    expect(r.out).toContain("exists in the PRODUCTION pool (status FORCE_CHANGE_PASSWORD)");
    expect(r.out).toContain("INVITED");
    expect(writes()).toBe(`lambda invoke ${ID_FN}\n`);
    expect(JSON.parse(readFileSync(join(MOCK, "last-invoke-payload.json"), "utf8"))).toEqual({ action: "invite", email: EMAIL });
    for (const secret of [NEW_SUB, OLD_SUB, EMAIL, "localtest"]) expect(r.out.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(existsSync(join(OUT, "auth/invite.out"))).toBe(false);                    // the raw response (it holds the sign-in id) is deleted
  });
  it("REFUSES to send anything when the identity function still acts on the shared pool", async () => {
    j(S(`lambda/${ID_FN}.json`), { Environment: { Variables: { COGNITO_USER_POOL_ID: SHARED } } });
    const r = await run("b-admin-prd.sh", ["invite"], env(), PH);
    expect(r.code).toBe(1); expect(r.out).toContain("not the production pool"); expect(writes()).toBe("");
  });
  it("REFUSES before the production pool exists, with a bad email, without approval; a wrong phrase sends nothing", async () => {
    setAccount(false); expect((await run("b-admin-prd.sh", ["invite"], env(), PH)).out).toContain("not deployed");
    setAccount(true);
    expect((await run("b-admin-prd.sh", ["invite"], env({ OGEVIA_ADMIN_EMAIL: "nope" }), PH)).out).toContain("OGEVIA_ADMIN_EMAIL");
    expect((await run("b-admin-prd.sh", ["invite"], env({ OGEVIA_DEPLOY_APPROVAL: "x" }), PH)).out).toContain("approval reference");
    const w = await run("b-admin-prd.sh", ["invite"], env(), "yes\n"); expect(w.code).toBe(0); expect(w.out).toContain("Declined");
    expect(writes()).toBe("");
  });
  it("stops when the function refuses the invitation or the sign-in cannot be read back from the production pool", async () => {
    j(S("invoke-response.json"), { ok: false, error: "rate_limited" });
    let r = await run("b-admin-prd.sh", ["invite"], env(), PH); expect(r.code).toBe(1); expect(r.out).toContain("rate_limited");
    j(S("invoke-response.json"), { ok: true, sub: NEW_SUB, existingAccount: false });
    const p = JSON.parse(readFileSync(S(`cognito/${NEWPOOL}.json`), "utf8")); delete p.users[EMAIL]; j(S(`cognito/${NEWPOOL}.json`), p);
    r = await run("b-admin-prd.sh", ["invite"], env(), PH); expect(r.code).toBe(1); expect(r.out).toContain("cannot be read back");
    p.users[EMAIL] = { sub: NEW_SUB, status: "RESET_REQUIRED", enabled: true }; j(S(`cognito/${NEWPOOL}.json`), p);
    r = await run("b-admin-prd.sh", ["invite"], env(), PH); expect(r.code).toBe(1); expect(r.out).toContain("unexpected state");
  });
});

describe("B administrator: inspect, relink and undo against the real production database (temporary window, mocked AWS)", () => {
  const env = (extra: Record<string, string> = {}) => ({ OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_EXPECT_HOST_IP: HOSTIP, OGEVIA_ADMIN_EMAIL: EMAIL, ...extra });
  const phrase = (m: string) => `OPEN-5432-WINDOW-AUTH-${m}\n`;
  const personSub = async () => (await q("select cognito_sub from ogevia.app_users where display_name = 'Production Admin'"))[0].cognito_sub as string;
  beforeEach(() => { setAccount(true); });
  const noSecrets = (out: string) => { for (const s of [OLD_SUB, NEW_SUB, MGR_SUB, EMAIL, "localtest"]) expect(out, `output must not contain ${s.slice(0, 8)}...`).not.toContain(s); };

  it("inspect: shows every person with their access, no sign-in id or email, changes no record, and restores the security group", async () => {
    const before = await counts(), sg0 = sgFile();
    const r = await run("b-admin-prd.sh", ["inspect"], env(), phrase("INSPECT"));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Production Admin"); expect(r.out).toContain("organization_owner"); expect(r.out).toContain("socal-care-services"); expect(r.out).toContain("INSPECT DONE");
    expect(r.out).toContain("RESTORED (verified)"); expect(sgFile()).toBe(sg0);
    noSecrets(r.out);
    expect(await counts()).toBe(before);
    expect(existsSync(join(OUT, "window/OPEN"))).toBe(false);
  });

  it("inspect works BEFORE the production pool exists (read-only, nothing changed); relink then refuses without the pool", async () => {
    setAccount(false);
    const before = await counts(), sg0 = sgFile();
    const r = await run("b-admin-prd.sh", ["inspect"], env(), phrase("INSPECT"));
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("INSPECT DONE"); expect(r.out).toContain("RESTORED (verified)");
    expect(sgFile()).toBe(sg0); expect(await counts()).toBe(before); noSecrets(r.out);
    const rl = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK"));
    expect(rl.code).not.toBe(0); expect(rl.out).toContain("production pool is not deployed");
    expect(await counts()).toBe(before);
  });

  it("relink: the SAME person record moves to the production sign-in; no person, agency, membership or caregiver record is added or removed; the window is restored", async () => {
    const before = await counts(), sg0 = sgFile();
    const [person] = await q("select id from ogevia.app_users where cognito_sub = $1", [OLD_SUB]);
    const auditBefore = (await q("select count(*)::int n from ogevia.audit_events"))[0].n;
    const r = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK"));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("RELINKED: person record"); expect(r.out).toContain("no person, agency, membership or caregiver record was added or removed");
    expect(r.out).toContain("RESTORED (verified)"); expect(sgFile()).toBe(sg0);
    noSecrets(r.out);
    expect(await counts()).toBe(before);
    expect(await personSub()).toBe(NEW_SUB);
    expect((await q("select id from ogevia.app_users where cognito_sub = $1", [NEW_SUB]))[0].id).toBe(person.id);
    expect((await q("select count(*)::int n from ogevia.audit_events"))[0].n).toBe(auditBefore + 1);
    expect(await q("select role::text, status::text from ogevia.organization_memberships where user_id = $1", [person.id])).toEqual([{ role: "organization_owner", status: "active" }]);
  });

  it("relink is idempotent: running it again changes nothing", async () => {
    const before = await counts();
    const r = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK"));
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("ALREADY RELINKED"); expect(await counts()).toBe(before); expect(await personSub()).toBe(NEW_SUB);
  });

  it("undo: the same person record goes back to the old sign-in (rollback of one person), then relink restores the cutover state", async () => {
    const r = await run("b-admin-prd.sh", ["undo"], env(), phrase("UNDO"));
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("RELINKED: person record"); expect(await personSub()).toBe(OLD_SUB); noSecrets(r.out);
    expect((await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK"))).code).toBe(0);
    expect(await personSub()).toBe(NEW_SUB);
  });

  it("REFUSES to create a duplicate: a person record already holding the production sign-in stops it, nothing changes, the window is restored", async () => {
    await q("update ogevia.app_users set cognito_sub = $1 where display_name = 'Production Admin'", [OLD_SUB]);                   // put the admin back on the old sign-in
    await q("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Duplicate of the admin')", [NEW_SUB]);       // a stray record already holds the new one
    const before = await counts(), sg0 = sgFile();
    const r = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK"));
    expect(r.code).toBe(1); expect(r.out).toContain("REFUSED OR FAILED"); expect(r.out).toContain("ALREADY linked to a different person record");
    expect(r.out).toContain("RESTORED (verified)"); expect(sgFile()).toBe(sg0); noSecrets(r.out);
    expect(await counts()).toBe(before); expect(await personSub()).toBe(OLD_SUB);
    await q("delete from ogevia.app_users where display_name = 'Duplicate of the admin'");
  });

  it("REFUSES before opening any window when the production sign-in is missing, disabled, or the pools give the same id", async () => {
    const p = JSON.parse(readFileSync(S(`cognito/${NEWPOOL}.json`), "utf8"));
    delete p.users[EMAIL]; j(S(`cognito/${NEWPOOL}.json`), p); clearLogs();
    let r = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK")); expect(r.code).toBe(1); expect(r.out).toContain("cannot read the administrator's sign-in in the production pool"); expect(writes()).toBe("");
    p.users[EMAIL] = { sub: NEW_SUB, status: "CONFIRMED", enabled: false }; j(S(`cognito/${NEWPOOL}.json`), p);
    r = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK")); expect(r.code).toBe(1); expect(r.out).toContain("enabled=false");
    p.users[EMAIL] = { sub: OLD_SUB, status: "CONFIRMED", enabled: true }; j(S(`cognito/${NEWPOOL}.json`), p);
    r = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK")); expect(r.code).toBe(1); expect(r.out).toContain("are the same");
    expect(writes()).toBe("");
  });

  it("REFUSES a wrong phrase, a wrong admin host address, a bad email and a missing approval; no rule is added", async () => {
    clearLogs(); const sg0 = sgFile();
    const d = await run("b-admin-prd.sh", ["relink"], env(), "yes\n"); expect(d.code).toBe(0); expect(d.out).toContain("Declined"); expect(sgFile()).toBe(sg0);
    const ip = await run("b-admin-prd.sh", ["relink"], env({ OGEVIA_EXPECT_HOST_IP: "10.20.1.1" }), phrase("RELINK")); expect(ip.code).toBe(1); expect(ip.out).toContain("OGEVIA_EXPECT_HOST_IP");
    expect((await run("b-admin-prd.sh", ["relink"], env({ OGEVIA_ADMIN_EMAIL: "nope" }), phrase("RELINK"))).out).toContain("OGEVIA_ADMIN_EMAIL");
    expect((await run("b-admin-prd.sh", ["relink"], env({ OGEVIA_DEPLOY_APPROVAL: "x" }), phrase("RELINK"))).out).toContain("approval reference");
    expect(writes()).not.toContain("authorize"); expect(sgFile()).toBe(sg0);
  });

  it("REFUSES when the production pool has not been created yet", async () => {
    setAccount(false); const r = await run("b-admin-prd.sh", ["relink"], env(), phrase("RELINK")); expect(r.code).toBe(1); expect(r.out).toContain("not deployed");
  });
});

describe("C web: build, publish, verify and rollback with the production pool", () => {
  const E = (extra: Record<string, string> = {}) => ({ OGEVIA_DEPLOY_APPROVAL: REF, ...extra });
  const served = () => readFileSync(join(SITEDIR, "index.html"), "utf8");
  beforeEach(() => { setAccount(true); setSite(OLD_BUNDLE); rmSync(join(work, "web-out"), { recursive: true, force: true }); });
  const out = (extra: Record<string, string> = {}) => ({ OGEVIA_PRD_WEB_OUT: join(work, "web-out"), ...extra });
  const bundleOf = (dir: string) => { const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(readFileSync(join(dir, "index.html"), "utf8"))![1]!; return readFileSync(join(dir, "assets", m), "utf8"); };

  it("build: replaces ONLY the sign-in values; every other embedded value is reused; no old value remains", async () => {
    const r = await run("c-web-prd.sh", ["build"], out());
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("BUILD OK"); expect(writes()).toBe("");
    const b = bundleOf(join(work, "web-out"));
    for (const keep of ['VITE_APP_VERSION:"e80b770"', 'VITE_APP_ENV:"production"', `VITE_SV_API_BASE_URL:"https://${PRD_API}.execute-api.us-west-2.amazonaws.com"`]) expect(b).toContain(keep);
    for (const mine of [NEWPOOL, NEWCLIENT, "ogevia-prd-mock.auth.us-west-2.amazoncognito.com"]) expect(b).toContain(mine);
    for (const old of [SHARED, LEGACY, OLD_PRD_CLIENT, "us-west-2849ayz5j7"]) expect(b).not.toContain(old);
    expect(r.out).toContain("sign-in values replaced: VITE_COGNITO_USER_POOL_ID VITE_COGNITO_CLIENT_ID VITE_COGNITO_DOMAIN");
  });
  it("build REFUSES a bundle that still carries an old sign-in value, a served bundle for another API or environment, and a missing production pool", async () => {
    let r = await run("c-web-prd.sh", ["build"], out({ FAKE_VITE_STALE: "1" })); expect(r.code).toBe(1); expect(r.out).toContain("still carries an old sign-in value"); expect(existsSync(join(OUT, "auth/web-build.ok"))).toBe(false);
    setSite(OLD_BUNDLE.replace(`${PRD_API}.execute`, "other12345.execute")); r = await run("c-web-prd.sh", ["build"], out()); expect(r.code).toBe(1); expect(r.out).toContain("API address is not the production API");
    setSite(OLD_BUNDLE.replace('VITE_APP_ENV:"production"', 'VITE_APP_ENV:"test"')); r = await run("c-web-prd.sh", ["build"], out()); expect(r.code).toBe(1); expect(r.out).toContain("not marked");
    setSite(OLD_BUNDLE); setAccount(false); r = await run("c-web-prd.sh", ["build"], out()); expect(r.code).toBe(1); expect(r.out).toContain("production pool outputs are missing");
  });
  it("publish: captures the current page, uploads WITHOUT delete, invalidates, and verifies the served site", async () => {
    await run("c-web-prd.sh", ["build"], out()); clearLogs();
    const oldIndex = served();
    const r = await run("c-web-prd.sh", ["publish"], E(out()), "PUBLISH-WEB-Ogevia-prd-AUTH\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("the production API already trusts exactly the production client"); expect(r.out).toContain("VERIFY PASSED");
    expect(readFileSync(join(OUT, "auth/web-before/index.html"), "utf8")).toBe(oldIndex);
    expect(writes()).toContain("cloudfront create-invalidation"); expect(writes()).not.toContain("--delete"); expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
    expect(served()).toBe(readFileSync(join(work, "web-out/index.html"), "utf8"));
    expect(existsSync(join(SITEDIR, "assets/index-OLD111.js"))).toBe(true);        // the previous bundle is kept
  });
  it("publish REFUSES when the API does not yet trust only the production client, without a build, with a changed build, and on a wrong phrase", async () => {
    await run("c-web-prd.sh", ["build"], out()); clearLogs();
    j(S(`authorizers/${PRD_API}.json`), { Items: [{ JwtConfiguration: { Issuer: shared, Audience: [LEGACY, OLD_PRD_CLIENT] } }] });
    let r = await run("c-web-prd.sh", ["publish"], E(out()), "PUBLISH-WEB-Ogevia-prd-AUTH\n"); expect(r.code).toBe(1); expect(r.out).toContain("does not yet trust only the production client"); expect(writes()).toBe("");
    setAccount(true); setSite(OLD_BUNDLE);
    r = await run("c-web-prd.sh", ["publish"], E(out()), "no\n"); expect(r.code).toBe(0); expect(r.out).toContain("Declined"); expect(writes()).toBe("");
    writeFileSync(join(work, "web-out/index.html"), "tampered");
    r = await run("c-web-prd.sh", ["publish"], E(out()), "PUBLISH-WEB-Ogevia-prd-AUTH\n"); expect(r.code).toBe(1); expect(r.out).toContain("changed since it was checked"); expect(writes()).toBe("");
    rmSync(join(OUT, "auth/web-build.ok")); r = await run("c-web-prd.sh", ["publish"], E(out()), "PUBLISH-WEB-Ogevia-prd-AUTH\n"); expect(r.code).toBe(1); expect(r.out).toContain("run 'bash c-web-prd.sh build' first");
    expect((await run("c-web-prd.sh", ["publish"], { ...out() }, "x\n")).out).toContain("approval reference");
  });
  it("rollback: restores the captured index.html, keeps every other file, and the served page is the previous one again", async () => {
    await run("c-web-prd.sh", ["build"], out()); const oldIndex = served();
    await run("c-web-prd.sh", ["publish"], E(out()), "PUBLISH-WEB-Ogevia-prd-AUTH\n"); expect(served()).not.toBe(oldIndex);
    const newAssets = existsSync(join(SITEDIR, "assets")) ? 1 : 0; expect(newAssets).toBe(1);
    const r = await run("c-web-prd.sh", ["rollback"], E(out()), "ROLLBACK-WEB-Ogevia-prd-AUTH\n");
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("ROLLED BACK"); expect(served()).toBe(oldIndex);
    expect(existsSync(join(SITEDIR, "assets/index-OLD111.js"))).toBe(true);
  });
  it("rollback REFUSES without a captured page, with a changed capture, and on a wrong phrase", async () => {
    let r = await run("c-web-prd.sh", ["rollback"], E(out()), "ROLLBACK-WEB-Ogevia-prd-AUTH\n"); expect(r.code).toBe(1); expect(r.out).toContain("no rollback source");
    await run("c-web-prd.sh", ["build"], out()); await run("c-web-prd.sh", ["publish"], E(out()), "PUBLISH-WEB-Ogevia-prd-AUTH\n");
    r = await run("c-web-prd.sh", ["rollback"], E(out()), "no\n"); expect(r.code).toBe(0); expect(r.out).toContain("Declined");
    writeFileSync(join(OUT, "auth/web-before/index.html"), "tampered");
    r = await run("c-web-prd.sh", ["rollback"], E(out()), "ROLLBACK-WEB-Ogevia-prd-AUTH\n"); expect(r.code).toBe(1); expect(r.out).toContain("no rollback source");
  });
  it("verify FAILS when the served site still carries the old pool", async () => {
    await run("c-web-prd.sh", ["build"], out());
    const r = await run("c-web-prd.sh", ["verify"], out()); expect(r.code).toBe(1); expect(r.out).toContain("still carries an old sign-in value");
  });
});

describe("D live token checks", () => {
  beforeEach(() => { setAccount(true); });
  const rules = (prd: Record<string, number>, pilot: Record<string, number>) => j(S("api-rules.json"), { [PRD_API]: prd, [PILOT_API]: pilot });
  it("passes when production accepts only its token and the pilot accepts only the test token; shows no token and leaves no file", async () => {
    rules({ "PRD-TOKEN-VALUE": 200 }, { "TEST-TOKEN-VALUE": 200 });
    const r = await run("d-verify-prd.sh", ["tokens"], { OGEVIA_PRD_TOKEN: "PRD-TOKEN-VALUE", OGEVIA_TEST_TOKEN: "TEST-TOKEN-VALUE" });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("TOKEN CHECKS PASSED");
    for (const s of ["production token -> production API (the administrator can sign in): HTTP 200", "test-pool token -> production API (rejected): HTTP 401", "production token -> pilot API (rejected): HTTP 401", "test-pool token -> pilot API (still works): HTTP 200"]) expect(r.out).toContain(s);
    expect(r.out).not.toContain("TOKEN-VALUE"); expect(spawnSync("bash", ["-c", `ls ${join(OUT, "auth")} | grep -c '^hdr\\.'`], { encoding: "utf8" }).stdout.trim()).toBe("0");
  });
  it("FAILS when production accepts a test token, or the pilot accepts a production token, or the administrator is refused", async () => {
    rules({ "PRD-TOKEN-VALUE": 200, "TEST-TOKEN-VALUE": 200 }, { "TEST-TOKEN-VALUE": 200 });
    let r = await run("d-verify-prd.sh", ["tokens"], { OGEVIA_PRD_TOKEN: "PRD-TOKEN-VALUE", OGEVIA_TEST_TOKEN: "TEST-TOKEN-VALUE" }); expect(r.code).toBe(1); expect(r.out).toContain("FAIL test-pool token -> production API");
    rules({ "PRD-TOKEN-VALUE": 200 }, { "TEST-TOKEN-VALUE": 200, "PRD-TOKEN-VALUE": 200 });
    r = await run("d-verify-prd.sh", ["tokens"], { OGEVIA_PRD_TOKEN: "PRD-TOKEN-VALUE", OGEVIA_TEST_TOKEN: "TEST-TOKEN-VALUE" }); expect(r.code).toBe(1); expect(r.out).toContain("FAIL production token -> pilot API");
    rules({}, { "TEST-TOKEN-VALUE": 200 });
    r = await run("d-verify-prd.sh", ["tokens"], { OGEVIA_PRD_TOKEN: "PRD-TOKEN-VALUE", OGEVIA_TEST_TOKEN: "TEST-TOKEN-VALUE" }); expect(r.code).toBe(1); expect(r.out).toContain("FAIL production token -> production API");
  });
  it("skips the token checks it was given no token for, and still checks anonymous calls", async () => {
    rules({}, {}); const r = await run("d-verify-prd.sh", ["tokens"], {}, "\n\n");
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("no production token supplied"); expect(r.out).toContain("no token -> production API: HTTP 401");
  });
});

describe("E rollback", () => {
  const PREV = () => join(work, "previous-infra");
  const marker = (age = 10) => { mkdirSync(join(OUT, "auth"), { recursive: true }); writeFileSync(join(OUT, "auth/rollback-gate.ok"), String(Math.floor(Date.now() / 1000) - age)); };
  const argv = () => (existsSync(join(MOCK, "cdk-argv.log")) ? readFileSync(join(MOCK, "cdk-argv.log"), "utf8") : "");
  beforeEach(() => {
    setAccount(true);
    mkdirSync(join(PREV(), "bin"), { recursive: true }); mkdirSync(join(PREV(), "lib"), { recursive: true });
    writeFileSync(join(PREV(), "bin/ogevia.ts"), "// previous"); writeFileSync(join(PREV(), "lib/config.ts"), "// previous config without the dedicated pool");
  });
  it("rollback-check proves that the previous commit plus the allow-list equals the current live state, and writes a marker", async () => {
    cpSync(NEWT, join(MOCK, "live"), { recursive: true });
    const r = await run("a-deploy-prd.sh", ["rollback-check"], { OGEVIA_AUTH_PREVIOUS_TEMPLATES: FIXTURE_BEFORE });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("ROLLBACK CHECK PASSED"); expect(existsSync(join(OUT, "auth/rollback-gate.ok"))).toBe(true); expect(writes()).toBe("");
  });
  it("rollback-check FAILS when the previous commit does not reproduce the pre-change state, or the Auth stack is absent", async () => {
    cpSync(NEWT, join(MOCK, "live"), { recursive: true });
    const drift = join(work, "prev-drift"); cpSync(FIXTURE_BEFORE, drift, { recursive: true });
    const t = JSON.parse(readFileSync(join(drift, "Ogevia-prd-ServiceVerificationApi.json"), "utf8")); t.Description = "different"; writeFileSync(join(drift, "Ogevia-prd-ServiceVerificationApi.json"), JSON.stringify(t));
    let r = await run("a-deploy-prd.sh", ["rollback-check"], { OGEVIA_AUTH_PREVIOUS_TEMPLATES: drift }); expect(r.code).toBe(1);
    setAccount(false); cpSync(NEWT, join(MOCK, "live"), { recursive: true });
    r = await run("a-deploy-prd.sh", ["rollback-check"], { OGEVIA_AUTH_PREVIOUS_TEMPLATES: FIXTURE_BEFORE }); expect(r.code).toBe(1); expect(r.out).toContain("Ogevia-prd-Auth does not exist");
  });
  it("api: redeploys ONLY the production API stack from the previous commit, after the phrase", async () => {
    marker();
    const r = await run("e-rollback-prd.sh", ["api"], { OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_PREVIOUS_CDK_DIR: PREV() }, "ROLLBACK-Ogevia-prd-Api\n");
    expect(r.code, r.out).toBe(0);
    expect(argv().split("\n")[0]).toBe("deploy -c env=prd -c mode=deploy --exclusively Ogevia-prd-ServiceVerificationApi --require-approval broadening --no-notices");
    expect(argv()).not.toContain("Auth"); expect(r.out).toContain("Ogevia-prd-Auth is left in place");
  });
  it("api REFUSES without a fresh marker, with the NEW code directory, without approval, and on a wrong phrase", async () => {
    const env = { OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_PREVIOUS_CDK_DIR: PREV() };
    expect((await run("e-rollback-prd.sh", ["api"], env, "ROLLBACK-Ogevia-prd-Api\n")).out).toContain("no marker");
    marker(7200); expect((await run("e-rollback-prd.sh", ["api"], env, "ROLLBACK-Ogevia-prd-Api\n")).out).toContain("limit 3600");
    marker(); writeFileSync(join(PREV(), "lib/config.ts"), "dedicatedUserPool: {}");
    expect((await run("e-rollback-prd.sh", ["api"], env, "ROLLBACK-Ogevia-prd-Api\n")).out).toContain("NEW code");
    writeFileSync(join(PREV(), "lib/config.ts"), "// previous");
    expect((await run("e-rollback-prd.sh", ["api"], { OGEVIA_PREVIOUS_CDK_DIR: PREV() }, "ROLLBACK-Ogevia-prd-Api\n")).out).toContain("approval reference");
    const w = await run("e-rollback-prd.sh", ["api"], env, "yes\n"); expect(w.code).toBe(0); expect(w.out).toContain("Declined");
    expect(argv()).toBe("");
  });
  it("post: passes once production trusts the shared pool and the old production client again, fails otherwise", async () => {
    setAccount(false); let r = await run("e-rollback-prd.sh", ["post"]); expect(r.code, r.out).toBe(0); expect(r.out).toContain("production trusts the shared pool again");
    setAccount(true); r = await run("e-rollback-prd.sh", ["post"]); expect(r.code).toBe(1); expect(r.out).toContain("not the shared pool");
  });
});

describe("G web headers: the follow-up fix for the browser blocking the sign-in code exchange", () => {
  const base = (extra: Record<string, string> = {}) => ({ OGEVIA_AUTH_NEW_TEMPLATES: NEWT, OGEVIA_DEPLOY_APPROVAL: "owner-go-webhdr-20261022", OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-auth-202610211500", OGEVIA_HEADER_WAIT_TRIES: "1", OGEVIA_HEADER_WAIT: "0", ...extra });
  const PHRASE = "DEPLOY-Ogevia-prd-WebHosting-Headers\n";
  const argv = () => (existsSync(join(MOCK, "cdk-argv.log")) ? readFileSync(join(MOCK, "cdk-argv.log"), "utf8") : "");
  const setCsp = (csp: string) => { mkdirSync(S("cloudfront"), { recursive: true }); writeFileSync(S("cloudfront/csp.txt"), csp + "\n"); };
  const marker = () => join(OUT, "auth/web-headers-gate.ok");
  beforeEach(() => {
    setAccount(true); rmSync(join(MOCK, "live"), { recursive: true, force: true }); cpSync(FIXTURE_DEPLOYED, join(MOCK, "live"), { recursive: true });   // live = the deployed authentication release
    rmSync(marker(), { force: true }); setCsp(OLD_CSP); clearLogs();
  });

  it("check PASSES on the deployed state: the only difference is the website's security header; it changes nothing and writes a marker", async () => {
    const r = await run("g-web-headers-prd.sh", ["check"], base());
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("CHECK PASSED"); expect(r.out).toContain("only Ogevia-prd-WebHosting changes"); expect(existsSync(marker())).toBe(true);
    expect(writes()).toBe("");
  });

  it("check REFUSES when the header is already the new one (nothing to deploy), when another stack drifted, or when the API/Auth stack differs", async () => {
    cpSync(NEWT, join(MOCK, "live"), { recursive: true });
    let r = await run("g-web-headers-prd.sh", ["check"], base()); expect(r.code).toBe(1); expect(r.out).toContain("exactly ONE security-header change"); expect(existsSync(marker())).toBe(false);
    rmSync(join(MOCK, "live"), { recursive: true, force: true }); cpSync(FIXTURE_DEPLOYED, join(MOCK, "live"), { recursive: true });
    const t = JSON.parse(readFileSync(join(MOCK, "live/Ogevia-prd-EvidenceStorage.json"), "utf8")); t.Description = "someone changed this"; writeFileSync(join(MOCK, "live/Ogevia-prd-EvidenceStorage.json"), JSON.stringify(t));
    r = await run("g-web-headers-prd.sh", ["check"], base()); expect(r.code).toBe(1); expect(r.out).toContain("Ogevia-prd-EvidenceStorage: differs from live"); expect(existsSync(marker())).toBe(false);
    cpSync(FIXTURE_DEPLOYED, join(MOCK, "live"), { recursive: true });
    const a = JSON.parse(readFileSync(join(MOCK, "live/Ogevia-prd-ServiceVerificationApi.json"), "utf8")); a.Description = "drift"; writeFileSync(join(MOCK, "live/Ogevia-prd-ServiceVerificationApi.json"), JSON.stringify(a));
    r = await run("g-web-headers-prd.sh", ["check"], base()); expect(r.code).toBe(1); expect(r.out).toContain("Ogevia-prd-ServiceVerificationApi: differs from live");
  });

  it("deploy refuses without the marker, the approval reference or a snapshot, and with a stale marker; a wrong phrase changes nothing", async () => {
    expect((await run("g-web-headers-prd.sh", ["deploy"], base(), PHRASE)).out).toContain("run 'bash g-web-headers-prd.sh check' first");
    await run("g-web-headers-prd.sh", ["check"], base());
    expect((await run("g-web-headers-prd.sh", ["deploy"], base({ OGEVIA_DEPLOY_APPROVAL: "x" }), PHRASE)).out).toContain("approval reference");
    expect((await run("g-web-headers-prd.sh", ["deploy"], base({ OGEVIA_PREDEPLOY_SNAPSHOT_ID: "" }), PHRASE)).out).toContain("OGEVIA_PREDEPLOY_SNAPSHOT_ID");
    writeFileSync(marker(), `x ${Math.floor(Date.now() / 1000) - 7200}\n`);
    expect((await run("g-web-headers-prd.sh", ["deploy"], base(), PHRASE)).out).toContain("old (limit 3600)");
    await run("g-web-headers-prd.sh", ["check"], base());
    const r = await run("g-web-headers-prd.sh", ["deploy"], base(), "yes\n"); expect(r.code).toBe(0); expect(r.out).toContain("Declined");
    expect(argv()).toBe("");
  });

  it("with the phrase it runs EXACTLY a one-stack cdk deploy of the web stack, and a failed deploy is not reported as success", async () => {
    await run("g-web-headers-prd.sh", ["check"], base());
    let r = await run("g-web-headers-prd.sh", ["deploy"], base(), PHRASE); expect(r.code, r.out).toBe(0);
    const [line, approval] = argv().trim().split("\n");
    expect(line).toBe("deploy -c env=prd -c mode=deploy --exclusively Ogevia-prd-WebHosting --require-approval broadening --no-notices");
    expect(approval).toBe("approval=owner-go-webhdr-20261022");
    for (const forbidden of ["--all", "--force", "--hotswap", "--no-rollback", "Auth", "ServiceVerificationApi", "Ogevia-prod", "*"]) expect(line).not.toContain(forbidden);
    clearLogs(); await run("g-web-headers-prd.sh", ["check"], base());
    r = await run("g-web-headers-prd.sh", ["deploy"], base({ FAKE_CDK_EXIT: "1" }), PHRASE); expect(r.code).toBe(1); expect(r.out).toContain("cdk deploy failed"); expect(r.out).not.toContain("DEPLOYED.");
  });

  it("post PASSES when the live policy and the SERVED page allow the dedicated domain and not the shared one", async () => {
    setCsp(GOOD_CSP);
    const r = await run("g-web-headers-prd.sh", ["post"], base()); expect(r.code, r.out).toBe(0); expect(r.out).toContain("POST-CHECKS PASSED");
  });

  it("post FAILS when the live policy still has the old header, when the served page has no header or the old one, or when both domains are allowed", async () => {
    setCsp(OLD_CSP);
    let r = await run("g-web-headers-prd.sh", ["post"], base()); expect(r.code).toBe(1); expect(r.out).toContain("does not allow");
    setCsp(GOOD_CSP);
    r = await run("g-web-headers-prd.sh", ["post"], base({ MOCK_CSP: OLD_CSP })); expect(r.code).toBe(1); expect(r.out).toContain("served Content-Security-Policy does not");
    r = await run("g-web-headers-prd.sh", ["post"], base({ MOCK_CSP: "" })); expect(r.code).toBe(1); expect(r.out).toContain("served Content-Security-Policy does not");
    setCsp(cspWith(`${DOMAIN_NEW} ${DOMAIN_SHARED}`));
    r = await run("g-web-headers-prd.sh", ["post"], base({ MOCK_CSP: cspWith(`${DOMAIN_NEW} ${DOMAIN_SHARED}`) })); expect(r.code).toBe(1);
  });

  it("c-web verify now ALSO fails when the served page's Content-Security-Policy would block the sign-in (the check that was missing)", async () => {
    setSite(OLD_BUNDLE);
    const build = await run("c-web-prd.sh", ["build"], { OGEVIA_PRD_WEB_OUT: join(work, "web-out") }); expect(build.code, build.out).toBe(0);
    await run("c-web-prd.sh", ["publish"], { OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_PRD_WEB_OUT: join(work, "web-out") }, "PUBLISH-WEB-Ogevia-prd-AUTH\n");
    let r = await run("c-web-prd.sh", ["verify"], { OGEVIA_PRD_WEB_OUT: join(work, "web-out") }); expect(r.code, r.out).toBe(0); expect(r.out).toContain("allows the production sign-in domain");
    r = await run("c-web-prd.sh", ["verify"], { OGEVIA_PRD_WEB_OUT: join(work, "web-out"), MOCK_CSP: OLD_CSP }); expect(r.code).toBe(1); expect(r.out).toContain("does NOT allow the production sign-in domain");
    r = await run("c-web-prd.sh", ["verify"], { OGEVIA_PRD_WEB_OUT: join(work, "web-out"), MOCK_CSP: "" }); expect(r.code).toBe(1); expect(r.out).toContain("no Content-Security-Policy header");
  });
});
