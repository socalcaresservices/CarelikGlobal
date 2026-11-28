// TEST_RT2_N5_EMAIL_RECIPIENT_IDENTITY.sh (Release Train 2, TEST stage 5: the SES sandbox fix, one recipient identity ARN added to the email function's send permission) with stand-in `aws`, `pnpm`, `curl` tools in a throwaway git repository, using the REAL synthesized
// templates for the "live" and "new" stacks and the real diff_gate_email.py. Nothing touches AWS and nothing is sent.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { newApp } from "./helpers.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TCREL = "docs/releases/2026-11-20-test-plan/toolchain";
const script = join(root, TCREL, "TEST_RT2_N5_EMAIL_RECIPIENT_IDENTITY.sh");
const FEATURES = "    features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },\n";
const feats = { ...ENVIRONMENTS.prod.features, requestCleanup: true, offices: true, officeAssignments: true, assignmentHistory: true, notifications: true, openShiftSms: true, serviceLocation: true };
const base = { ...ENVIRONMENTS.prod, features: feats } as OgeviaEnvironmentConfig;
const withEmail = { ...base, notificationEmail: { from: "Ogevia <scheduling@ogevia.com>", replyTo: "admin.ogevia@gmail.com", sesIdentityArn: "arn:aws:ses:us-west-2:300094796789:identity/ogevia.com", allowedRecipients: ["admin.ogevia@gmail.com"] } } as OgeviaEnvironmentConfig;
const RECIPIENT_ARN = "arn:aws:ses:us-west-2:300094796789:identity/admin.ogevia@gmail.com";
const withRecipient = { ...withEmail, notificationEmail: { ...withEmail.notificationEmail!, recipientIdentityArns: [RECIPIENT_ARN] } } as OgeviaEnvironmentConfig;
const QR = { Type: "String", NoEcho: true, Default: "" };
const dump = (cfg: OgeviaEnvironmentConfig) => Object.fromEntries(buildOgeviaApp(newApp(), cfg, "plan").map((p) => { const t = Template.fromStack(p.stack).toJSON() as any; t.Parameters = { ...(t.Parameters ?? {}), ClientQrEncryptionKey: QR }; return [p.stack.stackName, t]; }));
let OFF: Record<string, any>, ON: Record<string, any>, REC: Record<string, any>;
beforeAll(() => { OFF = dump(base); ON = dump(withEmail); REC = dump(withRecipient); }, 180000);

const API = "Ogevia-prod-ServiceVerificationApi", EGRESS = "Ogevia-prod-NetworkEgress";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rt2n5-"));
  const repo = join(dir, "repo"); const work = join(dir, "work"); const bin = join(dir, "bin"); const calls = join(dir, "calls"); const st = join(dir, "state"); const tc = join(repo, TCREL);
  for (const d of [tc, work, bin, st, join(repo, "infra/aws/lib"), join(repo, "infra/aws/node_modules/.bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(calls, ""); writeFileSync(join(repo, "infra/aws/lib/config.ts"), `const PROD = {\n${FEATURES}};\n`); writeFileSync(join(repo, "infra/aws/node_modules/.bin/cdk"), ""); chmodSync(join(repo, "infra/aws/node_modules/.bin/cdk"), 0o755);
  for (const f of ["diff_gate_email.py", "diff_gate_rt2.py"]) copyFileSync(join(root, TCREL, f), join(tc, f));
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").stdout.trim();
  for (const [name, v] of [["off", ON], ["on", REC]] as const) { mkdirSync(join(dir, name), { recursive: true }); for (const stack of [API, EGRESS]) writeFileSync(join(dir, name, `${stack}.template.json`), JSON.stringify(v[stack])); }
  writeFileSync(join(st, "api"), JSON.stringify(ON[API])); writeFileSync(join(st, "egress"), JSON.stringify(ON[EGRESS]));
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import json, sys, os
a = sys.argv[1:]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "120"]): a = a[2:]
line = " ".join(a)
open(${JSON.stringify(calls)}, "a").write("aws " + line + "\\n")
st = ${JSON.stringify(st)}; d = ${JSON.stringify(dir)}
def out(x): print(x if isinstance(x, str) else json.dumps(x))
flag = lambda n: os.path.exists(st + "/" + n)
live = lambda stack: open(st + "/" + ("api" if stack.endswith("Api") else "egress")).read()
email_live = lambda: "NotificationEmail" in live("Api")
if "sts get-caller-identity" in line: out("300094796789")
elif "sesv2 get-email-identity --email-identity ogevia.com" in line:
    if flag("no-identity"): sys.exit(254)
    out({"IdentityType": "DOMAIN", "VerifiedForSendingStatus": not flag("unverified"), "DkimAttributes": {"Status": "PENDING" if flag("dkim-pending") else "SUCCESS"}})
elif "sesv2 get-email-identity --email-identity admin.ogevia@gmail.com" in line:
    if flag("no-recipient"): sys.exit(254)
    out({"IdentityType": "EMAIL_ADDRESS", "VerifiedForSendingStatus": not flag("recipient-unverified")})
elif "sesv2 get-account" in line: out({"ProductionAccessEnabled": flag("production-access")})
elif "lambda get-function --function-name Ogevia-prod-NotificationEmail" in line: sys.exit(0 if (flag("email-exists") or email_live()) else 254)
elif "lambda get-function-configuration --function-name Ogevia-prod-NotificationEmail" in line:
    out({"Environment": {"Variables": {"SES_FROM": "Ogevia <scheduling@ogevia.com>", "SES_REPLY_TO": "admin.ogevia@gmail.com", "SES_ALLOWED_RECIPIENTS": "admin.ogevia@gmail.com" if not flag("bad-vars") else "*"}}, "VpcConfig": {}})
elif "list-stack-resources" in line: out({"StackResourceSummaries": [{"ResourceType": "AWS::Lambda::Function", "LogicalResourceId": "Handler886CB40B", "PhysicalResourceId": "fn"}]})
elif "get-template" in line: out(live([w for w in a if w.startswith("Ogevia-")][0]))
elif "rds describe-db-instances" in line: out("arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-x")
elif "lambda get-function-configuration" in line and "--query Environment.Variables" in line:
    e = {"DB_NAME": "ogevia_sv_test", "SMS_MODE": "mock", "SERVICE_LOCATION": "on"}
    if email_live(): e.update({"EMAIL_FUNCTION_NAME": "Ogevia-prod-NotificationEmail", "APP_ORIGIN": "https://demo.ogevia.com"})
    out(e)
elif "lambda get-function-configuration" in line: out({"FunctionName": "fn", "CodeSha256": "x", "Database": {"name": "ogevia_sv_test"}})
elif "lambda wait" in line: pass
elif "lambda invoke" in line:
    payload = open(a[a.index("--payload") + 1].replace("file://", "")).read(); target = a[-4] if False else a[a.index("--query") - 1]
    r = {"ok": False, "error": "invalid_request", "transient": False} if payload.strip() == "{}" else ({"ok": True, "messageId": "m"} if flag("allowlist-broken") else {"ok": False, "error": "recipient_not_allowed", "transient": False})
    open(target, "w").write(json.dumps(r)); out("200")
elif "describe-stacks" in line and "StackStatus" in line: out("UPDATE_COMPLETE")
else: sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`);
  writeFileSync(join(bin, "corepack"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash
[[ "$1" == "--version" ]] && { echo 9.15.4; exit 0; }
if [[ "$*" == *"cdk synth"* ]]; then out=""; prev=""; for x in "$@"; do [[ "$prev" == "--output" ]] && out="$x"; prev="$x"; done
  cfg="$(cat "$PWD/infra/aws/lib/config.ts")"; kind=off; [[ "$cfg" == *"recipientIdentityArns"* ]] && kind=on
  [[ "$cfg" == *"allowedRecipients: [\\"admin.ogevia@gmail.com\\"]"* ]] || { echo "the allow-list is missing from the config" >&2; exit 7; }
  [[ "$cfg" == *"openShiftSms: true"* && "$cfg" == *"notifications: true"* ]] || { echo "the earlier switches were not kept ON" >&2; exit 7; }
  mkdir -p "$out"; cp ${JSON.stringify(dir)}/$kind/*.json "$out/"; echo "synth $kind" >> ${JSON.stringify(calls)}; exit 0; fi
if [[ "$*" == *"cdk deploy"* ]]; then app=""; stack=""; prev=""; for x in "$@"; do [[ "$prev" == "--app" ]] && app="$x"; [[ "$prev" == "--exclusively" ]] && stack="$x"; prev="$x"; done
  echo "deploy $(basename "$app") $stack" >> ${JSON.stringify(calls)}
  case "$stack" in *Api) cp "$app/$stack.template.json" ${JSON.stringify(join(st, "api"))};; *) cp "$app/$stack.template.json" ${JSON.stringify(join(st, "egress"))};; esac
  exit 0; fi
exit 9
`);
  for (const f of ["aws", "pnpm", "corepack"]) chmodSync(join(bin, f), 0o755);
  return { dir, repo, work, bin, calls, head, st };
}
type S = ReturnType<typeof setup>;

function run(s: S, env: Record<string, string> = {}, mode?: string) {
  return spawnSync("bash", [script, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, REPO: s.repo, WORK: s.work, OGEVIA_RELEASE_COMMIT: s.head, OGEVIA_DEPLOY_APPROVAL: "RT2-TEST-20261126", OGEVIA_APP_BASE: s.head, OGEVIA_NO_CONFIRM: "1", ...env } });
}
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });
const calls = (s: S) => readFileSync(s.calls, "utf8");
const changes = (s: S) => calls(s).split("\n").filter((l) => /^deploy /.test(l));
const gitClean = (s: S) => spawnSync("git", ["-C", s.repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim() === "";
const flag = (s: S, n: string) => writeFileSync(join(s.st, n), "");

describe("TEST_RT2_N5_EMAIL_RECIPIENT_IDENTITY.sh", () => {
  it("refuses a different commit, a bad approval reference and an unknown mode, before anything else", () => {
    const s = setup();
    try {
      let r = run(s, { OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(2); expect(r.stderr).toContain("not at the release commit");
      r = run(s, { OGEVIA_DEPLOY_APPROVAL: "x y" }); expect(r.status).toBe(2); expect(r.stderr).toContain("OGEVIA_DEPLOY_APPROVAL must be");
      r = run(s, {}, "rollback-api"); expect(r.status).toBe(2); expect(r.stderr).toContain("usage:");
      expect(changes(s)).toEqual([]);
    } finally { done(s); }
  });

  it("stops before any change unless SES is ready (identity missing, unverified, DKIM not SUCCESS, recipient missing or unverified in the sandbox)", () => {
    const cases: Array<[string, RegExp]> = [["no-identity", /does not exist in us-west-2/], ["unverified", /not verified for sending/], ["dkim-pending", /DKIM for ogevia.com is not SUCCESS/], ["no-recipient", /is not an SES identity/], ["recipient-unverified", /is not verified yet/]];
    for (const [f, re] of cases) {
      const s = setup();
      try { flag(s, f); const r = run(s); expect(r.status, f).toBe(2); expect(r.stderr, f).toMatch(re); expect(changes(s), f).toEqual([]); expect(calls(s)).not.toMatch(/synth/); expect(gitClean(s)).toBe(true); } finally { done(s); }
    }
  }, 180000);

  it("stops before any change when stage 4 is not deployed, when the live permission already names the recipient, or when the assembly is not exactly one added identity ARN", () => {
    let s = setup();
    try { writeFileSync(join(s.st, "api"), JSON.stringify(OFF[API])); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toMatch(/does not exist: stage 4 must be deployed first/); expect(changes(s)).toEqual([]); } finally { done(s); }
    s = setup();
    try { writeFileSync(join(s.st, "api"), JSON.stringify(REC[API])); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toMatch(/already names the recipient identity/); expect(changes(s)).toEqual([]); } finally { done(s); }
    s = setup();
    try { const t = JSON.parse(readFileSync(join(s.dir, "on", `${API}.template.json`), "utf8")); t.Resources.SneakyQueue = { Type: "AWS::SQS::Queue", Properties: {} }; writeFileSync(join(s.dir, "on", `${API}.template.json`), JSON.stringify(t));
      const r = run(s); expect(r.status).toBe(2); expect(r.stdout).toContain("EXPECTED-ONLY: NO (identity)"); expect(r.stderr).toContain("not exactly one added identity ARN"); expect(changes(s)).toEqual([]); expect(gitClean(s)).toBe(true); } finally { done(s); }
  }, 120000);

  it("happy path: SES checks, both assemblies gated, ONLY the API stack deployed (NetworkEgress untouched), the allow-list still refuses another address without sending, nothing sent", () => {
    const s = setup();
    try {
      const r = run(s);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("EXPECTED-ONLY: YES (email, same)"); expect(r.stdout).toContain("EXPECTED-ONLY: YES (email, identity)"); expect(r.stdout).toContain("EXPECTED-ONLY: YES (email, post)");
      expect(r.stdout).toContain("PASS another address is refused by the allow-list (nothing sent)"); expect(r.stdout).toContain("RT2 STAGE 5 COMPLETE (TEST)");
      expect(changes(s)).toEqual([`deploy on ${API}`]);
      const c = calls(s).split("\n"); const idx = (re: RegExp) => c.findIndex((l) => re.test(l));
      const order = [idx(/sesv2 get-email-identity --email-identity ogevia.com/), idx(/^synth off/), idx(/^synth on/), idx(new RegExp(`^deploy on ${API}`)), idx(/lambda invoke/)];
      expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(calls(s)).not.toMatch(/ledger|rds create|s3 sync|s3 cp|cloudfront|ses send|sesv2 send|Ogevia-prd-Service|get-secret-value/);
      expect(gitClean(s)).toBe(true); expect(readFileSync(join(s.repo, "infra/aws/lib/config.ts"), "utf8")).not.toContain("recipientIdentityArns");
    } finally { done(s); }
  }, 120000);

  it("a function that does NOT refuse another address stops the run and says to roll back", () => {
    const s = setup();
    try { flag(s, "allowlist-broken"); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("the allow-list did not refuse another address"); } finally { done(s); }
  }, 120000);

  it("rollback redeploys the saved stage-4 assembly to the API stack only and checks it against the assembly", () => {
    const s = setup();
    try {
      let r = run(s); expect(r.status, r.stderr + r.stdout).toBe(0);
      r = run(s, { OGEVIA_NO_CONFIRM: "0" }, "rollback"); expect(r.status).not.toBe(0);   // no terminal: the typed confirmation is required
      r = run(s, {}, "rollback"); expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("EXPECTED-ONLY: YES (email, post)"); expect(r.stdout).toContain("ROLLBACK-EMAIL-IDENTITY OK");
      expect(changes(s)).toEqual([`deploy on ${API}`, `deploy off ${API}`]);
    } finally { done(s); }
  }, 120000);
});
