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
const BUILD = join(REPO, "docs/releases/2026-10-19-prd-readiness/release/build-package.sh");
const MOCKSRC = fileURLToPath(new URL("./prd-release-aws-mock.sh", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "prdrel-"));
const BIN = join(work, "bin"), MOCK = join(work, "mock"), PKGDIR = join(work, "pkg"), OUT = join(work, "before");
const ROOT = join(PKGDIR, "ogevia-prd-release-discovery");
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
  const b = spawnSync("bash", [BUILD, PKGDIR], { encoding: "utf8" });
  expect(b.status, b.stdout + b.stderr).toBe(0);
  handlerKey = /handler asset: (\S+)/.exec(b.stdout)![1]!;
  setLive(); setWeb(PRD_API);
});

describe("the package", () => {
  it("verifies its own manifest, bundles six release templates and pins the release Lambda assets", () => {
    const r = spawnSync("bash", ["-c", `cd ${ROOT} && sha256sum -c --quiet MANIFEST.sha256 && ls release-templates | wc -l && cat ASSETS.txt | wc -l`], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout.trim().split("\n")).toEqual(["6", "2"]);
    const info = JSON.parse(readFileSync(join(ROOT, "BUILD_INFO.json"), "utf8"));
    expect(info.release_handler_asset).toBe(handlerKey); expect(info.stage).toContain("discovery");
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
