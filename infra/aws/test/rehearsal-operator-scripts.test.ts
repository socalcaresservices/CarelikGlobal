// baseline-capture.sh, snapshot-verify.sh, web-verify.sh, record-deployed.sh and the operator procedure document itself (TEST rehearsal, release 0b593e5).
// Fake aws and curl; real release/baseline templates; no AWS, no network, synthetic.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURES, PKG_REL, REPO_ROOT, SCRIPTS_SRC, sh } from "./rehearsal-fixtures.js";

vi.setConfig({ testTimeout: 60000 });
const NET = "Ogevia-prod-NetworkEgress", API = "Ogevia-prod-ServiceVerificationApi";
const SHA = "0b593e5ccd79fc69fb4d35efb5160fc6195de1f9";
const RELEASE_KEY = "6f37bc5510d14ec7db6c3630712e06dc89613dac2d595ff01fa687760c2a3c1f.zip";
type T = any;
const fx = (kind: string, stack: string): T => JSON.parse(readFileSync(join(FIXTURES, kind, `${stack}.template.json`), "utf8"));
const epOf = (t: T) => Object.values<any>(t.Resources).find((r) => r.Type === "AWS::EC2::VPCEndpoint" && r.Properties.VpcEndpointType === "Gateway");
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const minutes = (m: number) => new Date(Date.now() + m * 60000);

const AWS = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
stack=$(grep -o 'Ogevia-pr[a-z]*-[A-Za-z]*' <<<"$*" | head -1)
case "$1 $2" in
  "sts get-caller-identity") echo "{\\"Account\\":\\"\${MOCK_ACCOUNT:-300094796789}\\",\\"Arn\\":\\"arn:aws:sts::300094796789:assumed-role/Admin/op\\"}" ;;
  "cloudformation describe-stacks")
    if [[ "$*" == *"--output json"* ]]; then
      case "$stack" in
        Ogevia-prod-WebHosting) o='[{"OutputKey":"WebOrigin","OutputValue":"https://d2xumch5w0izfg.cloudfront.net"},{"OutputKey":"SiteBucketName","OutputValue":"site-bucket"},{"OutputKey":"DistributionId","OutputValue":"E123"}]' ;;
        Ogevia-prod-ServiceVerificationApi) o='[{"OutputKey":"ApiUrl","OutputValue":"https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com"}]' ;;
        *) o='[]' ;;
      esac
      echo "{\\"Stacks\\":[{\\"StackStatus\\":\\"\${MOCK_STACK_STATUS:-UPDATE_COMPLETE}\\",\\"Outputs\\":$o}]}"
    else echo "\${MOCK_STACK_STATUS:-UPDATE_COMPLETE}"; fi ;;
  "cloudformation get-template") cat "$D/\${MOCK_TEMPLATE_DIR:-live}/$stack.json" ;;
  "cloudformation list-stack-resources") if [[ "$*" == *VPCEndpoint* ]]; then echo vpce-0abc123; else echo fn-handler; fi ;;
  "lambda get-function-configuration") cat "$D/lambda-config.json" ;;
  "lambda get-function") echo "https://example.invalid/code.zip" ;;
  "ec2 describe-vpc-endpoints") cat "$D/ep-policy.json" ;;
  "rds describe-db-instances") printf '%s\\t%s\\t%s\\tpostgres\\t16.4\\tdb.t4g.small\\tFalse\\t7\\n' "\${MOCK_RDS_STATUS:-available}" "\${MOCK_RDS_PUBLIC:-False}" "\${MOCK_RDS_ENC:-True}" ;;
  "s3api head-object") [[ -n "\${MOCK_NO_ASSET:-}" ]] && { echo "404" >&2; exit 254; }; echo 123456 ;;
  "s3 sync") cp -r "$D/site/." "$4" ;;
  "events list-rules") printf 'ComplianceSweepAB12\\t%s\\n' "\${MOCK_SWEEP_STATE:-ENABLED}" ;;
  "rds create-db-snapshot") echo creating ;;
  "rds wait") exit 0 ;;
  "rds describe-db-snapshots")
    created=$(date -u -d "@$(( $(date +%s) - \${MOCK_SNAP_AGE_MIN:-10} * 60 ))" +%Y-%m-%dT%H:%M:%S.123000+00:00)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${MOCK_SNAP_STATUS:-available}" "\${MOCK_SNAP_INSTANCE:-ogevia-prod-postgres}" "\${MOCK_SNAP_TYPE:-manual}" "\${MOCK_SNAP_CREATED:-$created}" "\${MOCK_SNAP_ENC:-True}" ;;
  *) echo "mock aws: unexpected call: $*" >&2; echo "UNEXPECTED $*" >> "$D/aws-calls.log"; exit 99 ;;
esac
`;
const CURL = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/curl-calls.log"
out=""; url=""; while [[ $# -gt 0 ]]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
if [[ "$url" == *code.zip ]]; then cp "$D/code.zip" "$out"; exit 0; fi
case "$url" in
  */index.html) cat "$D/served-index.html" ;;
  */assets/*.js) cat "$D/served-main.js" ;;
  */config.json) cat "$D/served-config.json" ;;
  *) echo "mock curl: unexpected $url" >&2; exit 22 ;;
esac
`;

interface Fix { dir: string; bin: string; pkg: string; scripts: string; before: string; zip: Buffer }
let f: Fix;
function fixture(): Fix {
  const dir = mkdtempSync(join(tmpdir(), "opscripts-"));
  const pkg = join(dir, "pkg"), scripts = join(pkg, PKG_REL, "scripts");
  mkdirSync(scripts, { recursive: true }); cpSync(SCRIPTS_SRC, scripts, { recursive: true });
  mkdirSync(join(pkg, "apps/web/dist-aws/assets"), { recursive: true }); mkdirSync(join(pkg, "infra/aws"), { recursive: true });
  writeFileSync(join(pkg, "BUILD_INFO.json"), JSON.stringify({ code_commit: SHA, approval_ref: "APPROVAL-REF-PENDING-OWNER" }));
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "aws"), AWS); writeFileSync(join(bin, "curl"), CURL); chmodSync(join(bin, "aws"), 0o755); chmodSync(join(bin, "curl"), 0o755);
  // live = the baseline (what TEST runs today); the other three stacks are the same in baseline and release
  mkdirSync(join(dir, "live")); mkdirSync(join(dir, "after"));
  for (const s of ["EvidenceStorage", "NetworkEgress", "WebHosting", "ServiceVerificationApi", "Observability"]) {
    const kind = s === "NetworkEgress" || s === "ServiceVerificationApi" ? "baseline" : "release";
    writeFileSync(join(dir, "live", `Ogevia-prod-${s}.json`), JSON.stringify(fx(kind, `Ogevia-prod-${s}`)));
    writeFileSync(join(dir, "after", `Ogevia-prod-${s}.json`), JSON.stringify(fx("release", `Ogevia-prod-${s}`)));
  }
  const zip = Buffer.from("fake lambda zip");
  writeFileSync(join(dir, "code.zip"), zip);
  const b64 = createHash("sha256").update(zip).digest("base64");
  writeFileSync(join(dir, "lambda-config.json"), JSON.stringify({ CodeSha256: b64, LastUpdateStatus: "Successful", LastModified: "2026-10-19T04:00:00.000+0000", Environment: { Variables: { DB_NAME: "ogevia_sv_test", OGEVIA_ENV: "prod" } } }));
  writeFileSync(join(dir, "ep-policy.json"), JSON.stringify(epOf(fx("baseline", NET)).Properties.PolicyDocument));
  mkdirSync(join(dir, "site/assets"), { recursive: true });
  writeFileSync(join(dir, "site/index.html"), '<script src="/assets/index-OLD1.js"></script>'); writeFileSync(join(dir, "site/assets/index-OLD1.js"), "old"); writeFileSync(join(dir, "site/config.json"), '{"c":1}');
  writeFileSync(join(dir, "served-index.html"), '<script src="/assets/index-OLD1.js"></script>');
  const before = join(dir, "before");
  return { dir, bin, pkg, scripts, before, zip };
}
beforeEach(() => { f = fixture(); });
const env = (extra: Record<string, string> = {}) => ({ PATH: `${f.bin}:${process.env.PATH}`, MOCK_DIR: f.dir, OGEVIA_BEFORE: f.before, HOME: f.dir, ...extra });
const run = (script: string, args: string[] = [], e: Record<string, string> = {}) => sh("bash", [join(f.scripts, script), ...args], { env: env(e) });
const awsCalls = () => (existsSync(join(f.dir, "aws-calls.log")) ? readFileSync(join(f.dir, "aws-calls.log"), "utf8").split("\n").filter(Boolean) : []);

describe("baseline-capture.sh: read-only, and it stops unless TEST is exactly the recorded baseline", () => {
  it("captures everything recovery needs and passes", () => {
    const r = run("baseline-capture.sh");
    expect(r.code, r.out).toBe(0);
    for (const t of ["PASS account 300094796789", "TEST API url: https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com", "TEST web url: https://d2xumch5w0izfg.cloudfront.net", "PASS all checks", "live CodeSha256 (before):", "PASS the Lambda serves ogevia_sv_test", "PASS captured code zip hash equals the live CodeSha256", "previous API code asset", "endpoint vpce-0abc123 policy: 6 resources (3 for the TEST bucket, 3 for the PRODUCTION bucket)", "PASS RDS available, not publicly accessible, encrypted", "web files captured: 3", "PASS ComplianceSweep is ENABLED", "BASELINE CAPTURED"]) expect(r.out).toContain(t);
    for (const file of ["lambda-config-before.json", "lambda-code-before.zip", "endpoint-policy-before.json", "endpoint-id.txt", "handler-function-name.txt", "web-before/index.html", "web-before.sha256", "web-url-before.txt", "api-url-before.txt", "web-index-sha256-before.txt", "previous-api-asset.txt", `live/${NET}.json`, `live/${API}.json`]) expect(existsSync(join(f.before, file)), file).toBe(true);
  });
  it("calls only read verbs (describe, list, get, head, sync-from-bucket)", () => {
    run("baseline-capture.sh");
    for (const c of awsCalls()) expect(c, c).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda (get-function-configuration|get-function)|ec2 describe-vpc-endpoints|rds describe-db-instances|s3api head-object|s3 sync s3:\/\/site-bucket |events list-rules)/);
    expect(awsCalls().join("\n")).not.toMatch(/UNEXPECTED|put-|create-|delete-|modify-|update-|--delete/);
    const code = readFileSync(join(SCRIPTS_SRC, "baseline-capture.sh"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/Ogevia-prd|ogevia_prd/);
  });
  it.each([
    ["the wrong AWS account", { MOCK_ACCOUNT: "111111111111" }, "wrong AWS account"],
    ["a stack that is not settled", { MOCK_STACK_STATUS: "UPDATE_IN_PROGRESS" }, "not a settled status"],
    ["RDS that is not available", { MOCK_RDS_STATUS: "modifying" }, "RDS is not available / private / encrypted"],
    ["RDS that is publicly accessible", { MOCK_RDS_PUBLIC: "True" }, "RDS is not available / private / encrypted"],
    ["RDS that is not encrypted", { MOCK_RDS_ENC: "False" }, "RDS is not available / private / encrypted"],
    ["a previous API code asset that is gone", { MOCK_NO_ASSET: "1" }, "cannot be read"],
    ["ComplianceSweep not ENABLED", { MOCK_SWEEP_STATE: "DISABLED" }, "ComplianceSweep is not ENABLED"],
  ])("stops (exit 1) on %s", (_n, e, text) => {
    const r = run("baseline-capture.sh", [], e as Record<string, string>);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(text as string);
    expect(r.out).not.toContain("BASELINE CAPTURED");
  });
  it("stops when the live API stack is not the recorded baseline (for example, already the release)", () => {
    writeFileSync(join(f.dir, "live", `${API}.json`), JSON.stringify(fx("release", API)));
    const r = run("baseline-capture.sh"); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL LIVE Ogevia-prod-ServiceVerificationApi"); expect(r.out).toContain("the live stacks are not the recorded baseline");
  });
  it("stops when the Lambda serves another database, when the captured zip differs from CodeSha256, and when the endpoint policy lacks the production bucket", () => {
    const cfg = JSON.parse(readFileSync(join(f.dir, "lambda-config.json"), "utf8")); cfg.Environment.Variables = { DB_NAME: "ogevia_prd", OGEVIA_ENV: "prd" };
    writeFileSync(join(f.dir, "lambda-config.json"), JSON.stringify(cfg));
    let r = run("baseline-capture.sh"); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not TEST");
    f = fixture(); writeFileSync(join(f.dir, "code.zip"), "different bytes");
    r = run("baseline-capture.sh"); expect(r.code, r.out).toBe(1); expect(r.out).toContain("differs from CodeSha256");
    f = fixture(); const pol = epOf(fx("baseline", NET)).Properties.PolicyDocument; pol.Statement[0].Resource = pol.Statement[0].Resource.filter((x: string) => !x.includes("ogevia-prd-"));
    writeFileSync(join(f.dir, "ep-policy.json"), JSON.stringify(pol));
    r = run("baseline-capture.sh"); expect(r.code, r.out).toBe(1); expect(r.out).toContain("does not list both buckets");
  });
  it("without credentials it stops at once", () => {
    writeFileSync(join(f.bin, "aws"), "#!/usr/bin/env bash\nexit 255\n");
    const r = run("baseline-capture.sh"); expect(r.code, r.out).toBe(1); expect(r.out).toContain("no valid AWS credentials");
  });
});

describe("snapshot-verify.sh: a snapshot that is not verified stops the rehearsal", () => {
  const win = (start = -60, end = 180) => ({ OGEVIA_RELEASE_WINDOW_START: iso(minutes(start)), OGEVIA_RELEASE_WINDOW_END: iso(minutes(end)) });
  const id = (ago = 0) => `ogevia-prod-postgres-pre-0084-${stamp(minutes(-ago))}`;
  it("create: takes the snapshot, waits, verifies it (available, manual, ogevia-prod-postgres, encrypted, inside the window) and records the id", () => {
    const r = run("snapshot-verify.sh", ["create"], win());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/creating ogevia-prod-postgres-pre-0084-\d{12}/);
    expect(r.out).toContain("status=available instance=ogevia-prod-postgres type=manual");
    expect(r.out).toContain("encrypted=True");
    expect(r.out).toContain("SNAPSHOT VERIFIED");
    expect(readFileSync(join(f.before, "snapshot-id.txt"), "utf8").trim()).toMatch(/^ogevia-prod-postgres-pre-0084-\d{12}$/);
    expect(awsCalls().filter((c) => c.startsWith("rds create-db-snapshot"))).toHaveLength(1);
    expect(awsCalls().join("\n")).not.toMatch(/UNEXPECTED|restore-db|delete-db|copy-db/);
  });
  it.each([
    ["a snapshot still creating", { MOCK_SNAP_STATUS: "creating" }, "not available"],
    ["a failed snapshot", { MOCK_SNAP_STATUS: "failed" }, "not available"],
    ["a snapshot of another instance", { MOCK_SNAP_INSTANCE: "other-db" }, "belongs to 'other-db'"],
    ["an automated snapshot", { MOCK_SNAP_TYPE: "automated" }, "not manual"],
    ["an unencrypted snapshot", { MOCK_SNAP_ENC: "False" }, "not encrypted"],
    ["a snapshot created before the window", { MOCK_SNAP_AGE_MIN: "400" }, "outside the release window"],
    ["an unreadable creation time", { MOCK_SNAP_CREATED: "None" }, "no readable creation time"],
  ])("verify: stops on %s", (_n, e, text) => {
    writeFileSync(join(f.dir, "id"), "");
    const r = run("snapshot-verify.sh", ["verify"], { ...win(), OGEVIA_PREDEPLOY_SNAPSHOT_ID: id(10), ...(e as Record<string, string>) });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(text as string);
    expect(r.out).not.toContain("SNAPSHOT VERIFIED");
  });
  it("verify: passes for a good snapshot, reading the id from the recorded file", () => {
    mkdirSync(f.before); writeFileSync(join(f.before, "snapshot-id.txt"), id(10) + "\n");
    const r = run("snapshot-verify.sh", ["verify"], win());
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("SNAPSHOT VERIFIED");
    expect(awsCalls().filter((c) => c.startsWith("rds create-db-snapshot"))).toEqual([]);
  });
  it.each([
    ["no window", { OGEVIA_RELEASE_WINDOW_START: "", OGEVIA_RELEASE_WINDOW_END: "" }, "OGEVIA_RELEASE_WINDOW_START"],
    ["a window longer than 12 hours", win(-60, 800), "at most 12 hours"],
    ["a wrongly named snapshot", { ...win(), OGEVIA_PREDEPLOY_SNAPSHOT_ID: "my-snapshot" }, "does not match"],
    ["the old 0077 naming", { ...win(), OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0077-202610190312" }, "does not match"],
  ])("verify: refuses %s", (_n, e, text) => {
    const r = run("snapshot-verify.sh", ["verify"], e as Record<string, string>); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text as string);
  });
  it("create: refuses outside the window and creates nothing; a snapshot that never becomes verified stops", () => {
    const r = run("snapshot-verify.sh", ["create"], win(-300, -60)); expect(r.code, r.out).toBe(1); expect(r.out).toContain("outside the release window");
    expect(awsCalls().filter((c) => c.startsWith("rds create-db-snapshot"))).toEqual([]);
    f = fixture(); const r2 = run("snapshot-verify.sh", ["create"], { ...win(), MOCK_SNAP_STATUS: "failed" }); expect(r2.code, r2.out).toBe(1);
    expect(run("snapshot-verify.sh", ["bogus"]).code).toBe(2);
  });
});

describe("web-verify.sh: what TEST serves must be the build, with the code SHA as version", () => {
  const serve = (o: { version?: string; env?: string; index?: string; config?: string; noAsset?: boolean } = {}) => {
    const idx = o.noAsset ? "<html></html>" : '<script type="module" src="/assets/index-AbC123.js"></script>';
    writeFileSync(join(f.pkg, "apps/web/dist-aws/index.html"), idx);
    writeFileSync(join(f.dir, "served-index.html"), o.index ?? idx);
    writeFileSync(join(f.dir, "served-main.js"), `var a={VITE_APP_ENV:"${o.env ?? "test"}",VITE_APP_VERSION:"${o.version ?? SHA}",VITE_X:"y"};`);
    mkdirSync(join(f.before, "web-before"), { recursive: true }); writeFileSync(join(f.before, "web-before/config.json"), '{"c":1}');
    writeFileSync(join(f.dir, "served-config.json"), o.config ?? '{"c":1}');
  };
  const verify = (e: Record<string, string> = {}) => run("web-verify.sh", ["https://d2xumch5w0izfg.cloudfront.net"], { OGEVIA_EXPECT_COMMIT: SHA, ...e });
  it("passes when the served page is the build, the bundle carries the SHA and TEST, and config.json is unchanged", () => {
    serve(); const r = verify(); expect(r.code, r.out).toBe(0);
    for (const t of ["PASS the served index.html is the one just built", `PASS the bundle carries the code SHA ${SHA}`, 'PASS built for TEST', "PASS config.json unchanged", "WEB VERIFIED"]) expect(r.out).toContain(t);
  });
  it.each([
    ["a bundle with another version", { version: "1".repeat(40) }, "version string is not the code SHA"],
    ["a bundle with the default version", { version: "0.1.0" }, "version string is not the code SHA"],
    ["a bundle built for production", { env: "production" }, "not built for TEST"],
    ["a served index.html that differs from the build (the old page)", { index: '<script src="/assets/index-OLD1.js"></script>' }, "differs from the build"],
    ["a changed config.json", { config: '{"c":2}' }, "config.json differs"],
    ["a page that references no main script", { noAsset: true }, "references no assets/index"],
  ])("stops on %s", (_n, o, text) => {
    serve(o as never); const r = verify(); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text as string); expect(r.out).not.toContain("WEB VERIFIED");
  });
  it("usage errors exit 2; a missing local build stops", () => {
    expect(run("web-verify.sh", ["https://x.example"], { OGEVIA_EXPECT_COMMIT: "abc" }).code).toBe(2);
    expect(verify({ OGEVIA_EXPECT_COMMIT: SHA }).code).toBe(1);
    expect(run("web-verify.sh", ["not-a-url"], { OGEVIA_EXPECT_COMMIT: SHA }).code).toBe(2);
  });
});

describe("record-deployed.sh: every deployed artifact must map to the commit", () => {
  const prepare = (opts: { sameSha?: boolean; key?: string } = {}) => {
    mkdirSync(join(f.before), { recursive: true });
    const before = JSON.parse(readFileSync(join(f.dir, "lambda-config.json"), "utf8"));
    writeFileSync(join(f.before, "lambda-config-before.json"), JSON.stringify({ ...before, CodeSha256: opts.sameSha ? before.CodeSha256 : "OLD/SHA/BASE64=" }));
    writeFileSync(join(f.before, "handler-function-name.txt"), "fn-handler\n");
    writeFileSync(join(f.before, "web-url-before.txt"), "https://d2xumch5w0izfg.cloudfront.net\n"); writeFileSync(join(f.before, "api-url-before.txt"), "https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com\n");
    const api = fx("release", API); if (opts.key) for (const [k, r] of Object.entries<any>(api.Resources)) if (r.Type === "AWS::Lambda::Function" && k.startsWith("Handler") && !k.startsWith("IdentityHandler")) r.Properties.Code.S3Key = opts.key;
    writeFileSync(join(f.dir, "after", `${API}.json`), JSON.stringify(api));
    writeFileSync(join(f.pkg, "apps/web/dist-aws/index.html"), '<script src="/assets/index-AbC123.js"></script>'); writeFileSync(join(f.dir, "served-index.html"), '<script src="/assets/index-AbC123.js"></script>');
    writeFileSync(join(f.dir, "served-main.js"), `{VITE_APP_ENV:"test",VITE_APP_VERSION:"${SHA}"}`);
  };
  const rec = (e: Record<string, string> = {}) => run("record-deployed.sh", [], { MOCK_TEMPLATE_DIR: "after", OGEVIA_EXPECT_COMMIT: SHA, OGEVIA_TARBALL_SHA256: "a".repeat(64), ...e });
  it("records the deployed SHA with the Lambda CodeSha256, the pinned asset key, the web version and the URLs", () => {
    prepare(); const r = rec(); expect(r.code, r.out).toBe(0);
    for (const t of [`DEPLOYED SHA          : ${SHA}`, "tarball sha256        : " + "a".repeat(64), "TEST web URL          : https://d2xumch5w0izfg.cloudfront.net", "TEST API URL          : https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com", "Lambda CodeSha256 (b64):", "Lambda CodeSha256 (hex):", `Handler asset in stack: ${RELEASE_KEY}`, `VITE_APP_VERSION:"${SHA}"`, "Ogevia-prod-NetworkEgress UPDATE_COMPLETE", "RECORDED"]) expect(r.out).toContain(t);
    expect(readFileSync(join(f.before, "DEPLOYED_RECORD.txt"), "utf8")).toContain(SHA);
    const hex = createHash("sha256").update(f.zip).digest("hex"); expect(r.out).toContain(`Lambda CodeSha256 (hex): ${hex}`);
  });
  it.each([
    ["the Lambda code did not change", () => prepare({ sameSha: true }), {}, "empty or equals the one before"],
    ["the deployed Handler asset is not the pinned build", () => prepare({ key: "0".repeat(64) + ".zip" }), {}, "not 6f37bc55"],
    ["BUILD_INFO names another commit", () => { prepare(); writeFileSync(join(f.pkg, "BUILD_INFO.json"), JSON.stringify({ code_commit: "2".repeat(40) })); }, {}, "BUILD_INFO commit"],
    ["the expected commit is another one", () => prepare(), { OGEVIA_EXPECT_COMMIT: "3".repeat(40) }, "FAIL"],
  ])("stops when %s", (_n, setup, e, text) => {
    (setup as () => void)(); const r = rec(e as Record<string, string>); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text as string); expect(r.out).not.toContain("RECORDED: every deployed artifact");
  });
  it("is read-only and the web bundle must carry the SHA", () => {
    prepare(); writeFileSync(join(f.dir, "served-main.js"), '{VITE_APP_ENV:"test",VITE_APP_VERSION:"0.1.0"}');
    const r = rec(); expect(r.code, r.out).toBe(1); expect(r.out).toContain("web verification failed");
    for (const c of awsCalls()) expect(c, c).toMatch(/^(sts|cloudformation (describe-stacks|get-template)|lambda get-function-configuration)/);
  });
});

describe("the operator procedure document", () => {
  const doc = readFileSync(join(REPO_ROOT, PKG_REL, "OPERATOR_PROCEDURE_0b593e5.md"), "utf8");
  const sha = (cmd: string) => sh("bash", ["-c", cmd], { cwd: REPO_ROOT }).stdout.trim();
  it("pins the values that the files actually have (the document cannot drift from the code)", () => {
    expect(doc).toContain(sha("cd infra/aws/db/migrations && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -d' ' -f1"));
    expect(doc).toContain(sha("cd infra/aws/db/rollback && LC_ALL=C sha256sum -- 00[7-8][0-9]_*.down.sql | awk '$2 >= \"0078\"' | sha256sum | cut -d' ' -f1"));
    expect(doc).toContain(sha("sha256sum pnpm-lock.yaml | cut -d' ' -f1"));
    expect(doc).toContain(sha("cd infra/aws/db/migrations && LC_ALL=C sha256sum -- $(ls *.sql | LC_ALL=C sort | head -77) | sha256sum | cut -d' ' -f1"));
    expect(sha("ls infra/aws/db/migrations | wc -l")).toBe("84");
    expect(doc).toContain(SHA);
    for (const m of doc.matchAll(/\b0b593e5[0-9a-f]{33}\b/g)) expect(m[0]).toBe(SHA);
    for (const key of [RELEASE_KEY, "929cdb1bde9bbf18025dc36f5cc61210246ca048efa6d6b51147cf4c22b24ab0", "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759"]) expect(doc).toContain(key);
  });
  const steps = [...doc.matchAll(/### Step (\d+) - ([^\n]*)\n([\s\S]*?)(?=\n### |\n## )/g)].map((m) => ({ n: Number(m[1]), title: m[2]!, body: m[3]! }));
  it("has Steps 0 to 17 in order, each with purpose, expected output, a stop condition and what to paste back; exactly one command block per scripted step", () => {
    expect(steps.map((s) => s.n)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    for (const s of steps) {
      expect(s.body, `step ${s.n}`).toMatch(/Expected/); expect(s.body, `step ${s.n}`).toMatch(/Stop/); expect(s.body, `step ${s.n}`).toMatch(/Paste back/); expect(s.body, `step ${s.n}`).toMatch(/Purpose|\| # \|/);
      const blocks = s.body.match(/```/g)?.length ?? 0;
      expect(blocks, `step ${s.n} code fences`).toBe(s.n === 14 ? 0 : 2);
    }
    expect(doc).toMatch(/\[YELLOW\]/);
  });
  it("deploys only through the guard: no raw cdk deploy, no all-stacks flag, no production stack in any command, no git in any command", () => {
    const blocks = [...doc.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]!).join("\n");
    expect(blocks).not.toMatch(/cdk deploy|cloudformation deploy|--all|--force|deploy-test-slice\.sh (infra|database|bootstrap|users|seed|pilot)/);
    expect(blocks).not.toMatch(/Ogevia-prd|ogevia_prd|ogevia-prd/);
    expect(blocks).not.toMatch(/(^|[\s;&|(])git\s/m);
    const deploys = blocks.split("\n").filter((l) => /deploy-guard\.sh" deploy/.test(l));
    expect(deploys).toHaveLength(2);
    expect(deploys.join("\n")).toMatch(/deploy Ogevia-prod-NetworkEgress/); expect(deploys.join("\n")).toMatch(/deploy Ogevia-prod-ServiceVerificationApi/);
    expect(blocks).toContain("--store-dir /tmp/pnpm-store");
    expect(blocks).not.toMatch(/pnpm install(?!.*--frozen-lockfile)/);
  });
  it("every script a command names exists in the package, and the order is the owner's: snapshot, gates, migrations, NetworkEgress, API, web", () => {
    for (const m of doc.matchAll(/\$S\/([A-Za-z0-9_.-]+)|"\$S\/([A-Za-z0-9_.-]+)"/g)) expect(existsSync(join(SCRIPTS_SRC, (m[1] ?? m[2])!)), m[0]).toBe(true);
    const at = (t: string) => doc.indexOf(t);
    const order = ["### Step 6 -", "### Step 7 -", "### Step 8 -", "### Step 9 -", "### Step 10 -", "### Step 11 -", "### Step 12 -", "### Step 13 -"].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(steps.find((s) => s.n === 6)!.body).toContain("ledger-recheck.sh");
    expect(steps.find((s) => s.n === 7)!.title).toMatch(/snapshot/i);
    expect(steps.find((s) => s.n === 10)!.title).toContain("NetworkEgress");
    expect(steps.find((s) => s.n === 11)!.title).toContain("ServiceVerificationApi");
  });
  it("states the production protections, the stop conditions, the recovery of each stage and the explicit non-goals", () => {
    for (const t of ["additive only", "Ogevia-prd-*", "enforcement", "R1 Web", "R2 API", "R3 Endpoint policy", "R4 Database", "R5 Snapshot restore", "R6", "Stop conditions", "does not deploy `Ogevia-prd-*`", "no git", "/tmp", "VITE_APP_VERSION", "DEPLOYED SHA"]) expect(doc, t).toContain(t);
    expect(doc).toMatch(/PROPOSED\. NOTHING IN THIS DOCUMENT HAS BEEN RUN AGAINST AWS/);
  });
});

describe("R1 web rollback block (extracted from the procedure): captured assets are verified and repaired before index.html is restored", () => {
  const doc = readFileSync(join(REPO_ROOT, PKG_REL, "OPERATOR_PROCEDURE_0b593e5.md"), "utf8");
  const block = /# web-rollback-asset-check\n([\s\S]*?)# end web-rollback-asset-check/.exec(doc)?.[1] ?? "";
  const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >> "$MOCK_DIR/aws-calls.log"
if [[ "$1 $2" == "s3api head-object" ]]; then
  key=""; while [[ $# -gt 0 ]]; do [[ "$1" == "--key" ]] && key="$2"; shift; done
  f="$MOCK_DIR/bucket/$key"; [[ -f "$f" ]] && { wc -c < "$f" | tr -d ' '; exit 0; } || { echo "An error occurred (404)" >&2; exit 254; }
fi
if [[ "$1 $2" == "s3 cp" ]]; then src="$3"; dest="\${4#s3://*/}"; mkdir -p "$(dirname "$MOCK_DIR/bucket/$dest")"; cp "$src" "$MOCK_DIR/bucket/$dest"; exit 0; fi
echo "unexpected aws call: $*" >&2; exit 99
`;
  let dir: string;
  const put = (root: string, rel: string, body: string) => { mkdirSync(join(dir, root, rel, ".."), { recursive: true }); writeFileSync(join(dir, root, rel), body); };
  const runBlock = () => {
    writeFileSync(join(dir, "check.sh"), `set -u\nBUCKET=test-bucket\n${block}`);
    const r = spawnSync("bash", [join(dir, "check.sh")], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, MOCK_DIR: dir } });
    return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status };
  };
  const calls = () => (existsSync(join(dir, "aws-calls.log")) ? readFileSync(join(dir, "aws-calls.log"), "utf8").split("\n").filter(Boolean) : []);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "webroll-"));
    mkdirSync(join(dir, "bin")); writeFileSync(join(dir, "bin", "aws"), FAKE_AWS); chmodSync(join(dir, "bin", "aws"), 0o755);
    put("web-before", "index.html", '<script type="module" src="/assets/index-AAAA1111.js"></script><link rel="stylesheet" href="/assets/index-BBBB2222.css">');
    put("web-before", "assets/index-AAAA1111.js", "console.log('old main')"); put("web-before", "assets/index-BBBB2222.css", "body{}"); put("web-before", "assets/chunk-CCCC3333.js", "export default 1"); put("web-before", "config.json", '{"live":"config"}');
    put("bucket", "assets/index-AAAA1111.js", "console.log('old main')"); put("bucket", "assets/index-BBBB2222.css", "body{}"); put("bucket", "assets/chunk-CCCC3333.js", "export default 1"); put("bucket", "assets/index-NEW99999.js", "console.log('new')"); put("bucket", "index.html", "NEW INDEX"); put("bucket", "config.json", '{"live":"config"}');
  });
  it("the block exists in the procedure, contains nothing destructive, and runs before the old index.html is put back", () => {
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/--delete|s3 rm|s3 sync|rm -r|s3api delete|put-bucket|lifecycle/);
    expect(doc.indexOf("# web-rollback-asset-check")).toBeLessThan(doc.indexOf('aws s3 cp web-before/index.html "s3://$BUCKET/index.html"'));
  });
  it("normal case: nothing is restored, nothing is written", () => { const r = runBlock(); expect(r.out).toContain("files to restore from the capture: 0"); expect(r.out).not.toContain("STOP:"); expect(calls().filter((c) => c.startsWith("s3 cp"))).toEqual([]); });
  it("a missing asset is restored with the immutable cache header and nothing is deleted; a resized one too", () => {
    spawnSync("rm", [join(dir, "bucket/assets/index-AAAA1111.js")]); writeFileSync(join(dir, "bucket/assets/chunk-CCCC3333.js"), "export default 'changed and longer'");
    const r = runBlock();
    expect(r.out).toContain("files to restore from the capture: 2"); expect(r.out).toContain("restored assets/index-AAAA1111.js"); expect(r.out).toContain("restored assets/chunk-CCCC3333.js");
    expect(readFileSync(join(dir, "bucket/assets/index-AAAA1111.js"), "utf8")).toBe("console.log('old main')");
    expect(calls().filter((c) => c.startsWith("s3 cp")).every((c) => c.includes("--cache-control public,max-age=31536000,immutable"))).toBe(true);
    expect(existsSync(join(dir, "bucket/assets/index-NEW99999.js"))).toBe(true);
  });
  it("index.html and config.json are never in the restore list; an asset missing from the capture itself stops with a STOP line", () => {
    writeFileSync(join(dir, "bucket/config.json"), "different config, different size");
    expect(runBlock().out).toContain("files to restore from the capture: 0");
    expect(readFileSync(join(dir, "bucket/config.json"), "utf8")).toBe("different config, different size");
    spawnSync("rm", [join(dir, "web-before/assets/index-BBBB2222.css")]);
    expect(runBlock().out).toContain("STOP: assets/index-BBBB2222.css is referenced by the captured index.html but is not in the capture");
  });
});
