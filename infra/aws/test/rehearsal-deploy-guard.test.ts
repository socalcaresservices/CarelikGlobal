// deploy-guard.sh (TEST rehearsal): the only deployment path. Fake aws and npx, REAL release templates as the assembly and the baseline as the "live" stacks. No AWS.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURES, PKG_REL, SCRIPTS_SRC, sh } from "./rehearsal-fixtures.js";

vi.setConfig({ testTimeout: 60000 });
const NET = "Ogevia-prod-NetworkEgress", API = "Ogevia-prod-ServiceVerificationApi";
const TEST_B = "ogevia-prod-signature-evidence-300094796789-us-west-2", PRD_B = "ogevia-prd-signature-evidence-300094796789-us-west-2";
type T = any;
const fx = (kind: string, stack: string): T => JSON.parse(readFileSync(join(FIXTURES, kind, `${stack}.template.json`), "utf8"));
const clone = (x: T): T => JSON.parse(JSON.stringify(x));
const epOf = (t: T) => Object.values<any>(t.Resources).find((r) => r.Type === "AWS::EC2::VPCEndpoint" && r.Properties.VpcEndpointType === "Gateway");
const polOf = (t: T) => Object.entries<any>(t.Resources).find(([k, r]) => r.Type === "AWS::IAM::ManagedPolicy" && k.startsWith("HandlerPolicy"))![1];

const AWS = `#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
case "$1 $2" in
  "sts get-caller-identity") echo '{"Account":"300094796789","Arn":"arn:aws:sts::300094796789:assumed-role/Admin/op"}' ;;
  "cloudformation describe-stacks") echo "\${MOCK_STACK_STATUS:-UPDATE_COMPLETE}" ;;
  "cloudformation get-template") stack=$(grep -o 'Ogevia-pr[a-z]*-[A-Za-z]*' <<<"$*" | head -1); cat "$D/live-$stack.json" ;;
  "cloudformation list-stack-resources")
    if [[ "$*" == *ManagedPolicy* ]]; then echo "arn:aws:iam::300094796789:policy/handler-policy"; else echo "fn-handler"; fi ;;
  "ec2 describe-vpc-endpoints") cat "$D/ep-after.json" ;;
  "lambda get-function-configuration") cat "$D/lambda-after.json" ;;
  "iam get-policy") echo v7 ;;
  "iam get-policy-version") cat "$D/iam-doc.json" ;;
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
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const root = join(dir, "pkg"); const scripts = join(root, PKG_REL, "scripts");
  mkdirSync(join(root, "infra/aws"), { recursive: true }); mkdirSync(scripts, { recursive: true }); cpSync(SCRIPTS_SRC, scripts, { recursive: true });
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "aws"), AWS); writeFileSync(join(bin, "npx"), NPX); chmodSync(join(bin, "aws"), 0o755); chmodSync(join(bin, "npx"), 0o755);
  const asm = join(dir, "cdk.out"); mkdirSync(asm);
  for (const s of ["EvidenceStorage", "NetworkEgress", "WebHosting", "ServiceVerificationApi", "Observability"]) writeFileSync(join(asm, `Ogevia-prod-${s}.template.json`), JSON.stringify(fx("release", `Ogevia-prod-${s}`)));
  writeFileSync(join(dir, `live-${NET}.json`), JSON.stringify(fx("baseline", NET)));
  writeFileSync(join(dir, `live-${API}.json`), JSON.stringify(fx("baseline", API)));
  const before = join(dir, "before"); mkdirSync(before);
  writeFileSync(join(before, "endpoint-id.txt"), "vpce-0abc123\n"); writeFileSync(join(before, "handler-function-name.txt"), "fn-handler\n");
  writeFileSync(join(before, "endpoint-policy-before.json"), JSON.stringify(epOf(fx("baseline", NET)).Properties.PolicyDocument));
  const env = { Variables: { OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test" } };
  writeFileSync(join(before, "lambda-config-before.json"), JSON.stringify({ CodeSha256: "OLDSHA=", Environment: env }));
  // "after" state defaults to a good deployment
  writeFileSync(join(dir, "ep-after.json"), JSON.stringify(epOf(fx("release", NET)).Properties.PolicyDocument));
  writeFileSync(join(dir, "lambda-after.json"), JSON.stringify({ CodeSha256: "NEWSHA=", LastUpdateStatus: "Successful", Environment: env }));
  writeFileSync(join(dir, "iam-doc.json"), JSON.stringify({ Statement: polOf(fx("release", API)).Properties.PolicyDocument.Statement.map((s: T) => ({ Sid: s.Sid })) }));
  return { dir, bin, scripts, asm, before };
}
beforeEach(() => { f = fixture(); });
const guard = (args: string[], opts: { env?: Record<string, string>; input?: string } = {}) =>
  sh("bash", [join(f.scripts, "deploy-guard.sh"), ...args], { input: opts.input ?? "", env: { PATH: `${f.bin}:${process.env.PATH}`, MOCK_DIR: f.dir, ASSEMBLY: f.asm, OGEVIA_BEFORE: f.before, OGEVIA_DEPLOY_APPROVAL: "REF-TEST-0001", ...(opts.env ?? {}) } });
const log = (n: string) => (existsSync(join(f.dir, n)) ? readFileSync(join(f.dir, n), "utf8").split("\n").filter(Boolean) : []);
const deploys = () => log("npx-calls.log").filter((c) => c.includes("cdk deploy"));

describe("check: read-only, passes only for the expected difference", () => {
  it.each([NET, API])("%s: the baseline live template vs the release assembly passes and deploys nothing", (stack) => {
    const r = guard(["check", stack]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("PASS all checks");
    expect(r.out).toContain("EXPECTED-ONLY: YES");
    expect(r.out).toContain(`CHECK PASSED for ${stack}`);
    expect(deploys()).toEqual([]);
    expect(log("aws-calls.log").join("\n")).not.toMatch(/UNEXPECTED|cloudformation (deploy|update|create|delete)|put-|modify|delete-|create-/);
  });
  it("stops when the live stack has something the release would remove (e.g. a production entry that is not in the synthesized policy)", () => {
    const live = fx("baseline", NET); epOf(live).Properties.PolicyDocument.Statement[0].Resource.push(`arn:aws:s3:::${PRD_B}/*/extra-live-entry/*`);
    writeFileSync(join(f.dir, `live-${NET}.json`), JSON.stringify(live));
    const r = guard(["check", NET]);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("REFUSED: the difference is NOT the release's expected change");
    expect(r.out).toContain("removed or altered");
  });
  it("stops when the live API stack has drifted (a changed Lambda environment would be part of the difference)", () => {
    const live = fx("baseline", API); const [, h] = Object.entries<any>(live.Resources).find(([k, r]) => r.Type === "AWS::Lambda::Function" && k.startsWith("Handler") && !k.startsWith("IdentityHandler"))!; h.Properties.Environment.Variables.OGEVIA_ENV = "prd";
    writeFileSync(join(f.dir, `live-${API}.json`), JSON.stringify(live));
    const r = guard(["check", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("changed beyond its code asset");
  });
  it("stops when the live stack is already the release (nothing to deploy) or an extra resource would appear", () => {
    writeFileSync(join(f.dir, `live-${NET}.json`), JSON.stringify(fx("release", NET)));
    expect(guard(["check", NET]).code).toBe(1);
    const asm = fx("release", NET); asm.Resources.ExtraSg = { Type: "AWS::EC2::SecurityGroup", Properties: {} };
    writeFileSync(join(f.asm, `${NET}.template.json`), JSON.stringify(asm));
    const r = guard(["check", NET]); expect(r.code, r.out).toBe(1);
  });
  it("stops on a stack that is not settled and on an assembly that is not the approved release (wrong Handler asset)", () => {
    const s = guard(["check", NET], { env: { MOCK_STACK_STATUS: "UPDATE_ROLLBACK_COMPLETE" } }); expect(s.code, s.out).toBe(1); expect(s.out).toContain("not settled");
    const t = fx("release", API); const [, h] = Object.entries<any>(t.Resources).find(([k, r]) => r.Type === "AWS::Lambda::Function" && k.startsWith("Handler") && !k.startsWith("IdentityHandler"))!; h.Properties.Code.S3Key = "0".repeat(64) + ".zip";
    writeFileSync(join(f.asm, `${API}.template.json`), JSON.stringify(t));
    const a = guard(["check", API]); expect(a.code, a.out).toBe(1); expect(a.out).toContain("not the approved release");
  });
});

describe("deploy: one allow-listed stack, exact command, nothing without the typed phrase", () => {
  it("runs exactly `cdk deploy --app <assembly> --exclusively <stack> --require-approval broadening --no-notices` once, after the gate, only on the typed phrase", () => {
    const r = guard(["deploy", NET], { input: `DEPLOY-${NET}\n` });
    expect(r.code, r.out).toBe(0);
    expect(r.out.indexOf("EXPECTED-ONLY: YES")).toBeLessThan(r.out.indexOf("ABOUT TO RUN"));
    expect(deploys()).toEqual([`cdk deploy --app ${f.asm} --exclusively ${NET} --require-approval broadening --no-notices`]);
  });
  it("another phrase, or an empty answer, deploys nothing", () => {
    for (const input of ["yes\n", "DEPLOY-Ogevia-prod-ServiceVerificationApi\n", "\n", ""]) {
      const r = guard(["deploy", NET], { input }); expect(r.code, r.out).toBe(0); expect(r.out).toContain("Declined. Nothing was deployed.");
    }
    expect(deploys()).toEqual([]);
  });
  it("a failed gate deploys nothing even with the phrase typed", () => {
    const live = fx("baseline", NET); epOf(live).Properties.PolicyDocument.Statement[0].Resource.push("arn:aws:s3:::x/y"); writeFileSync(join(f.dir, `live-${NET}.json`), JSON.stringify(live));
    const r = guard(["deploy", NET], { input: `DEPLOY-${NET}\n` }); expect(r.code, r.out).toBe(1); expect(deploys()).toEqual([]);
  });
  it("a failing cdk deploy is reported and the next stack is not started by this script", () => {
    const r = guard(["deploy", NET], { input: `DEPLOY-${NET}\n`, env: { MOCK_DEPLOY_FAIL: "1" } });
    expect(r.code, r.out).toBe(1); expect(r.out).toContain("cdk deploy exited 1");
  });
  it("needs the owner's approval reference", () => {
    const r = guard(["deploy", NET], { input: `DEPLOY-${NET}\n`, env: { OGEVIA_DEPLOY_APPROVAL: "" } }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("OGEVIA_DEPLOY_APPROVAL"); expect(deploys()).toEqual([]);
  });
  it.each([
    ["a production stack", ["deploy", "Ogevia-prd-ServiceVerificationApi"]],
    ["a production NetworkEgress", ["deploy", "Ogevia-prd-NetworkEgress"]],
    ["a glob", ["deploy", "Ogevia-prod-*"]],
    ["a wildcard", ["deploy", "*"]],
    ["--all", ["deploy", "--all"]],
    ["another TEST stack", ["deploy", "Ogevia-prod-WebHosting"]],
    ["EvidenceStorage", ["deploy", "Ogevia-prod-EvidenceStorage"]],
    ["a stack name with a trailing glob", ["deploy", "Ogevia-prod-NetworkEgress*"]],
    ["two stacks", ["deploy", NET, API]],
    ["a stack list in one argument", ["deploy", `${NET},${API}`]],
    ["no stack", ["deploy"]],
    ["an unknown mode", ["destroy", NET]],
  ])("refuses %s before any AWS call", (_n, args) => {
    const r = guard(args as string[], { input: "DEPLOY-anything\n" });
    expect(r.code, r.out).not.toBe(0);
    expect(deploys()).toEqual([]);
    expect(log("aws-calls.log")).toEqual([]);
    expect(log("npx-calls.log")).toEqual([]);
  });
  it("the script text can only ever build a deploy command for the two allow-listed stacks", () => {
    const src = readFileSync(join(SCRIPTS_SRC, "deploy-guard.sh"), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code.match(/cdk deploy/g)).toHaveLength(2); // the argument vector and the message that prints it
    expect(code).toContain("ALLOWED=(Ogevia-prod-NetworkEgress Ogevia-prod-ServiceVerificationApi)");
    expect(code).toContain('DEPLOY_ARGV=(npx cdk deploy --app "$ASSEMBLY" --exclusively "$STACK" --require-approval broadening --no-notices)');
    expect(code).not.toMatch(/cloudformation (deploy|update-stack|delete-stack|create-stack)|--require-approval never/);
    expect(code.match(/"\$\{DEPLOY_ARGV\[@\]\}"/g)).toHaveLength(1); // the one place the vector is executed
    expect(code.split("\n").filter((l) => /Ogevia-prd/.test(l)).every((l) => /refuse|REFUSED|No Ogevia-prd/.test(l))).toBe(true);
  });
});

describe("post: read-only checks after each deployment", () => {
  it("NetworkEgress: additive-only endpoint policy with the production entries intact passes", () => {
    const r = guard(["post", NET]); expect(r.code, r.out).toBe(0); expect(r.out).toContain("POST-CHECK PASSED"); expect(r.out).toContain("ENDPOINT POLICY ADDITIVE-ONLY: YES");
    expect(r.out).toContain("resources now: 8 (before: 6)");
    expect(existsSync(join(f.before, "endpoint-policy-after.json"))).toBe(true);
  });
  it("NetworkEgress: a live policy that LOST a production entry fails; so does one that did not change", () => {
    const after = epOf(fx("release", NET)).Properties.PolicyDocument; after.Statement[0].Resource = after.Statement[0].Resource.filter((x: string) => x !== `arn:aws:s3:::${PRD_B}/*/documents/*/*`);
    writeFileSync(join(f.dir, "ep-after.json"), JSON.stringify(after));
    let r = guard(["post", NET]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("the PRODUCTION bucket lost access"); expect(r.out).not.toContain("POST-CHECK PASSED");
    writeFileSync(join(f.dir, "ep-after.json"), JSON.stringify(epOf(fx("baseline", NET)).Properties.PolicyDocument));
    r = guard(["post", NET]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("did not gain exactly");
  });
  it("NetworkEgress: the stack not UPDATE_COMPLETE fails", () => { const r = guard(["post", NET], { env: { MOCK_STACK_STATUS: "UPDATE_ROLLBACK_COMPLETE" } }); expect(r.code, r.out).toBe(1); });
  it("API: environment unchanged, new CodeSha256, ClientDocumentObjects present, sweep ENABLED passes", () => {
    const r = guard(["post", API]); expect(r.code, r.out).toBe(0); expect(r.out).toContain("Lambda CodeSha256: before OLDSHA=  after NEWSHA="); expect(r.out).toContain("POST-CHECK PASSED");
  });
  it.each([
    ["the Lambda environment changed", () => writeFileSync(join(f.dir, "lambda-after.json"), JSON.stringify({ CodeSha256: "NEWSHA=", LastUpdateStatus: "Successful", Environment: { Variables: { OGEVIA_ENV: "prd", DB_NAME: "ogevia_prd" } } })), "Lambda environment CHANGED"],
    ["the code did not change", () => writeFileSync(join(f.dir, "lambda-after.json"), JSON.stringify({ CodeSha256: "OLDSHA=", LastUpdateStatus: "Successful", Environment: { Variables: { OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test" } } })), "did not change"],
    ["the policy lacks ClientDocumentObjects", () => writeFileSync(join(f.dir, "iam-doc.json"), JSON.stringify({ Statement: [{ Sid: "Other" }] })), "ClientDocumentObjects is not in the handler policy"],
  ])("API: fails when %s", (_n, mutate, text) => {
    (mutate as () => void)();
    const r = guard(["post", API]); expect(r.code, r.out).toBe(1); expect(r.out).toContain(text as string);
  });
  it("API: ComplianceSweep not ENABLED fails", () => { const r = guard(["post", API], { env: { MOCK_SWEEP_STATE: "DISABLED" } }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("ComplianceSweep is not ENABLED"); });
});
