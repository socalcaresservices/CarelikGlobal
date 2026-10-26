// baseline-capture.sh, snapshot-verify.sh, web-verify.sh, record-deployed.sh and route-smoke.sh (TEST release 7870a04). Fake aws and curl; the real synthesized templates; no AWS, no network.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PKG_REL, REPO_ROOT } from "./operator-0086-fixtures.js";

vi.setConfig({ testTimeout: 60000 });
const FIX = fileURLToPath(new URL("./fixtures/operator-0086/", import.meta.url));
const SCRIPTS_SRC = join(REPO_ROOT, PKG_REL, "scripts");
const SHA = "7870a04c43545bacc378ad93ffc6a09d63345b5a";
const TARSHA = "a".repeat(64);
const RELEASE_KEY = "94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip";
const STACKS = ["EvidenceStorage", "NetworkEgress", "WebHosting", "ServiceVerificationApi", "Observability"];
const NEW_KEYS: string[] = JSON.parse(readFileSync(join(SCRIPTS_SRC, "new-route-keys.json"), "utf8"));
const OLD_KEYS = ["GET /v1/me", "POST /v1/visits", "GET /v1/clients", "POST /v1/shifts"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const minutes = (m: number) => new Date(Date.now() + m * 60000);
const sha256 = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
type T = any;
const fx = (kind: "live" | "release", stack: string): T => JSON.parse(readFileSync(join(FIX, kind, `${stack}.template.json`), "utf8"));
const ZIP = "synthetic lambda code zip\n";
const ZIP_B64 = createHash("sha256").update(ZIP).digest("base64");

const AWS = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
stack=$(grep -o 'Ogevia-pr[a-z]*-[A-Za-z]*' <<<"$*" | head -1)
case "$1 $2" in
  "sts get-caller-identity") echo "{\\"Account\\":\\"\${MOCK_ACCOUNT:-300094796789}\\",\\"Arn\\":\\"arn:aws:sts::300094796789:assumed-role/Admin/op\\"}" ;;
  "cloudformation describe-stacks")
    if [[ "$*" == *"--output json"* ]]; then
      case "$stack" in
        Ogevia-prod-WebHosting) o='[{"OutputKey":"WebOrigin","OutputValue":"https://d2xumch5w0izfg.cloudfront.net"},{"OutputKey":"SiteBucketName","OutputValue":"site-bucket"},{"OutputKey":"DistributionId","OutputValue":"E123ABC"}]' ;;
        Ogevia-prod-ServiceVerificationApi) o='[{"OutputKey":"ApiUrl","OutputValue":"https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com"}]' ;;
        *) o='[]' ;;
      esac
      [[ -n "\${MOCK_NO_OUTPUTS:-}" && "$stack" == Ogevia-prod-WebHosting ]] && o='[]'
      echo "{\\"Stacks\\":[{\\"StackStatus\\":\\"\${MOCK_STACK_STATUS:-UPDATE_COMPLETE}\\",\\"Outputs\\":$o}]}"
    else echo "\${MOCK_STACK_STATUS:-UPDATE_COMPLETE}"; fi ;;
  "cloudformation get-template") cat "$D/\${MOCK_TEMPLATE_DIR:-live}/$stack.json" ;;
  "cloudformation list-stack-resources")
    if [[ "$*" == *"AWS::Lambda::Function"* ]]; then echo fn-handler
    elif [[ "$*" == *"AWS::ApiGatewayV2::Api"* ]]; then echo s0epy5rgzb
    elif [[ "$*" == *"UserPoolClient"* ]]; then echo client123; fi ;;
  "lambda get-function-configuration") if [[ -n "\${MOCK_AFTER:-}" ]]; then cat "$D/lambda-after.json"; else cat "$D/lambda-config.json"; fi ;;
  "lambda get-function") echo "https://example.invalid/code.zip" ;;
  "apigatewayv2 get-routes") cat "$D/routes.json" ;;
  "apigatewayv2 get-api") cat "$D/cors.json" ;;
  "cloudfront get-distribution-config") echo '{"DistributionConfig":{"Aliases":{"Items":["demo.ogevia.com"]},"ViewerCertificate":{"ACMCertificateArn":"arn:aws:acm:us-east-1:300094796789:certificate/x"}}}' ;;
  "cognito-idp describe-user-pool-client") echo '{"callbacks":["https://demo.ogevia.com/"],"logouts":["https://demo.ogevia.com/"]}' ;;
  "rds describe-db-instances") printf '%s\\t%s\\t%s\\tpostgres\\t16.4\\tdb.t4g.small\\tFalse\\t7\\n' "\${MOCK_RDS_STATUS:-available}" "\${MOCK_RDS_PUBLIC:-False}" "\${MOCK_RDS_ENC:-True}" ;;
  "s3api head-object") [[ -n "\${MOCK_NO_ASSET:-}" ]] && { echo "404" >&2; exit 254; }; echo 123456 ;;
  "s3 sync") cp -r "$D/site/." "$4" ;;
  "events list-rules") printf 'ComplianceSweepAB12\\t%s\\n' "\${MOCK_SWEEP_STATE:-ENABLED}" ;;
  "rds create-db-snapshot") [[ -n "\${MOCK_CREATE_FAIL:-}" ]] && exit 254; echo creating ;;
  "rds wait") [[ -n "\${MOCK_WAIT_FAIL:-}" ]] && exit 255; exit 0 ;;
  "rds describe-db-snapshots")
    [[ -n "\${MOCK_SNAP_MISSING:-}" ]] && { echo "An error occurred (DBSnapshotNotFound)" >&2; exit 254; }
    created=$(date -u -d "@$(( $(date +%s) - \${MOCK_SNAP_AGE_MIN:-10} * 60 ))" +%Y-%m-%dT%H:%M:%S.123000+00:00)
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${MOCK_SNAP_STATUS:-available}" "\${MOCK_SNAP_INSTANCE:-ogevia-prod-postgres}" "\${MOCK_SNAP_TYPE:-manual}" "\${MOCK_SNAP_CREATED:-$created}" "\${MOCK_SNAP_ENC:-True}" ;;
  *) echo "mock aws: unexpected call: $*" >&2; echo "UNEXPECTED $*" >> "$D/aws-calls.log"; exit 99 ;;
esac
`;
// curl: -o FILE URL | URL | -w '%{http_code}' URL | -D - -o /dev/null -X OPTIONS URL
const CURL = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/curl-calls.log"
out=""; url=""; method=GET; wcode=""; dump=""
while (( $# )); do case "$1" in -o) out="$2"; shift 2 ;; -X) method="$2"; shift 2 ;; -w) wcode=1; shift 2 ;; -D) dump=1; shift 2 ;; -H|--data|--max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
emit() { if [[ -n "$out" && "$out" != /dev/null ]]; then cat > "$out"; else cat; fi; }
case "$url" in
  https://example.invalid/code.zip) printf '%s' "\${MOCK_ZIP:-${ZIP.replace(/\n/g, "\\n")}}" | sed 's/\\\\n/\\n/g' | emit ;;
  *.execute-api.us-west-2.amazonaws.com/*)
    if [[ "$method" == OPTIONS ]]; then
      [[ -n "$dump" ]] && { if [[ -n "\${MOCK_CORS_BAD:-}" ]]; then printf 'HTTP/2 204\\r\\n\\r\\n'; else printf 'HTTP/2 204\\r\\naccess-control-allow-origin: https://demo.ogevia.com\\r\\n\\r\\n'; fi; }
      exit 0
    fi
    code=401; [[ -n "\${MOCK_BAD_PATH:-}" && "$url" == *"\${MOCK_BAD_PATH}"* ]] && code=200
    [[ -n "\${MOCK_CURL_FAIL:-}" ]] && exit 7
    [[ -n "$wcode" ]] && printf '%s' "$code" ;;
  https://*)
    p="\${url#https://*/}"; [[ "$p" == "$url" ]] && p=""
    f="$D/site/$p"; [[ -f "$f" ]] || { echo "curl: (22) 404" >&2; exit 22; }
    if [[ -n "\${MOCK_SERVED_DIR:-}" && -f "$D/\${MOCK_SERVED_DIR}/$p" ]]; then f="$D/\${MOCK_SERVED_DIR}/$p"; fi
    emit < "$f" ;;
  *) echo "mock curl: unexpected $url" >&2; exit 98 ;;
esac
`;

interface Fix { dir: string; bin: string; scripts: string; root: string; before: string; asm: string }
let f: Fix;
const INDEX = '<!doctype html><script type="module" src="/assets/index-AbC123.js"></script>\n';
const bundle = (ver: string, env = "test") => `var a={VITE_APP_VERSION:"${ver}",VITE_APP_ENV:"${env}"};\n`;
function fixture(): Fix {
  const dir = mkdtempSync(join(tmpdir(), "scr0086-"));
  const root = join(dir, "pkg"); const scripts = join(root, PKG_REL, "scripts");
  mkdirSync(scripts, { recursive: true }); cpSync(SCRIPTS_SRC, scripts, { recursive: true });
  writeFileSync(join(root, "BUILD_INFO.json"), JSON.stringify({ code_commit: SHA, approval_ref: "APPROVAL-REF-PENDING-OWNER" }));
  mkdirSync(join(root, "apps/web/dist-aws/assets"), { recursive: true }); writeFileSync(join(root, "apps/web/dist-aws/index.html"), INDEX);
  const bin = join(dir, "bin"); mkdirSync(bin);
  for (const [n, body] of [["aws", AWS], ["curl", CURL]] as const) { writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755); }
  // live stacks: the e80b770 state with the hand-applied HTTP API (decision D2 = yes); an assembly of the release templates
  mkdirSync(join(dir, "live")); const asm = join(dir, "cdk.out"); mkdirSync(asm);
  for (const s of STACKS) { writeFileSync(join(dir, "live", `Ogevia-prod-${s}.json`), JSON.stringify(fx(s === "WebHosting" ? "release" : "live", `Ogevia-prod-${s}`))); writeFileSync(join(asm, `Ogevia-prod-${s}.template.json`), JSON.stringify(fx("release", `Ogevia-prod-${s}`))); }
  const liveApi = fx("live", "Ogevia-prod-ServiceVerificationApi"); const apiKey = Object.keys(liveApi.Resources).find((x) => liveApi.Resources[x].Type === "AWS::ApiGatewayV2::Api")!;
  liveApi.Resources[apiKey] = fx("release", "Ogevia-prod-ServiceVerificationApi").Resources[apiKey]; writeFileSync(join(dir, "live/Ogevia-prod-ServiceVerificationApi.json"), JSON.stringify(liveApi)); // decision D2 = yes
  const env = { Variables: { OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test" } };
  writeFileSync(join(dir, "lambda-config.json"), JSON.stringify({ CodeSha256: ZIP_B64, LastUpdateStatus: "Successful", Environment: env }));
  writeFileSync(join(dir, "routes.json"), JSON.stringify(OLD_KEYS)); writeFileSync(join(dir, "cors.json"), JSON.stringify({ AllowOrigins: ["https://demo.ogevia.com"] }));
  // the served site: the build's index.html, a bundle carrying the SHA and TEST
  mkdirSync(join(dir, "site/assets"), { recursive: true }); writeFileSync(join(dir, "site/index.html"), INDEX); writeFileSync(join(dir, "site/assets/index-AbC123.js"), bundle(SHA)); writeFileSync(join(dir, "site/config.json"), '{"a":1}\n');
  const before = join(dir, "before"); mkdirSync(before);
  return { dir, bin, scripts, root, before, asm };
}
beforeEach(() => { f = fixture(); });
function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(f.scripts, script), ...args], { encoding: "utf8", input: "", env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, MOCK_DIR: f.dir, HOME: f.dir, OGEVIA_BEFORE: f.before, ASSEMBLY: f.asm, ...env } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
const lines = (n: string) => (existsSync(join(f.dir, n)) ? readFileSync(join(f.dir, n), "utf8").split("\n").filter(Boolean) : []);
const readVerbs = ["sts get-caller-identity", "cloudformation describe-stacks", "cloudformation get-template", "cloudformation list-stack-resources", "lambda get-function-configuration", "lambda get-function", "apigatewayv2 get-routes", "apigatewayv2 get-api", "cloudfront get-distribution-config", "cognito-idp describe-user-pool-client", "rds describe-db-instances", "s3api head-object", "s3 sync", "events list-rules", "rds describe-db-snapshots"];
const verbs = () => lines("aws-calls.log").map((c) => c.split(" ").slice(0, 2).join(" "));

describe("baseline-capture.sh: read-only; captures what recovery and the post-checks need", () => {
  it("captures everything and passes; only read verbs are used; the live-versus-release comparison is informational", () => {
    const r = run("baseline-capture.sh");
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("BASELINE CAPTURED");
    for (const file of ["handler-function-name.txt", "lambda-config-before.json", "lambda-code-before.zip", "previous-api-asset.txt", "api-id.txt", "routes-before.json", "cors-before.json", "api-url-before.txt", "web-url-before.txt", "web-before.sha256", "web-index-sha256-before.txt", "sweep-before.txt", "gate-baseline-Ogevia-prod-ServiceVerificationApi.txt", "cloudfront-before.json", "cognito-client-before.json"]) expect(existsSync(join(f.before, file)), file).toBe(true);
    expect(readFileSync(join(f.before, "api-id.txt"), "utf8").trim()).toBe("s0epy5rgzb");
    expect(JSON.parse(readFileSync(join(f.before, "routes-before.json"), "utf8"))).toEqual(OLD_KEYS);
    expect(r.out).toContain("Ogevia-prod-ServiceVerificationApi: EXPECTED-ONLY: YES (DELTA)");
    expect(r.out).toContain("no staff route exists yet");
    for (const v of new Set(verbs())) expect(readVerbs).toContain(v);
  });
  it("warns (does not fail) when a live stack is not 'this release minus its allowed difference'; the authoritative gate is Step 8", () => {
    writeFileSync(join(f.dir, "live/Ogevia-prod-WebHosting.json"), JSON.stringify(fx("live", "Ogevia-prod-WebHosting")));
    const r = run("baseline-capture.sh");
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("WARN the live Ogevia-prod-WebHosting is not"); expect(r.out).toContain("Step 8 will stop on it");
  });
  it.each([
    ["a wrong account", { MOCK_ACCOUNT: "111111111111" }, "wrong AWS account"],
    ["an unsettled stack", { MOCK_STACK_STATUS: "UPDATE_ROLLBACK_COMPLETE" }, "not a settled status"],
    ["a missing web output", { MOCK_NO_OUTPUTS: "1" }, "an output (ApiUrl, WebOrigin, SiteBucketName, DistributionId) is missing"],
    ["a private-less database", { MOCK_RDS_PUBLIC: "True" }, "RDS is not available / private / encrypted"],
    ["an unencrypted database", { MOCK_RDS_ENC: "False" }, "RDS is not available / private / encrypted"],
    ["a previous API asset that cannot be read", { MOCK_NO_ASSET: "1" }, "quick API rollback would not work"],
    ["a disabled compliance sweep", { MOCK_SWEEP_STATE: "DISABLED" }, "ComplianceSweep is not ENABLED"],
    ["a captured zip that differs from CodeSha256", { MOCK_ZIP: "different" }, "differs from CodeSha256"],
  ])("stops on %s (exit 1, nothing written to AWS)", (_n, env, text) => {
    const r = run("baseline-capture.sh", [], env as Record<string, string>);
    expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).not.toContain("BASELINE CAPTURED");
    for (const v of new Set(verbs())) expect(readVerbs).toContain(v);
  });
  it("stops when the Lambda serves another database or the production environment", () => {
    writeFileSync(join(f.dir, "lambda-config.json"), JSON.stringify({ CodeSha256: ZIP_B64, Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd" } } }));
    const r = run("baseline-capture.sh"); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not TEST");
  });
  it("a staff route already present is a NOTE, never silently ignored", () => {
    writeFileSync(join(f.dir, "routes.json"), JSON.stringify([...OLD_KEYS, "GET /v1/staff"]));
    const r = run("baseline-capture.sh"); expect(r.out).toContain("NOTE some s");
  });
});

describe("snapshot-verify.sh: a snapshot that is not verified stops the release", () => {
  const win = (s = -60, e = 180) => ({ OGEVIA_RELEASE_WINDOW_START: iso(minutes(s)), OGEVIA_RELEASE_WINDOW_END: iso(minutes(e)) });
  const name = (ago = 10) => `ogevia-prod-postgres-pre-0086-${stamp(minutes(-ago))}`;
  it("create: takes ONE snapshot with the named pattern, waits, verifies, records the id", () => {
    const r = run("snapshot-verify.sh", ["create"], { ...win() });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("SNAPSHOT VERIFIED");
    expect(verbs().filter((v) => v === "rds create-db-snapshot")).toHaveLength(1);
    expect(readFileSync(join(f.before, "snapshot-id.txt"), "utf8").trim()).toMatch(/^ogevia-prod-postgres-pre-0086-\d{12}$/);
  });
  it("create refuses outside the window and creates nothing; a snapshot that never becomes available stops", () => {
    let r = run("snapshot-verify.sh", ["create"], { ...win(30, 240) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("outside the release window"); expect(verbs()).not.toContain("rds create-db-snapshot");
    r = run("snapshot-verify.sh", ["create"], { ...win(), MOCK_WAIT_FAIL: "1" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("did not become available");
    r = run("snapshot-verify.sh", ["create"], { ...win(), MOCK_CREATE_FAIL: "1" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("create-db-snapshot failed");
  });
  it("verify: passes for a good snapshot (id from the variable or from the recorded file) and is read-only", () => {
    let r = run("snapshot-verify.sh", ["verify"], { ...win(), OGEVIA_PREDEPLOY_SNAPSHOT_ID: name() }); expect(r.code, r.out).toBe(0); expect(r.out).toContain("SNAPSHOT VERIFIED");
    writeFileSync(join(f.before, "snapshot-id.txt"), name() + "\n"); r = run("snapshot-verify.sh", ["verify"], { ...win() }); expect(r.code, r.out).toBe(0);
    expect(verbs()).not.toContain("rds create-db-snapshot");
  });
  it.each([
    ["an id of the earlier pattern", { OGEVIA_PREDEPLOY_SNAPSHOT_ID: "ogevia-prod-postgres-pre-0085-202610250100" }, "does not match"],
    ["a missing snapshot", { MOCK_SNAP_MISSING: "1" }, "cannot read snapshot"],
    ["a snapshot still creating", { MOCK_SNAP_STATUS: "creating" }, "not available"],
    ["another instance", { MOCK_SNAP_INSTANCE: "other" }, "belongs to"],
    ["an automated snapshot", { MOCK_SNAP_TYPE: "automated" }, "not manual"],
    ["an unencrypted snapshot", { MOCK_SNAP_ENC: "False" }, "not encrypted"],
    ["a snapshot created before the window", { MOCK_SNAP_CREATED: "2020-01-01T00:00:00.000000+00:00" }, "outside the release window"],
  ])("verify stops on %s", (_n, env, text) => {
    const r = run("snapshot-verify.sh", ["verify"], { ...win(), OGEVIA_PREDEPLOY_SNAPSHOT_ID: name(), ...(env as Record<string, string>) });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).not.toContain("SNAPSHOT VERIFIED");
  });
  it("usage and window validation", () => {
    expect(run("snapshot-verify.sh", []).code).toBe(2); expect(run("snapshot-verify.sh", ["restore"]).code).toBe(2);
    let r = run("snapshot-verify.sh", ["verify"], { OGEVIA_PREDEPLOY_SNAPSHOT_ID: name() }); expect(r.code).toBe(1); expect(r.out).toContain("OGEVIA_RELEASE_WINDOW_START");
    r = run("snapshot-verify.sh", ["verify"], { ...win(-60, 800), OGEVIA_PREDEPLOY_SNAPSHOT_ID: name() }); expect(r.code).toBe(1); expect(r.out).toContain("at most 12 hours");
  });
});

describe("web-verify.sh: what TEST serves must be the build, with the code SHA as the version", () => {
  const go = (env: Record<string, string> = {}, args = ["https://d2xumch5w0izfg.cloudfront.net"]) => run("web-verify.sh", args, { OGEVIA_EXPECT_COMMIT: SHA, ...env });
  it("passes when the served page is the build (bytes compared from a file, trailing newline included), the bundle carries the SHA and TEST, and config.json is unchanged", () => {
    mkdirSync(join(f.before, "web-before"), { recursive: true }); writeFileSync(join(f.before, "web-before/config.json"), '{"a":1}\n');
    const r = go(); expect(r.code, r.out).toBe(0); expect(r.out).toContain("WEB VERIFIED"); expect(r.out).toContain("config.json unchanged");
  });
  it("a trailing-newline-less compare would have failed; this one does not (the 2026-10-19 defect)", () => { expect(go().code).toBe(0); });
  it.each([
    ["a different index.html", () => writeFileSync(join(f.dir, "site/index.html"), INDEX + "<!-- stale -->\n"), "differs from the build"],
    ["a bundle with another version", () => writeFileSync(join(f.dir, "site/assets/index-AbC123.js"), bundle("1".repeat(40))), "not the code SHA"],
    ["a bundle built for another environment", () => writeFileSync(join(f.dir, "site/assets/index-AbC123.js"), bundle(SHA, "prod")), "not built for TEST"],
    ["a changed config.json", () => { mkdirSync(join(f.before, "web-before"), { recursive: true }); writeFileSync(join(f.before, "web-before/config.json"), '{"a":2}\n'); }, "config.json differs"],
  ])("stops on %s", (_n, mutate, text) => { mutate(); const r = go(); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).not.toContain("WEB VERIFIED"); });
  it("usage errors exit 2; a missing local build stops", () => {
    expect(go({ OGEVIA_EXPECT_COMMIT: "abc" }).code).toBe(2); expect(go({}, ["http://insecure.example"]).code).toBe(2);
    rmSyncSafe(join(f.root, "apps/web/dist-aws/index.html")); const r = go(); expect(r.code).toBe(1); expect(r.out).toContain("no local build");
  });
  it("only GET requests are made", () => { go(); for (const c of lines("curl-calls.log")) expect(c).not.toMatch(/-X (POST|PUT|DELETE)|--data/); });
});
function rmSyncSafe(p: string) { spawnSync("rm", ["-f", p]); }

describe("record-deployed.sh: every deployed artifact must map to the commit", () => {
  const setup = () => {
    writeFileSync(join(f.before, "handler-function-name.txt"), "fn-handler\n"); writeFileSync(join(f.before, "lambda-config-before.json"), JSON.stringify({ CodeSha256: "OLD=" }));
    writeFileSync(join(f.before, "web-url-before.txt"), "https://d2xumch5w0izfg.cloudfront.net\n"); writeFileSync(join(f.before, "api-url-before.txt"), "https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com\n");
    writeFileSync(join(f.dir, "lambda-after.json"), JSON.stringify({ CodeSha256: ZIP_B64, LastUpdateStatus: "Successful", LastModified: "2026-10-27T03:30:00.000+0000", Environment: { Variables: {} } }));
    const t = fx("release", "Ogevia-prod-ServiceVerificationApi"); writeFileSync(join(f.dir, "live/Ogevia-prod-ServiceVerificationApi.json"), JSON.stringify(t));
  };
  const rec = (env: Record<string, string> = {}) => run("record-deployed.sh", [], { OGEVIA_EXPECT_COMMIT: SHA, OGEVIA_TARBALL_SHA256: TARSHA, MOCK_AFTER: "1", ...env });
  it("records the deployed SHA with the Lambda CodeSha256, the pinned asset key, the web version and the URLs; read-only", () => {
    setup(); const r = rec();
    expect(r.code, r.out).toBe(0); expect(r.out).toContain(`RECORDED: every deployed artifact maps to ${SHA}`); expect(r.out).toContain(`DEPLOYED SHA          : ${SHA}`); expect(r.out).toContain(`Handler asset in stack: ${RELEASE_KEY}`);
    expect(readFileSync(join(f.before, "DEPLOYED_RECORD.txt"), "utf8")).toContain(`tarball sha256        : ${TARSHA}`);
    for (const v of new Set(verbs())) expect(["sts get-caller-identity", "cloudformation describe-stacks", "cloudformation get-template", "cloudformation list-stack-resources", "lambda get-function-configuration"]).toContain(v);
  });
  it.each([
    ["an unchanged Lambda (CodeSha256 equals the one before)", () => writeFileSync(join(f.before, "lambda-config-before.json"), JSON.stringify({ CodeSha256: ZIP_B64 })), "equals the one before"],
    ["a wrong asset key in the deployed stack", () => { const t = fx("release", "Ogevia-prod-ServiceVerificationApi"); Object.entries<any>(t.Resources).find(([k, r]) => r.Type === "AWS::Lambda::Function" && k.startsWith("Handler") && !k.startsWith("Identity"))![1].Properties.Code.S3Key = "0".repeat(64) + ".zip"; writeFileSync(join(f.dir, "live/Ogevia-prod-ServiceVerificationApi.json"), JSON.stringify(t)); }, "not 94b73574"],
    ["a Lambda update that did not succeed", () => writeFileSync(join(f.dir, "lambda-after.json"), JSON.stringify({ CodeSha256: ZIP_B64, LastUpdateStatus: "Failed" })), "LastUpdateStatus is not Successful"],
    ["a web that is not the release", () => writeFileSync(join(f.dir, "site/assets/index-AbC123.js"), bundle("2".repeat(40))), "web verification failed"],
  ])("fails on %s", (_n, mutate, text) => { setup(); mutate(); const r = rec(); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).toContain("STOP: an artifact does not map"); });
  it("usage: the commit and the tarball hash are required; BUILD_INFO must name the commit", () => {
    setup(); expect(run("record-deployed.sh", [], {}).code).toBe(2);
    const r = rec({ OGEVIA_EXPECT_COMMIT: "9".repeat(40) }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("BUILD_INFO commit");
  });
});

describe("route-smoke.sh: the 13 staff routes refuse every call without a valid token", () => {
  const API = "https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com";
  it("passes: 13 routes x 2 calls (no token, forged token), all 401, plus the CORS preflight; no credential is sent", () => {
    const r = run("route-smoke.sh", [API]);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("ROUTE SMOKE PASSED: 13 routes x 2 calls, all 401; CORS preflight ok");
    const calls = lines("curl-calls.log"); expect(calls.length).toBe(27);
    for (const c of calls) expect(c).not.toMatch(/-X (PUT|DELETE|PATCH)/);
    for (const k of NEW_KEYS) expect(r.out).toContain(`PASS ${k} (none token): 401`);
    expect(calls.join("\n")).not.toContain("00000000-0000-4000-8000-00000000000G");
  });
  it("a route that answers anything but 401, a curl failure and a bad CORS preflight each fail", () => {
    let r = run("route-smoke.sh", [API], { MOCK_BAD_PATH: "/v1/staff-audit" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL GET /v1/staff-audit"); expect(r.out).toContain("HTTP 200, expected 401");
    r = run("route-smoke.sh", [API], { MOCK_CURL_FAIL: "1" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("curl-failed");
    r = run("route-smoke.sh", [API], { MOCK_CORS_BAD: "1" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL CORS preflight");
  });
  it("refuses the production API id, a non-API URL and a missing argument", () => {
    let r = run("route-smoke.sh", ["https://zk527zk4ua.execute-api.us-west-2.amazonaws.com"]); expect(r.code, r.out).toBe(2); expect(r.out).toContain("PRODUCTION API"); expect(lines("curl-calls.log")).toEqual([]);
    r = run("route-smoke.sh", ["https://example.com"]); expect(r.code).toBe(2);
    r = run("route-smoke.sh", []); expect(r.code).toBe(2);
  });
  it("uses the captured API url by default", () => { writeFileSync(join(f.before, "api-url-before.txt"), API + "\n"); expect(run("route-smoke.sh", []).code).toBe(0); });
});
