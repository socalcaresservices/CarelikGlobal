// Production release package, stage A (discovery): p0 baseline capture and p1 diff report, run against a MOCKED aws (read verbs only) and the real release templates synthesized
// by the package build. No AWS contact; no database. Lives in the db suite only because the package build runs `cdk synth` (about 20 s).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
// This package describes the readiness release, so it is built from that release's commit (later work changes the production stacks).
const RELEASE_SOURCE = "fa3ca07";
const BUILD = join(REPO, "docs/releases/2026-10-19-prd-readiness/release/build-package.sh");
const MOCKSRC = fileURLToPath(new URL("./prd-release-aws-mock.sh", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "prdrel-"));
const BIN = join(work, "bin"), MOCK = join(work, "mock"), PKGDIR = join(work, "pkg"), OUT = join(work, "before");
const ROOT = join(PKGDIR, "ogevia-prd-release");
const STACKS = ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-WebHosting", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-Observability", "Ogevia-prod-NetworkEgress"];
const PRD_API = "zk527zk4ua";
let handlerKey = "";

function setLive(mutate?: (stack: string, t: Record<string, any>) => void) {
  for (const s of STACKS) {
    const t = JSON.parse(readFileSync(join(ROOT, "release-templates", `${s}.json`), "utf8"));
    mutate?.(s, t);
    writeFileSync(join(MOCK, "templates", `${s}.json`), JSON.stringify(t));
  }
}
function setWeb(apiHost: string, version?: string) {
  mkdirSync(join(MOCK, "web/assets"), { recursive: true });
  writeFileSync(join(MOCK, "web/index.html"), '<!doctype html><script type="module" src="/assets/index-abc123.js"></script>\n');
  writeFileSync(join(MOCK, "web/assets/index-abc123.js"), `const e={VITE_APP_ENV:"production"${version ? `,VITE_APP_VERSION:"${version}"` : ""},API:"https://${apiHost}.execute-api.us-west-2.amazonaws.com"};`);
}
async function run(script: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const e = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, MOCK_DIR: MOCK, HOME: work, OGEVIA_PRD_BEFORE: OUT, ...env };
    const p = spawn("bash", [join(ROOT, "scripts", script)], { env: e, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (c) => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } resolve({ code: c, out }); });
  });
}
const calls = () => (existsSync(join(MOCK, "aws-calls.log")) ? readFileSync(join(MOCK, "aws-calls.log"), "utf8") : "");

beforeAll(() => {
  mkdirSync(BIN, { recursive: true }); mkdirSync(join(MOCK, "templates"), { recursive: true });
  copyFileSync(MOCKSRC, join(BIN, "aws")); chmodSync(join(BIN, "aws"), 0o755);
  writeFileSync(join(MOCK, "code.zip"), "PK mock lambda zip bytes");
  writeFileSync(join(MOCK, "endpoint-policy.json"), JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: ["arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2/*", "arn:aws:s3:::ogevia-prd-signature-evidence-300094796789-us-west-2/*"] }] }));
  const b = spawnSync("bash", [BUILD, PKGDIR], { encoding: "utf8", env: { ...process.env, OGEVIA_RELEASE_SOURCE_COMMIT: RELEASE_SOURCE } });
  expect(b.status, b.stdout + b.stderr).toBe(0);
  handlerKey = /handler asset: (\S+)/.exec(b.stdout)![1]!;
  setLive(); setWeb(PRD_API);
});

describe("the package", () => {
  it("verifies its own manifest, bundles six release templates and pins the release Lambda assets", () => {
    const r = spawnSync("bash", ["-c", `cd ${ROOT} && sha256sum -c --quiet MANIFEST.sha256 && ls release-templates | wc -l && cat ASSETS.txt | wc -l`], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout.trim().split("\n")).toEqual(["6", "2"]);
    const info = JSON.parse(readFileSync(join(ROOT, "BUILD_INFO.json"), "utf8"));
    expect(info.release_handler_asset).toBe(handlerKey); expect(info.stage).toContain("A+B");
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(handlerKey);
  });
});

describe("p0 baseline capture", () => {
  it("captures a production-shaped environment, reports the facts and uses only read verbs", async () => {
    const r = await run("p0-baseline-capture.sh");
    expect(r.code, r.out).toBe(0);
    for (const t of ["the Lambda serves ogevia_prd with OGEVIA_ENV=prd", "equals the live CodeSha256", "the quick API rollback works", "routes on the production API: 228", "version string: NONE", "the production web references the production API host", "the endpoint policy admits the production evidence bucket", "RDS available, private, encrypted", "BASELINE CAPTURED"]) expect(r.out).toContain(t);
    expect(r.out).not.toContain("FAIL");
    for (const s of STACKS) expect(existsSync(join(OUT, "live", `${s}.json`))).toBe(true);
    for (const f of ["lambda-code-before.zip", "web-before/index.html", "previous-api-asset.txt", "stacks.txt", "endpoint-policy-before.json", "snapshots-before.txt"]) expect(existsSync(join(OUT, f)), f).toBe(true);
    const verbs = calls().split("\n").filter(Boolean).map((l) => l.split(" ").slice(0, 2).join(" "));
    for (const v of new Set(verbs)) expect(v, `unexpected verb ${v}`).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda (get-function-configuration|get-function)|s3api (head-object|list-buckets|get-bucket-versioning|get-public-access-block)|apigatewayv2 get-routes|events list-rules|s3 sync|ec2 describe-vpc-endpoints|rds describe-(db-instances|db-snapshots)|cognito-idp (list-user-pools|describe-user-pool)|secretsmanager describe-secret)$/);
    expect(calls()).not.toContain("get-secret-value"); expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
  });
  it("keeps environment variable VALUES out of its records except DB_NAME and OGEVIA_ENV", () => {
    const c = readFileSync(join(OUT, "lambda-config-before.json"), "utf8");
    expect(c).toContain("SOME_SECRET_ARN"); expect(c).not.toContain("arn:aws:secretsmanager"); expect(c).toContain('"DB_NAME": "ogevia_prd"');
  });
  it("stops on a Lambda that serves another database, a code zip that does not match, a missing previous asset, an unsettled stack and a web that calls another API", async () => {
    const a = await run("p0-baseline-capture.sh", { MOCK_LAMBDA_DB: "ogevia_sv_test", MOCK_LAMBDA_ENV: "test" }); expect(a.code).toBe(1); expect(a.out).toContain("not production");
    const b = await run("p0-baseline-capture.sh", { MOCK_ZIP_MISMATCH: "1" }); expect(b.code).toBe(1); expect(b.out).toContain("differs from CodeSha256");
    const c = await run("p0-baseline-capture.sh", { MOCK_NO_ASSET: "1" }); expect(c.code).toBe(1); expect(c.out).toContain("only the downloaded zip is a recovery copy");
    const d = await run("p0-baseline-capture.sh", { MOCK_STACK_STATUS: "UPDATE_ROLLBACK_COMPLETE" }); expect(d.code).toBe(1); expect(d.out).toContain("not a settled status");
    setWeb("s0epy5rgzb");
    const e = await run("p0-baseline-capture.sh"); expect(e.code).toBe(1); expect(e.out).toContain("does NOT reference the production API host");
    setWeb(PRD_API, "e80b770210c54e423d28ecf48e00f1dda9506cec");
    const f = await run("p0-baseline-capture.sh"); expect(f.code, f.out).toBe(0); expect(f.out).toContain('VITE_APP_VERSION:"e80b770210c54e423d28ecf48e00f1dda9506cec"');
    setWeb(PRD_API);
  });
});

describe("p1 diff report", () => {
  it("reports no difference when the live templates equal the release templates", async () => {
    setLive(); await run("p0-baseline-capture.sh");
    const r = await run("p1-diff-report.sh");
    expect(r.code, r.out).toBe(0); expect((r.out.match(/equals the release template/g) ?? []).length).toBe(6); expect(r.out).toContain("difference lines in total: 0");
  });
  it("ignores the approval tag value, CDK metadata and resource metadata", async () => {
    setLive((_s, t) => { t.Resources["CDKMetadata"] = { Type: "AWS::CDK::Metadata", Properties: { Analytics: "v2:deflate64:x" } }; for (const v of Object.values<any>(t.Resources)) { v.Metadata = { "aws:cdk:path": "other" }; const tg = v.Properties?.Tags; if (Array.isArray(tg)) { for (const tag of tg) if (tag.Key === "ogevia:deployment-status") tag.Value = "approved-something-else"; } else if (tg && typeof tg === "object" && "ogevia:deployment-status" in tg) tg["ogevia:deployment-status"] = "approved-something-else"; } });
    await run("p0-baseline-capture.sh"); const r = await run("p1-diff-report.sh");
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("difference lines in total: 0");
  });
  it("lists a changed Lambda code asset, a removed resource and a changed property, with counts, and exits 0 (it is a report)", async () => {
    setLive((s, t) => {
      if (s === "Ogevia-prd-ServiceVerificationApi") t.Resources.Handler886CB40B.Properties.Code.S3Key = "0000old.zip";
      if (s === "Ogevia-prd-Observability") { const k = Object.keys(t.Resources)[0]!; delete t.Resources[k]; }
      if (s === "Ogevia-prd-WebHosting") { const d = Object.values<any>(t.Resources).find((r) => r.Type === "AWS::CloudFront::Distribution"); d.Properties.DistributionConfig.Comment = "an older comment"; }
    });
    await run("p0-baseline-capture.sh"); const r = await run("p1-diff-report.sh");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/CHANGED Handler886CB40B \(AWS::Lambda::Function\) Properties\.Code\.S3Key: 0000old\.zip -> /);
    expect(r.out).toMatch(/RESOURCE-ADDED /); expect(r.out).toContain("SUMMARY resources:");
    expect(r.out).toMatch(/Ogevia-prd-ServiceVerificationApi: SUMMARY resources: live \d+, new \d+; added 0; removed 0; changed properties 1/);
    expect(r.out).not.toContain("difference lines in total: 0");
    const full = readFileSync(join(OUT, "diff-Ogevia-prd-ServiceVerificationApi.txt"), "utf8"); expect(full).toContain(handlerKey);
  });
  it("fails when a live template is missing, and tpl_diff rejects unreadable input", async () => {
    spawnSync("rm", ["-f", join(OUT, "live", "Ogevia-prd-Observability.json")]);
    const r = await run("p1-diff-report.sh"); expect(r.code).toBe(1); expect(r.out).toContain("no captured live template for Ogevia-prd-Observability");
    const t = spawnSync("python3", ["-I", "-B", join(ROOT, "scripts/tpl_diff.py"), "/nonexistent", "/nonexistent"], { encoding: "utf8" }); expect(t.status).toBe(2);
  });
});

// ---------------------------------------------------------------- stage B ---------------------------------------------------------------
const API = "Ogevia-prd-ServiceVerificationApi";
const LIVE_HK = "4832b6ba4f8ff1b8706697326b0d76d3d96d5031265c0d6024ee10c1e194817c.zip";
const LIVE_IK = "e345075a65c98ef8fae929be46fb48be5c3c268702af0f409df509fb3634791b.zip";
/** The production API template as the baseline described it (66 JWT routes, the ComplianceSweep pair, both IAM statements, both older assets and descriptions missing), derived from the release template. */
function modelLive(mutate?: (r: Record<string, any>) => void): Record<string, any> {
  const t = JSON.parse(readFileSync(join(ROOT, "release-templates", `${API}.json`), "utf8")); const R = t.Resources;
  const jwt = Object.keys(R).filter((k) => R[k].Type === "AWS::ApiGatewayV2::Route" && R[k].Properties.AuthorizationType === "JWT").sort();
  let seed = 7; const pick = new Set<string>(); while (pick.size < 66) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pick.add(jwt[seed % jwt.length]!); }
  for (const k of pick) delete R[k];
  delete R.ComplianceSweep51D1109D; for (const k of Object.keys(R)) if (k.startsWith("ComplianceSweepAllow")) delete R[k];
  R.Handler886CB40B.Properties.Code.S3Key = LIVE_HK; R.IdentityHandler6F0A3417.Properties.Code.S3Key = LIVE_IK;
  R.IdentityHandler6F0A3417.Properties.Description = "Ogevia caregiver invitations: Cognito AdminCreateUser/AdminGetUser only";
  R.IdentityRole07BDF020.Properties.Description = "Ogevia caregiver invitation identity function (Cognito create/resend only)";
  for (const [pol, sid] of [["HandlerPolicy7544C855", "ClientDocumentObjects"], ["IdentityPolicyF3EE534F", "SwitchSignInsOnOff"]] as const) { const d = R[pol].Properties.PolicyDocument; d.Statement = d.Statement.filter((x: any) => x.Sid !== sid); }
  mutate?.(R); return t;
}
const setProductionState = (mut?: (s: string, t: Record<string, any>) => void) => setLive((s, t) => { if (s === API) { const m = modelLive(); t.Resources = m.Resources; } mut?.(s, t); });
function gate(live: Record<string, any>, newMut?: (r: Record<string, any>) => void, extra: string[] = []) {
  const lp = join(work, "gate-live.json"), np = join(work, "gate-new.json");
  const nw = JSON.parse(readFileSync(join(ROOT, "release-templates", `${API}.json`), "utf8")); newMut?.(nw.Resources);
  writeFileSync(lp, JSON.stringify(live)); writeFileSync(np, JSON.stringify(nw));
  const r = spawnSync("python3", ["-I", "-B", join(ROOT, "scripts/prd_gate.py"), "--live", lp, "--new", np, ...extra], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("stage B: the expected-only gate (prd_gate.py)", () => {
  it("passes the production state the baseline described, and reports the counts", () => {
    const r = gate(modelLive()); expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("live 176, release 244; added 68 (66 routes, 2 other); removed 0; changed 5"); expect(r.out).toContain("EXPECTED-ONLY: YES");
  });
  it.each([
    ["a resource other than the five changed", (R: any) => { const k = Object.keys(R).find((x) => R[x].Type === "AWS::ApiGatewayV2::Stage")!; R[k].Properties.AutoDeploy = !R[k].Properties.AutoDeploy; }, "CHANGED and is not on the allow-list"],
    ["a live Lambda asset that is not the pinned one", (R: any) => { R.Handler886CB40B.Properties.Code.S3Key = "someone-deployed-this.zip"; }, "the LIVE code asset key is someone-deployed-this.zip"],
    ["a changed Lambda environment", (R: any) => { R.Handler886CB40B.Properties.Environment = { Variables: { DB_NAME: "ogevia_sv_test" } }; }, "something other than Properties.Code.S3Key differs"],
    ["a removed resource (live has one the release lacks)", (R: any) => { R.ExtraLiveResource = { Type: "AWS::SQS::Queue", Properties: {} }; }, "resources REMOVED"],
    ["production already identical on a changed resource", (R: any) => { const n = JSON.parse(readFileSync(join(ROOT, "release-templates", `${API}.json`), "utf8")); R.IdentityRole07BDF020 = n.Resources.IdentityRole07BDF020; }, "expected to change but is identical"],
  ])("refuses %s", (_n, mut, text) => { const r = gate(modelLive(mut as any)); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).toContain("EXPECTED-ONLY: NO"); });
  it.each([
    ["an IAM statement wider than ClientDocumentObjects", (R: any) => { R.HandlerPolicy7544C855.Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "ClientDocumentObjects").Resource = "arn:aws:s3:::ogevia-prd-signature-evidence-300094796789-us-west-2/*"; }, "added statement ClientDocumentObjects is not exactly the expected one"],
    ["an extra added IAM statement", (R: any) => { R.HandlerPolicy7544C855.Properties.PolicyDocument.Statement.push({ Sid: "Surprise", Effect: "Allow", Action: "s3:*", Resource: "*" }); }, "the statements added are"],
    ["a widened identity permission", (R: any) => { R.IdentityPolicyF3EE534F.Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "SwitchSignInsOnOff").Action.push("cognito-idp:AdminDeleteUser"); }, "added statement SwitchSignInsOnOff is not exactly the expected one"],
    ["a changed existing IAM statement", (R: any) => { R.HandlerPolicy7544C855.Properties.PolicyDocument.Statement.find((x: any) => x.Sid === "SignatureObjects").Action.push("s3:DeleteObject"); }, "statement SignatureObjects CHANGED"],
    ["a disabled ComplianceSweep rule", (R: any) => { R.ComplianceSweep51D1109D.Properties.State = "DISABLED"; }, "ComplianceSweep rule is not rate(15 minutes), ENABLED"],
    ["a route short of the pinned count", (R: any) => { const k = Object.keys(R).find((x) => R[x].Type === "AWS::ApiGatewayV2::Route" && R[x].Properties.AuthorizationType === "JWT" && !(x in modelLive().Resources))!; delete R[k]; }, "routes added, expected exactly 66"],
  ])("refuses (release side) %s", (_n, mut, text) => {
    const r = gate(modelLive(), mut as any); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text);
  });
  it("refuses a new public route unless it is named, and a new route with a missing authorizer or an unknown integration", () => {
    const r = gate(modelLive(), (R) => { const k = Object.keys(R).find((x) => R[x].Type === "AWS::ApiGatewayV2::Route" && R[x].Properties.AuthorizationType === "JWT" && !(x in modelLive().Resources))!; R[k].Properties.AuthorizationType = "NONE"; delete R[k].Properties.AuthorizerId; });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("WITHOUT authorization");
    const key = /route (.+?) is added WITHOUT/.exec(r.out)![1]!;
    const ok = gate(modelLive(), (R) => { const k = Object.keys(R).find((x) => R[x].Type === "AWS::ApiGatewayV2::Route" && R[x].Properties.RouteKey === key)!; R[k].Properties.AuthorizationType = "NONE"; delete R[k].Properties.AuthorizerId; }, ["--allow-public-route", key]);
    expect(ok.code, ok.out).toBe(0);
    const noAuth = gate(modelLive(), (R) => { const k = Object.keys(R).find((x) => R[x].Type === "AWS::ApiGatewayV2::Route" && R[x].Properties.AuthorizationType === "JWT" && !(x in modelLive().Resources))!; R[k].Properties.AuthorizerId = { Ref: "NoSuchAuthorizer" }; });
    expect(noAuth.code, noAuth.out).toBe(1); expect(noAuth.out).toContain("not an existing live authorizer");
    const noInt = gate(modelLive(), (R) => { const k = Object.keys(R).find((x) => R[x].Type === "AWS::ApiGatewayV2::Route" && R[x].Properties.AuthorizationType === "JWT" && !(x in modelLive().Resources))!; R[k].Properties.Target = { "Fn::Join": ["", ["integrations/", { Ref: "NoSuchIntegration" }]] }; });
    expect(noInt.code, noInt.out).toBe(1); expect(noInt.out).toContain("not an integration that already exists live");
  });
  it("exits 2 on unreadable input", () => { const r = spawnSync("python3", ["-I", "-B", join(ROOT, "scripts/prd_gate.py"), "--live", "/nonexistent", "--new", "/nonexistent"], { encoding: "utf8" }); expect(r.status).toBe(2); });
});

describe("stage B: p2-gate.sh (fresh re-read, other stacks equal, API gate) with the mock", () => {
  it("passes when production is the baseline state and the other five stacks equal the release", async () => {
    setProductionState(); await run("p0-baseline-capture.sh"); const r = await run("p2-gate.sh");
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("GATE PASSED"); expect(r.out).toContain("EXPECTED-ONLY: YES"); expect((r.out.match(/is unchanged since the p0 baseline/g) ?? []).length).toBe(6);
  });
  it("stops when production changes after the baseline, when another stack differs from the release, and when the API stack is not the baseline state", async () => {
    setProductionState(); await run("p0-baseline-capture.sh");
    setProductionState((s, t) => { if (s === "Ogevia-prd-WebHosting") t.Description = "changed after the baseline"; });
    const a = await run("p2-gate.sh"); expect(a.code).toBe(1); expect(a.out).toContain("CHANGED since the p0 baseline");
    setProductionState((s, t) => { if (s === "Ogevia-prd-Observability") t.Description = "differs from the release"; }); await run("p0-baseline-capture.sh");
    const b = await run("p2-gate.sh"); expect(b.code).toBe(1); expect(b.out).toContain("Ogevia-prd-Observability differs from the release template");
    setLive(); await run("p0-baseline-capture.sh");
    const c = await run("p2-gate.sh"); expect(c.code).toBe(1); expect(c.out).toContain("expected to change but is identical");
    setProductionState((s, t) => { if (s === API) t.Resources.Handler886CB40B.Properties.Code.S3Key = "other.zip"; }); await run("p0-baseline-capture.sh");
    const d = await run("p2-gate.sh"); expect(d.code).toBe(1); expect(d.out).toContain("the LIVE code asset key is other.zip");
  });
});

describe("stage B: the deploy guard", () => {
  const fakeCdk = join(work, "cdk"); const cdkLog = join(work, "cdk-args.log");
  const asm = join(work, "assembly");
  const deployEnv = (extra: Record<string, string> = {}) => ({ OGEVIA_DEPLOY_APPROVAL: "owner-go-20261021-01", OGEVIA_PRD_ASSEMBLY: asm, OGEVIA_CDK_BIN: fakeCdk, OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-prdrelease-202610210100", ...extra });
  const guard = async (args: string[], env: Record<string, string> = {}, input = "") => new Promise<{ code: number | null; out: string }>((resolve) => {
    const e = { ...process.env, PATH: `${BIN}:${process.env.PATH}`, MOCK_DIR: MOCK, HOME: work, OGEVIA_PRD_BEFORE: OUT, ...env };
    const p = spawn("bash", [join(ROOT, "scripts/deploy-guard-prd.sh"), ...args], { env: e, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } resolve({ code: c, out }); });
  });
  beforeAll(() => {
    writeFileSync(fakeCdk, `#!/usr/bin/env bash\nif [[ "$1" == --version ]]; then echo "2.1143.0 (build x)"; exit 0; fi\necho "$*" >> ${cdkLog}\nexit \${FAKE_CDK_RC:-0}\n`); chmodSync(fakeCdk, 0o755);
    mkdirSync(asm, { recursive: true });
    for (const s of ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-WebHosting", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-Observability"]) copyFileSync(join(ROOT, "release-templates", `${s}.json`), join(asm, `${s}.template.json`));
    for (const h of ["eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda", "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759"]) mkdirSync(join(asm, `asset.${h}`), { recursive: true });
    writeFileSync(join(asm, "manifest.json"), "{}");
    setLive((s, t) => { if (s === API) t.Resources = modelLive().Resources; }); 
  });
  it("accepts only the API stack, in all three modes", async () => {
    for (const bad of ["Ogevia-prd-WebHosting", "Ogevia-prod-NetworkEgress", "Ogevia-prod-ServiceVerificationApi", "Ogevia-prd-*", "--all"]) for (const mode of ["check", "deploy", "post"]) { const r = await guard([mode, bad], deployEnv()); expect(r.code, `${mode} ${bad}: ${r.out}`).toBe(1); expect(r.out).toContain("REFUSED"); }
    expect((await guard(["deploy"])).code).toBe(2); expect((await guard(["nonsense", API])).code).toBe(2);
  });
  it("check passes on the baseline state (with and without an assembly) and fails on an assembly that is not the release", async () => {
    await run("p0-baseline-capture.sh");
    const a = await guard(["check", API]); expect(a.code, a.out).toBe(0); expect(a.out).toContain("CHECK PASSED"); expect(a.out).toContain("no assembly given");
    const b = await guard(["check", API], { OGEVIA_PRD_ASSEMBLY: asm }); expect(b.code, b.out).toBe(0); expect(b.out).toContain("ASSEMBLY OK");
    writeFileSync(join(asm, "Ogevia-prod-Extra.template.json"), "{}"); const c = await guard(["check", API], { OGEVIA_PRD_ASSEMBLY: asm }); expect(c.code).toBe(1); expect(c.out).toContain("the assembly holds"); spawnSync("rm", ["-f", join(asm, "Ogevia-prod-Extra.template.json")]);
    spawnSync("mv", [join(asm, `asset.eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda`), join(work, "moved-asset")]); const d = await guard(["check", API], { OGEVIA_PRD_ASSEMBLY: asm }); expect(d.code).toBe(1); expect(d.out).toContain("is missing"); spawnSync("mv", [join(work, "moved-asset"), join(asm, `asset.eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda`)]);
    const t = JSON.parse(readFileSync(join(asm, `${API}.template.json`), "utf8")); t.Resources.ExtraBucket = { Type: "AWS::S3::Bucket", Properties: {} }; const orig = readFileSync(join(asm, `${API}.template.json`), "utf8"); writeFileSync(join(asm, `${API}.template.json`), JSON.stringify(t));
    const e = await guard(["check", API], { OGEVIA_PRD_ASSEMBLY: asm }); expect(e.code).toBe(1); expect(e.out).toContain("differs from the approved release template"); writeFileSync(join(asm, `${API}.template.json`), orig);
  });
  it("deploy refuses without each prerequisite and runs nothing", async () => {
    writeFileSync(join(OUT, "db-at-0085.ok"), "85|0085\n");
    for (const [env, text] of [[{ OGEVIA_DEPLOY_APPROVAL: "x" }, "approval reference"], [{ OGEVIA_PRD_ASSEMBLY: "" }, "OGEVIA_PRD_ASSEMBLY"], [{ OGEVIA_CDK_BIN: "" }, "OGEVIA_CDK_BIN"], [{ OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0085-202610192111" }, "named ogevia-prod-postgres-pre-prdrelease"], [{ MOCK_SNAP_AGE: "90000" }, "old (limit"], [{ MOCK_SNAP_ENC: "false" }, "not available, manual, encrypted"]] as const) {
      const r = await guard(["deploy", API], deployEnv(env as any), `DEPLOY-${API}\n`); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text);
    }
    writeFileSync(join(OUT, "db-at-0085.ok"), "46|0046\n"); const m = await guard(["deploy", API], deployEnv(), `DEPLOY-${API}\n`); expect(m.code).toBe(1); expect(m.out).toContain("migrated to 0085 BEFORE the API");
    writeFileSync(join(OUT, "db-at-0085.ok"), "85|0085\n");
    writeFileSync(fakeCdk + "2", `#!/usr/bin/env bash\necho "2.1000.0"\n`); chmodSync(fakeCdk + "2", 0o755); const v = await guard(["deploy", API], deployEnv({ OGEVIA_CDK_BIN: fakeCdk + "2" }), `DEPLOY-${API}\n`); expect(v.code).toBe(1); expect(v.out).toContain("not version 2.1143.0");
    expect(existsSync(cdkLog)).toBe(false);
  });
  it("deploy needs the typed phrase, then runs exactly one cdk deploy for the one stack", async () => {
    const no = await guard(["deploy", API], deployEnv(), "no\n"); expect(no.code, no.out).toBe(0); expect(no.out).toContain("Declined"); expect(existsSync(cdkLog)).toBe(false);
    const r = await guard(["deploy", API], deployEnv(), `DEPLOY-${API}\n`); expect(r.code, r.out).toBe(0); expect(r.out).toContain("ABOUT TO RUN"); expect(r.out).toContain("approve ONLY if it lists exactly");
    expect(readFileSync(cdkLog, "utf8").trim()).toBe(`deploy --app ${asm} --exclusively ${API} --require-approval broadening --no-notices`);
    const f = await guard(["deploy", API], deployEnv({ FAKE_CDK_RC: "1" }), `DEPLOY-${API}\n`); expect(f.code).toBe(1); expect(f.out).toContain("cdk deploy exited 1");
  });
  it("post passes when the live template equals the release and the runtime checks hold, and fails otherwise", async () => {
    setLive(); writeFileSync(join(MOCK, "code.zip"), "PK new lambda zip bytes");
    const ok = await guard(["post", API]); expect(ok.code, ok.out).toBe(0); expect(ok.out).toContain("POST-CHECK PASSED"); expect(ok.out).toContain("the API has 228 routes"); expect(ok.out).toContain("ComplianceSweep rule exists and is ENABLED");
    const r1 = await guard(["post", API], { MOCK_ROUTES: "200" }); expect(r1.code).toBe(1); expect(r1.out).toContain("expected 228");
    const r2 = await guard(["post", API], { MOCK_RULE_STATE: "DISABLED" }); expect(r2.code).toBe(1);
    const r3 = await guard(["post", API], { MOCK_LAMBDA_DB: "ogevia_sv_test" }); expect(r3.code).toBe(1); expect(r3.out).toContain("DB_NAME/OGEVIA_ENV changed");
    writeFileSync(join(MOCK, "code.zip"), "PK mock lambda zip bytes"); const r4 = await guard(["post", API]); expect(r4.code).toBe(1); expect(r4.out).toContain("did not change");
    setProductionState();
  });
  it("never calls anything outside read verbs, snapshot reads and the CDK it was handed", () => {
    expect(calls()).not.toMatch(/(create|delete|modify|update|put|authorize|revoke|restore)-/); expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
  });
});
