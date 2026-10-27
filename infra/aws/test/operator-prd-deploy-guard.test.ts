// deploy-guard-prd.sh (PRODUCTION release 2026-10-26-redesign): the only deployment path, for exactly one of TWO stacks per call (Ogevia-prd-Auth, Ogevia-prd-ServiceVerificationApi). Fake aws and npx;
// the REAL synthesized release is the assembly and the bundled templates, and the "live" production stacks are derived from the 2026-10-26 read-only capture. No AWS, no network, synthetic.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { API, APPROVAL, AUTH, NET, NEW_KEYS, PKG_REL, PRD_STACKS, SCRIPTS_SRC, WEB, liveOf, release, sh, synth } from "./operator-prd-fixtures.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });
const OLD_KEYS = ["GET /v1/me", "POST /v1/visits", "GET /v1/clients", "POST /v1/shifts", "GET /v1/reports/hours"];
const POOL = "us-west-2_FHJoX71ca";
const AWS = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
stack=$(grep -o 'Ogevia-pr[a-z]*-[A-Za-z]*' <<<"$*" | head -1)
case "$1 $2" in
  "sts get-caller-identity") echo "{\\"Account\\":\\"\${MOCK_ACCOUNT:-300094796789}\\"}" ;;
  "cloudformation describe-stacks") echo "{\\"Stacks\\":[{\\"StackStatus\\":\\"\${MOCK_STACK_STATUS:-UPDATE_COMPLETE}\\"}]}" ;;
  "cloudformation get-template") cat "$D/live-$stack.json" ;;
  "cloudformation list-stack-resources") cat "$D/resources-$stack.json" ;;
  "rds describe-db-snapshots") cat "$D/snapshot.json" ;;
  "lambda get-function-configuration") cat "$D/lambda-after-raw.json" ;;
  "apigatewayv2 get-routes") cat "$D/routes-after-raw.json" ;;
  "apigatewayv2 get-api") cat "$D/api-after-raw.json" ;;
  "events describe-rule") echo "{\\"State\\":\\"\${MOCK_SWEEP_STATE:-ENABLED}\\"}" ;;
  "cognito-idp describe-user-pool-client") cat "$D/client-after-raw.json" ;;
  *) echo "mock aws: unexpected call: $*" >&2; echo "UNEXPECTED $*" >> "$D/aws-calls.log"; exit 99 ;;
esac
`;
const NPX = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/npx-calls.log"
if [[ "$*" == *"cdk diff"* ]]; then echo "Resources"; echo "[~] mock diff"; exit 0; fi
if [[ "$*" == *"cdk deploy"* ]]; then [[ -n "\${MOCK_DEPLOY_FAIL:-}" ]] && { echo "deploy failed" >&2; exit 1; }; echo deployed; exit 0; fi
exit 97
`;
interface Fix { dir: string; bin: string; scripts: string; asm: string; before: string; root: string }
let f: Fix;
const w = (p: string, v: unknown) => writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
const iso = (secAgo: number) => new Date(Date.now() - secAgo * 1000).toISOString();
const SNAP = "ogevia-prod-postgres-pre-0086-prd-202610270410";
const liveBeforeAll = () => { for (const s of [...PRD_STACKS, NET]) w(join(f.dir, `live-${s}.json`), liveOf(s)); };
const afterState = () => {   // production AFTER a good release
  for (const s of [...PRD_STACKS, NET]) w(join(f.dir, `live-${s}.json`), release(s));
};
function fixture(): Fix {
  const dir = mkdtempSync(join(tmpdir(), "guardprd-"));
  const root = join(dir, "pkg"); const scripts = join(root, PKG_REL, "scripts");
  mkdirSync(join(root, "infra/aws"), { recursive: true }); mkdirSync(scripts, { recursive: true }); cpSync(SCRIPTS_SRC, scripts, { recursive: true });
  cpSync(synth().rel, join(root, PKG_REL, "release-templates"), { recursive: true });
  const bin = join(dir, "bin"); mkdirSync(bin);
  w(join(bin, "aws"), AWS); w(join(bin, "npx"), NPX); chmodSync(join(bin, "aws"), 0o755); chmodSync(join(bin, "npx"), 0o755);
  const before = join(dir, "before"); mkdirSync(before);
  const env = { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd", X: "1" } };
  w(join(before, "handler-function-name.txt"), "fn-handler\n"); w(join(before, "api-id.txt"), "zk527zk4ua\n");
  w(join(before, "lambda-config-before.json"), { CodeSha256: "OLDSHA=", EnvironmentVariableNames: ["DB_NAME", "OGEVIA_ENV", "X"], DB_NAME: "ogevia_prd", OGEVIA_ENV: "prd" });
  w(join(before, "routes-before.json"), OLD_KEYS);
  w(join(before, "cors-before.json"), { AllowOrigins: ["https://app.ogevia.com", "https://x.cloudfront.net"], AllowMethods: ["GET", "POST"], AllowHeaders: ["authorization"] });
  w(join(before, "cognito-client-before.json"), { callbacks: ["https://x.cloudfront.net/auth/callback"], logouts: ["https://x.cloudfront.net/"] });
  w(join(dir, "snapshot.json"), { DBSnapshots: [{ Status: "available", DBInstanceIdentifier: "ogevia-prod-postgres", SnapshotType: "manual", Encrypted: true, SnapshotCreateTime: iso(600) }] });
  w(join(dir, `resources-${AUTH}.json`), { StackResourceSummaries: [{ ResourceType: "AWS::Cognito::UserPool", PhysicalResourceId: POOL }, { ResourceType: "AWS::Cognito::UserPoolClient", PhysicalResourceId: "client123" }] });
  w(join(dir, `resources-${API}.json`), { StackResourceSummaries: [{ ResourceType: "AWS::Events::Rule", PhysicalResourceId: "ComplianceSweepAB12" }] });
  w(join(dir, "lambda-after-raw.json"), { CodeSha256: "NEWSHA=", LastUpdateStatus: "Successful", Environment: env });
  w(join(dir, "routes-after-raw.json"), { Items: [...OLD_KEYS, ...NEW_KEYS].map((RouteKey) => ({ RouteKey })) });
  w(join(dir, "api-after-raw.json"), { CorsConfiguration: { AllowOrigins: ["https://app.ogevia.com", "https://x.cloudfront.net", "https://admin.ogevia.com"], AllowMethods: ["GET", "POST"], AllowHeaders: ["authorization"] } });
  w(join(dir, "client-after-raw.json"), { UserPoolClient: { CallbackURLs: ["https://x.cloudfront.net/auth/callback", "https://app.ogevia.com/auth/callback", "https://admin.ogevia.com/auth/callback"], LogoutURLs: ["https://x.cloudfront.net/", "https://app.ogevia.com/", "https://admin.ogevia.com/"] } });
  const fx = { dir, bin, scripts, asm: synth().deploy, before, root };
  f = fx; liveBeforeAll();
  return fx;
}
beforeAll(() => { synth(); });
beforeEach(() => { f = fixture(); });
const guard = (args: string[], opts: { env?: Record<string, string>; input?: string } = {}) =>
  sh("bash", [join(f.scripts, "deploy-guard-prd.sh"), ...args], { input: opts.input ?? "", env: { PATH: `${f.bin}:${process.env.PATH}`, MOCK_DIR: f.dir, ASSEMBLY: f.asm, OGEVIA_PRD_BEFORE: f.before, OGEVIA_DEPLOY_APPROVAL: APPROVAL, OGEVIA_PREDEPLOY_SNAPSHOT_ID: SNAP, HOME: f.dir, ...(opts.env ?? {}) } });
const log = (n: string) => (existsSync(join(f.dir, n)) ? readFileSync(join(f.dir, n), "utf8").split("\n").filter(Boolean) : []);
const deploys = () => log("npx-calls.log").filter((c) => c.includes("cdk deploy"));
const writes = () => log("aws-calls.log").filter((c) => /^(cloudformation (create|update|delete|execute)|lambda (update|publish|delete)|iam |ec2 (authorize|revoke)|s3 |apigatewayv2 (create|update|delete)|cognito-idp (update|create|delete|admin))/.test(c));
const markDb = () => w(join(f.before, "db-0086.ok"), "85|0085|0086\n");
const markAuth = () => w(join(f.before, "auth-at-release.ok"), "2026-10-27T04:30:00Z\n");
const ready = () => { markDb(); };

describe("check: read-only, passes only for the expected difference", () => {
  it("Auth and API show DELTA, WebHosting shows EXPORT-ONLY, the other four show NONE; nothing is deployed or written", () => {
    for (const [s, word] of [[AUTH, "DELTA"], [API, "DELTA"], [WEB, "EXPORT-ONLY"], ["Ogevia-prd-DatabaseSecret", "NONE"], ["Ogevia-prd-EvidenceStorage", "NONE"], ["Ogevia-prd-Observability", "NONE"], [NET, "NONE"]] as const) {
      const r = guard(["check", s]);
      expect(r.code, `${s}: ${r.out}`).toBe(0); expect(r.out).toContain(`CHECK PASSED for ${s} (${word})`);
    }
    expect(deploys()).toEqual([]); expect(writes()).toEqual([]);
  });
  it("runs the assembly check and shows the read-only cdk diff for a stack of the assembly", () => {
    const r = guard(["check", API]);
    expect(r.out).toContain("PASS all checks"); expect(r.out).toContain("cdk diff"); expect(r.out).toContain("13 staff API routes added");
    expect(log("npx-calls.log").every((c) => !c.includes("cdk deploy"))).toBe(true);
  });
  it("refuses a TEST stack, a pattern, a list, an unknown stack, a missing argument and an unknown mode", () => {
    for (const a of [["check", "Ogevia-prod-ServiceVerificationApi"], ["check", "Ogevia-prod-WebHosting"], ["check", "Ogevia-prd-*"], ["check", `${API} ${AUTH}`], ["check", "--all"], ["check", ""], ["check", "Ogevia-prd-Other"]]) { const r = guard(a); expect(r.code, `${a}: ${r.out}`).toBe(1); expect(r.out).toContain("REFUSED"); }
    expect(guard(["check"]).code).toBe(2); expect(guard(["destroy", API]).code).toBe(2); expect(guard([]).code).toBe(2); expect(guard(["check", API, "extra"]).code).toBe(2);
    expect(deploys()).toEqual([]);
  });
  it("stops when the live stack is not what was read: an extra resource, a different Handler environment, an unsettled stack, another account", () => {
    let live = liveOf(API); live.Resources.Hand = { Type: "AWS::SSM::Parameter", Properties: {} }; w(join(f.dir, `live-${API}.json`), live);
    let r = guard(["check", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("REMOVED"); expect(r.out).toContain("NOT the release's expected change");
    liveBeforeAll(); live = liveOf(AUTH); live.Resources[Object.keys(live.Resources).find((k) => live.Resources[k].Type === "AWS::Cognito::UserPoolClient")!].Properties.CallbackURLs.push("https://hand.example/cb"); w(join(f.dir, `live-${AUTH}.json`), live);
    r = guard(["check", AUTH]); expect(r.code, r.out).toBe(1);
    liveBeforeAll(); r = guard(["check", API], { env: { MOCK_STACK_STATUS: "UPDATE_ROLLBACK_COMPLETE" } }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not settled");
    r = guard(["check", API], { env: { MOCK_ACCOUNT: "111111111111" } }); expect(r.code, r.out).toBe(1);
    expect(deploys()).toEqual([]);
  });
  it("stops when the assembly is not the release (a stale or tampered template); with none, check compares with the bundled templates and deploy refuses", () => {
    const asm = mkdtempSync(join(tmpdir(), "asm-")); cpSync(synth().deploy, asm, { recursive: true });
    const p = join(asm, `${API}.template.json`); const t = JSON.parse(readFileSync(p, "utf8")); t.Resources.Extra = { Type: "AWS::SSM::Parameter", Properties: {} }; writeFileSync(p, JSON.stringify(t));
    let r = guard(["check", API], { env: { ASSEMBLY: asm } }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not the approved release");
    r = guard(["check", AUTH], { env: { ASSEMBLY: join(f.dir, "nowhere") } }); expect(r.code, r.out).toBe(0); expect(r.out).toContain("a deployment needs one");   // read-only check against the bundled release templates
    r = guard(["deploy", AUTH], { env: { ASSEMBLY: join(f.dir, "nowhere") }, input: "DEPLOY-Ogevia-prd-Auth\n" }); expect(r.code, r.out).toBe(1); expect(deploys()).toEqual([]);
  });
});

describe("deploy: only after every prerequisite, one stack, typed phrase, exact command", () => {
  const phrase = (s: string) => `DEPLOY-${s}\n`;
  it.each([[WEB], [NET], ["Ogevia-prd-DatabaseSecret"], ["Ogevia-prd-EvidenceStorage"], ["Ogevia-prd-Observability"]])("refuses to deploy %s (it can only be checked)", (s) => {
    ready(); const r = guard(["deploy", s], { input: phrase(s) });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("can only be checked"); expect(deploys()).toEqual([]);
  });
  it("refuses without the approval reference, with the placeholder, without the migration marker, with a wrong marker and without an assembly", () => {
    ready();
    for (const [env, text] of [[{ OGEVIA_DEPLOY_APPROVAL: "" }, "OGEVIA_DEPLOY_APPROVAL"], [{ OGEVIA_DEPLOY_APPROVAL: "APPROVAL-REF-PENDING-OWNER" }, "placeholder"], [{ OGEVIA_DEPLOY_APPROVAL: "x y" }, "OGEVIA_DEPLOY_APPROVAL"]] as const) {
      const r = guard(["deploy", AUTH], { env, input: phrase(AUTH) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text);
    }
    rmSync(join(f.before, "db-0086.ok")); let r = guard(["deploy", AUTH], { input: phrase(AUTH) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("db-0086.ok");
    w(join(f.before, "db-0086.ok"), "85|0085\n"); r = guard(["deploy", AUTH], { input: phrase(AUTH) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("db-0086.ok");
    markDb(); r = guard(["deploy", AUTH], { env: { ASSEMBLY: join(f.dir, "nowhere") }, input: phrase(AUTH) }); expect(r.code, r.out).toBe(1);
    expect(deploys()).toEqual([]);
  });
  it("refuses to deploy again once the record state says the release took effect (complete or incomplete)", () => {
    ready();
    for (const st of ["DEPLOYED-RECORD-COMPLETE", "DEPLOYED-RECORD-INCOMPLETE"]) {
      w(join(f.before, "release-record.state"), `${st} ${"a".repeat(40)} 2026-10-27T05:00:00Z\n`);
      const r = guard(["deploy", AUTH], { input: phrase(AUTH) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("already taken effect"); expect(deploys()).toEqual([]);
    }
    rmSync(join(f.before, "release-record.state"));
  });
  it("refuses a missing, mis-named, unavailable, automated, unencrypted, foreign or stale snapshot", () => {
    ready();
    const snap = (patch: Record<string, unknown>) => w(join(f.dir, "snapshot.json"), { DBSnapshots: [{ Status: "available", DBInstanceIdentifier: "ogevia-prod-postgres", SnapshotType: "manual", Encrypted: true, SnapshotCreateTime: iso(600), ...patch }] });
    expect(guard(["deploy", AUTH], { env: { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "" }, input: phrase(AUTH) }).out).toContain("OGEVIA_PREDEPLOY_SNAPSHOT_ID");
    expect(guard(["deploy", AUTH], { env: { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0086-202610270410" }, input: phrase(AUTH) }).out).toContain("OGEVIA_PREDEPLOY_SNAPSHOT_ID");   // the TEST snapshot pattern
    for (const [patch, text] of [[{ Status: "creating" }, "not available"], [{ SnapshotType: "automated" }, "not available"], [{ Encrypted: false }, "not available"], [{ DBInstanceIdentifier: "other" }, "not available"], [{ SnapshotCreateTime: iso(8 * 3600) }, "old"]] as const) {
      snap(patch); const r = guard(["deploy", AUTH], { input: phrase(AUTH) }); expect(r.code, `${JSON.stringify(patch)}: ${r.out}`).toBe(1); expect(r.out).toContain(text);
    }
    w(join(f.dir, "snapshot.json"), { DBSnapshots: [null] }); expect(guard(["deploy", AUTH], { input: phrase(AUTH) }).code).toBe(1);
    expect(deploys()).toEqual([]);
  });
  it("the API stack needs the Auth stack deployed and post-checked first", () => {
    ready(); const r = guard(["deploy", API], { input: phrase(API) });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("auth-at-release.ok"); expect(deploys()).toEqual([]);
  });
  it("shows the exact command, needs the typed phrase for THIS stack, and runs exactly one cdk deploy", () => {
    ready();
    let r = guard(["deploy", AUTH], { input: "yes\n" }); expect(r.code, r.out).toBe(0); expect(r.out).toContain("Declined. Nothing was deployed."); expect(deploys()).toEqual([]);
    r = guard(["deploy", AUTH], { input: phrase(API) }); expect(r.out).toContain("Declined"); expect(deploys()).toEqual([]);
    r = guard(["deploy", AUTH], { input: "DEPLOY-Ogevia-prod-ServiceVerificationApi\n" }); expect(r.out).toContain("Declined"); expect(deploys()).toEqual([]);
    r = guard(["deploy", AUTH], { input: phrase(AUTH) });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain(`ABOUT TO RUN (YELLOW, changes PRODUCTION): npx cdk deploy --app ${f.asm} --exclusively ${AUTH} --require-approval broadening --no-notices`);
    expect(deploys()).toEqual([`cdk deploy --app ${f.asm} --exclusively ${AUTH} --require-approval broadening --no-notices`]);
    expect(writes()).toEqual([]);   // the guard itself writes nothing to AWS; only the (mock) cdk deploy ran
  });
  it("deploys the API stack after the Auth marker exists: one command, the API stack only", () => {
    ready(); markAuth();
    const r = guard(["deploy", API], { input: phrase(API) });
    expect(r.code, r.out).toBe(0); expect(deploys()).toEqual([`cdk deploy --app ${f.asm} --exclusively ${API} --require-approval broadening --no-notices`]);
  });
  it("refuses when there is nothing to deploy (the stack already equals the release) and when the difference is not the release's", () => {
    ready(); afterState();
    let r = guard(["deploy", AUTH], { input: phrase(AUTH) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not DELTA"); expect(deploys()).toEqual([]);
    liveBeforeAll(); const live = liveOf(AUTH); live.Resources.Hand = { Type: "AWS::SSM::Parameter", Properties: {} }; w(join(f.dir, `live-${AUTH}.json`), live);
    r = guard(["deploy", AUTH], { input: phrase(AUTH) }); expect(r.code, r.out).toBe(1); expect(deploys()).toEqual([]);
  });
  it("a failing cdk deploy exits 1 and says not to deploy the next stack", () => {
    ready(); const r = guard(["deploy", AUTH], { input: phrase(AUTH), env: { MOCK_DEPLOY_FAIL: "1" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("cdk deploy exited 1"); expect(r.out).toContain("Do not deploy the next stack");
  });
  it("the script cannot be pointed at a pattern, --all, --force, --hotswap or another stack on the command line", () => {
    const code = readFileSync(join(f.scripts, "deploy-guard-prd.sh"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).toContain("--exclusively \"$STACK\" --require-approval broadening --no-notices");
    for (const bad of ["--all)", "--force", "--hotswap", "--no-rollback", "--concurrency"]) expect(code.split("\n").filter((l) => l.includes("cdk deploy") || l.includes("DEPLOY_ARGV=")).join("\n")).not.toContain(bad.replace(")", ""));
    expect(code).toMatch(/Ogevia-prod-\*/);   // the argv self-check refuses a TEST stack name
  });
});

describe("post: read-only checks after each deployment", () => {
  it("Auth: passes when the live template equals the release and the client lists the new URLs; writes the Auth marker", () => {
    afterState();
    const r = guard(["post", AUTH]);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("POST-CHECK PASSED"); expect(existsSync(join(f.before, "auth-at-release.ok"))).toBe(true); expect(writes()).toEqual([]);
  });
  it.each([
    ["the template still differs", () => { liveBeforeAll(); }, "still differs"],
    ["the client lacks the admin. URLs", () => w(join(f.dir, "client-after-raw.json"), { UserPoolClient: { CallbackURLs: ["https://x.cloudfront.net/auth/callback", "https://app.ogevia.com/auth/callback"], LogoutURLs: ["https://x.cloudfront.net/", "https://app.ogevia.com/"] } }), "does not list the app. and admin. URLs"],
    ["an earlier callback URL was lost", () => w(join(f.dir, "client-after-raw.json"), { UserPoolClient: { CallbackURLs: ["https://app.ogevia.com/auth/callback", "https://admin.ogevia.com/auth/callback"], LogoutURLs: ["https://x.cloudfront.net/", "https://app.ogevia.com/", "https://admin.ogevia.com/"] } }), "earlier callback or sign-out URL is missing"],
    ["the user pool is another one", () => w(join(f.dir, `resources-${AUTH}.json`), { StackResourceSummaries: [{ ResourceType: "AWS::Cognito::UserPool", PhysicalResourceId: "us-west-2_OTHER" }, { ResourceType: "AWS::Cognito::UserPoolClient", PhysicalResourceId: "client123" }] }), "us-west-2_FHJoX71ca"],
  ])("Auth fails when %s (no marker)", (_n, mutate, text) => {
    afterState(); (mutate as () => void)();
    const r = guard(["post", AUTH]); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(existsSync(join(f.before, "auth-at-release.ok"))).toBe(false);
  });
  it("API: passes (status, template, Handler changed, environment unchanged, 13 routes, CORS, sweep) and writes the API marker", () => {
    afterState();
    const r = guard(["post", API]);
    expect(r.code, r.out).toBe(0);
    for (const t of ["PASS Ogevia-prd-ServiceVerificationApi is UPDATE_COMPLETE", "the live template now equals the release template", "the Lambda code changed", "still serves ogevia_prd with OGEVIA_ENV=prd", "environment variable names are unchanged", "the API gained exactly 13 routes", "all 13 staff routes exist", "no earlier route was lost", "only the app. and admin. origins were added", "ComplianceSweep rule ComplianceSweepAB12 is ENABLED", "POST-CHECK PASSED"]) expect(r.out, t).toContain(t);
    expect(readFileSync(join(f.before, "api-at-release.ok"), "utf8").trim()).toBe("NEWSHA="); expect(writes()).toEqual([]);
  });
  it("API: the CORS origins already being on the live API (applied by hand) still pass; any other CORS change fails", () => {
    afterState(); w(join(f.before, "cors-before.json"), { AllowOrigins: ["https://app.ogevia.com", "https://x.cloudfront.net", "https://admin.ogevia.com"], AllowMethods: ["GET", "POST"], AllowHeaders: ["authorization"] });
    expect(guard(["post", API]).code).toBe(0);
    afterState(); w(join(f.dir, "api-after-raw.json"), { CorsConfiguration: { AllowOrigins: ["https://app.ogevia.com", "https://x.cloudfront.net", "https://admin.ogevia.com", "https://evil.example"], AllowMethods: ["GET", "POST"], AllowHeaders: ["authorization"] } });
    let r = guard(["post", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("CORS configuration changed in another way");
    w(join(f.dir, "api-after-raw.json"), { CorsConfiguration: { AllowOrigins: ["https://app.ogevia.com", "https://x.cloudfront.net", "https://admin.ogevia.com"], AllowMethods: ["GET", "POST", "DELETE"], AllowHeaders: ["authorization"] } });
    r = guard(["post", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("CORS configuration changed in another way");
  });
  it.each([
    ["the template still differs", () => liveBeforeAll(), "still differs"],
    ["the Lambda code did not change", () => w(join(f.dir, "lambda-after-raw.json"), { CodeSha256: "OLDSHA=", LastUpdateStatus: "Successful", Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd", X: "1" } } }), "did not change"],
    ["the Lambda update did not succeed", () => w(join(f.dir, "lambda-after-raw.json"), { CodeSha256: "NEWSHA=", LastUpdateStatus: "Failed", Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd", X: "1" } } }), "LastUpdateStatus is not Successful"],
    ["the Lambda environment changed (a new variable)", () => w(join(f.dir, "lambda-after-raw.json"), { CodeSha256: "NEWSHA=", LastUpdateStatus: "Successful", Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd", X: "1", NEW: "2" } } }), "environment variable names changed"],
    ["the Lambda serves another database", () => w(join(f.dir, "lambda-after-raw.json"), { CodeSha256: "NEWSHA=", LastUpdateStatus: "Successful", Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_sv_test", X: "1" } } }), "DB_NAME/OGEVIA_ENV changed"],
    ["only 12 routes were added", () => w(join(f.dir, "routes-after-raw.json"), { Items: [...OLD_KEYS, ...NEW_KEYS.slice(1)].map((RouteKey) => ({ RouteKey })) }), "not"],
    ["an earlier route disappeared", () => w(join(f.dir, "routes-after-raw.json"), { Items: [...OLD_KEYS.slice(1), ...NEW_KEYS, "GET /v1/extra"].map((RouteKey) => ({ RouteKey })) }), "routes lost"],
    ["a staff route is missing and another was added", () => w(join(f.dir, "routes-after-raw.json"), { Items: [...OLD_KEYS, ...NEW_KEYS.slice(1), "GET /v1/other"].map((RouteKey) => ({ RouteKey })) }), "staff routes missing"],
    ["the sweep is disabled", () => undefined, "no ENABLED ComplianceSweep rule"],
  ])("API fails when %s (no marker)", (n, mutate, text) => {
    afterState(); (mutate as () => void)();
    const r = guard(["post", API], { env: n.includes("sweep") ? { MOCK_SWEEP_STATE: "DISABLED" } : {} });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(existsSync(join(f.before, "api-at-release.ok"))).toBe(false);
  });
  it("post refuses a stack that cannot be deployed", () => {
    afterState(); const r = guard(["post", WEB]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("can only be checked");
  });
});
