// deploy-guard.sh (TEST release 7870a04): the only deployment path, for exactly one stack (Ogevia-prod-ServiceVerificationApi). Fake aws and npx; the REAL release templates are the
// assembly and the e80b770 templates (with the hand-applied hostnames, decision D2 = yes) are the "live" stacks. No AWS, no network.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PKG_REL, REPO_ROOT, sh } from "./operator-0086-fixtures.js";

vi.setConfig({ testTimeout: 60000 });
const FIX = fileURLToPath(new URL("./fixtures/operator-0086/", import.meta.url));
const SCRIPTS_SRC = join(REPO_ROOT, PKG_REL, "scripts");
const API = "Ogevia-prod-ServiceVerificationApi", WEB = "Ogevia-prod-WebHosting";
const STACKS = ["EvidenceStorage", "NetworkEgress", "WebHosting", "ServiceVerificationApi", "Observability"];
type T = any;
const fx = (kind: "live" | "release", stack: string): T => JSON.parse(readFileSync(join(FIX, kind, `${stack}.template.json`), "utf8"));
const NEW_KEYS: string[] = JSON.parse(readFileSync(join(SCRIPTS_SRC, "new-route-keys.json"), "utf8"));
const OLD_KEYS = ["GET /v1/me", "POST /v1/visits", "GET /v1/clients", "POST /v1/shifts", "GET /v1/reports/hours"];

const AWS = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
case "$1 $2" in
  "sts get-caller-identity") echo "{\\"Account\\":\\"\${MOCK_ACCOUNT:-300094796789}\\"}" ;;
  "cloudformation describe-stacks") echo "\${MOCK_STACK_STATUS:-UPDATE_COMPLETE}" ;;
  "cloudformation get-template") stack=$(grep -o 'Ogevia-pr[a-z]*-[A-Za-z]*' <<<"$*" | head -1); cat "$D/live-$stack.json" ;;
  "lambda get-function-configuration") cat "$D/lambda-after.json" ;;
  "apigatewayv2 get-routes") cat "$D/routes-after.json" ;;
  "apigatewayv2 get-api") cat "$D/cors-after.json" ;;
  "events list-rules") printf 'ComplianceSweepAB12\\t%s\\n' "\${MOCK_SWEEP_STATE:-ENABLED}" ;;
  *) echo "mock aws: unexpected call: $*" >&2; echo "UNEXPECTED $*" >> "$D/aws-calls.log"; exit 99 ;;
esac
`;
const NPX = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/npx-calls.log"
if [[ "$*" == *"cdk diff"* ]]; then echo "Resources"; echo "[~] mock diff"; exit 0; fi
if [[ "$*" == *"cdk deploy"* ]]; then [[ -n "\${MOCK_DEPLOY_FAIL:-}" ]] && { echo "deploy failed" >&2; exit 1; }; echo deployed; exit 0; fi
exit 97
`;
interface Fix { dir: string; bin: string; scripts: string; asm: string; before: string }
let f: Fix;
function fixture(): Fix {
  const dir = mkdtempSync(join(tmpdir(), "guard0086-"));
  const root = join(dir, "pkg"); const scripts = join(root, PKG_REL, "scripts");
  mkdirSync(join(root, "infra/aws"), { recursive: true }); mkdirSync(scripts, { recursive: true }); cpSync(SCRIPTS_SRC, scripts, { recursive: true });
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "aws"), AWS); writeFileSync(join(bin, "npx"), NPX); chmodSync(join(bin, "aws"), 0o755); chmodSync(join(bin, "npx"), 0o755);
  const asm = join(dir, "cdk.out"); mkdirSync(asm);
  for (const s of STACKS) writeFileSync(join(asm, `Ogevia-prod-${s}.template.json`), JSON.stringify(fx("release", `Ogevia-prod-${s}`)));
  // live: the four unchanged stacks equal the release; the API is the e80b770 state with the hand-applied HTTP API (CORS) resource (decision D2 = yes)
  for (const s of STACKS) writeFileSync(join(dir, `live-Ogevia-prod-${s}.json`), JSON.stringify(fx("release", `Ogevia-prod-${s}`)));
  const live = fx("live", API); const k = Object.keys(live.Resources).find((x) => live.Resources[x].Type === "AWS::ApiGatewayV2::Api")!; live.Resources[k] = fx("release", API).Resources[k];
  writeFileSync(join(dir, `live-${API}.json`), JSON.stringify(live));
  const before = join(dir, "before"); mkdirSync(before);
  const env = { Variables: { OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test" } };
  writeFileSync(join(before, "handler-function-name.txt"), "fn-handler\n"); writeFileSync(join(before, "api-id.txt"), "s0epy5rgzb\n");
  writeFileSync(join(before, "lambda-config-before.json"), JSON.stringify({ CodeSha256: "OLDSHA=", Environment: env }));
  writeFileSync(join(before, "routes-before.json"), JSON.stringify(OLD_KEYS)); writeFileSync(join(before, "cors-before.json"), JSON.stringify({ AllowOrigins: ["https://demo.ogevia.com"] }));
  writeFileSync(join(dir, "lambda-after.json"), JSON.stringify({ CodeSha256: "NEWSHA=", LastUpdateStatus: "Successful", Environment: env }));
  writeFileSync(join(dir, "routes-after.json"), JSON.stringify([...OLD_KEYS, ...NEW_KEYS])); writeFileSync(join(dir, "cors-after.json"), JSON.stringify({ AllowOrigins: ["https://demo.ogevia.com"] }));
  return { dir, bin, scripts, asm, before };
}
beforeEach(() => { f = fixture(); });
const guard = (args: string[], opts: { env?: Record<string, string>; input?: string } = {}) =>
  sh("bash", [join(f.scripts, "deploy-guard.sh"), ...args], { input: opts.input ?? "", env: { PATH: `${f.bin}:${process.env.PATH}`, MOCK_DIR: f.dir, ASSEMBLY: f.asm, OGEVIA_BEFORE: f.before, OGEVIA_DEPLOY_APPROVAL: "REF-TEST-0001", HOME: f.dir, ...(opts.env ?? {}) } });
const log = (n: string) => (existsSync(join(f.dir, n)) ? readFileSync(join(f.dir, n), "utf8").split("\n").filter(Boolean) : []);
const deploys = () => log("npx-calls.log").filter((c) => c.includes("cdk deploy"));
const writes = () => log("aws-calls.log").filter((c) => /^(cloudformation (create|update|delete|execute)|lambda (update|publish|delete)|iam |ec2 (authorize|revoke)|s3 )/.test(c));

describe("check: read-only, passes only for the expected difference", () => {
  it("the API stack shows DELTA (13 routes + Handler) and passes; the four others show NONE; nothing is deployed or written", () => {
    let r = guard(["check", API]);
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("CHECK PASSED for Ogevia-prod-ServiceVerificationApi (DELTA)"); expect(r.out).toContain("13 staff API routes added");
    for (const s of ["EvidenceStorage", "NetworkEgress", "WebHosting", "Observability"]) { r = guard(["check", `Ogevia-prod-${s}`]); expect(r.code, r.out).toBe(0); expect(r.out).toContain(`(NONE)`); }
    expect(deploys()).toEqual([]); expect(writes()).toEqual([]);
  });
  it("refuses a stack outside the allow-list, a production stack, a glob, a list, a missing argument and an unknown mode", () => {
    for (const a of [["check", "Ogevia-prd-ServiceVerificationApi"], ["check", "Ogevia-prod-*"], ["check", "Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability"], ["check", "--all"], ["check", ""]]) { const r = guard(a); expect(r.code, `${a}: ${r.out}`).toBe(1); expect(r.out).toContain("REFUSED"); }
    expect(guard(["check"]).code).toBe(2); expect(guard(["destroy", API]).code).toBe(2); expect(guard([]).code).toBe(2); expect(guard(["check", API, "extra"]).code).toBe(2);
    expect(deploys()).toEqual([]);
  });
  it("refuses a wrong account, an unsettled stack, a missing template, an assembly that is not the release", () => {
    let r = guard(["check", API], { env: { MOCK_ACCOUNT: "111111111111" } }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("wrong AWS account");
    r = guard(["check", API], { env: { MOCK_STACK_STATUS: "UPDATE_IN_PROGRESS" } }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not settled");
    r = guard(["check", API], { env: { ASSEMBLY: join(f.dir, "nowhere") } }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("no synthesized template");
    const t = fx("release", API); Object.values<any>(t.Resources).find((x) => x.Type === "AWS::Events::Rule").Properties.State = "DISABLED"; writeFileSync(join(f.asm, `${API}.template.json`), JSON.stringify(t));
    r = guard(["check", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not the approved release");
  });
  it("decision D2: if the hostnames are NOT live, the WebHosting and API checks refuse (the live stack is the e80b770 state)", () => {
    writeFileSync(join(f.dir, `live-${WEB}.json`), JSON.stringify(fx("live", WEB)));
    let r = guard(["check", WEB]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("NOT the release's expected change");
    writeFileSync(join(f.dir, `live-${API}.json`), JSON.stringify(fx("live", API)));
    r = guard(["check", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("NOT the release's expected change");
  });
  it("any extra live drift (a changed live IAM policy) stops the check", () => {
    const live = JSON.parse(readFileSync(join(f.dir, `live-${API}.json`), "utf8")); const k = Object.keys(live.Resources).find((x) => live.Resources[x].Type === "AWS::IAM::ManagedPolicy")!; live.Resources[k].Properties.Zz = "drift";
    writeFileSync(join(f.dir, `live-${API}.json`), JSON.stringify(live));
    const r = guard(["check", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("resource CHANGED outside the allow-list");
  });
});

describe("deploy: one stack, the gate first, a typed phrase, the exact command", () => {
  it("refuses without the approval reference, for any stack but the API stack, and when the result is not DELTA", () => {
    let r = guard(["deploy", API], { env: { OGEVIA_DEPLOY_APPROVAL: "" }, input: `DEPLOY-${API}\n` }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("OGEVIA_DEPLOY_APPROVAL");
    for (const s of ["EvidenceStorage", "NetworkEgress", "WebHosting", "Observability"]) { r = guard(["deploy", `Ogevia-prod-${s}`], { input: `DEPLOY-Ogevia-prod-${s}\n` }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("can only be checked"); }
    writeFileSync(join(f.dir, `live-${API}.json`), JSON.stringify(fx("release", API)));
    r = guard(["deploy", API], { input: `DEPLOY-${API}\n` }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("not DELTA"); expect(deploys()).toEqual([]);
  });
  it("a wrong or empty phrase declines; nothing is deployed", () => {
    for (const input of ["", "yes\n", "DEPLOY-Ogevia-prod-Observability\n", "deploy-Ogevia-prod-ServiceVerificationApi\n"]) { const r = guard(["deploy", API], { input }); expect(r.code, r.out).toBe(0); expect(r.out).toContain("Declined. Nothing was deployed."); }
    expect(deploys()).toEqual([]);
  });
  it("the right phrase runs exactly ONE cdk deploy with the fixed argument vector and nothing else", () => {
    const r = guard(["deploy", API], { input: `DEPLOY-${API}\n` });
    expect(r.code, r.out).toBe(0); expect(r.out).toContain("now run: bash deploy-guard.sh post");
    expect(deploys()).toEqual([`cdk deploy --app ${f.asm} --exclusively ${API} --require-approval broadening --no-notices`]);
    expect(deploys().join(" ")).not.toMatch(/prd|\*|--all|--force|--hotswap|--no-rollback|--concurrency/); expect(writes()).toEqual([]);
  });
  it("a failing cdk deploy reports STOP and exit 1", () => {
    const r = guard(["deploy", API], { input: `DEPLOY-${API}\n`, env: { MOCK_DEPLOY_FAIL: "1" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("STOP: cdk deploy exited 1"); expect(r.out).toContain("Do not deploy the next stack");
  });
});

describe("post: read-only checks after the deployment", () => {
  it("passes for a good deployment", () => {
    const r = guard(["post", API]); expect(r.code, r.out).toBe(0); expect(r.out).toContain("POST-CHECK PASSED"); expect(r.out).toContain("the API gained exactly 13 routes"); expect(r.out).toContain("all 13 staff routes exist");
    expect(writes()).toEqual([]);
  });
  it("only the API stack can be post-checked", () => { const r = guard(["post", "Ogevia-prod-Observability"]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("can only be checked"); });
  const bad = (label: string, mutate: () => void, text: string, env: Record<string, string> = {}) => it(`fails: ${label}`, () => { mutate(); const r = guard(["post", API], { env }); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text); expect(r.out).toContain("STOP: a post-deployment check failed"); });
  const w = (n: string, v: unknown) => writeFileSync(join(f.dir, n), JSON.stringify(v));
  bad("a route count of before + 12", () => w("routes-after.json", [...OLD_KEYS, ...NEW_KEYS.slice(1)]), "not");
  bad("a missing staff route with the count right", () => w("routes-after.json", [...OLD_KEYS, ...NEW_KEYS.slice(1), "GET /v1/other"]), "staff routes missing");
  bad("an earlier route lost", () => w("routes-after.json", [...OLD_KEYS.slice(1), ...NEW_KEYS, "GET /v1/extra"]), "routes lost");
  bad("the Lambda environment changed", () => w("lambda-after.json", { CodeSha256: "NEWSHA=", LastUpdateStatus: "Successful", Environment: { Variables: { OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test", X: "1" } } }), "Lambda environment CHANGED");
  bad("the Lambda code did not change", () => w("lambda-after.json", { CodeSha256: "OLDSHA=", LastUpdateStatus: "Successful", Environment: { Variables: { OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test" } } }), "did not change");
  bad("the Lambda update did not finish", () => w("lambda-after.json", { CodeSha256: "NEWSHA=", LastUpdateStatus: "InProgress", Environment: { Variables: { OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test" } } }), "LastUpdateStatus is not Successful");
  bad("CORS changed", () => w("cors-after.json", { AllowOrigins: ["*"] }), "CORS configuration CHANGED");
  bad("the compliance sweep is disabled", () => undefined, "ComplianceSweep is not ENABLED", { MOCK_SWEEP_STATE: "DISABLED" });
  bad("the stack is not UPDATE_COMPLETE", () => undefined, "not UPDATE_COMPLETE", { MOCK_STACK_STATUS: "UPDATE_ROLLBACK_COMPLETE" });
  bad("the captured before-state is missing", () => writeFileSync(join(f.before, "routes-before.json"), ""), "the route count is");
});
