// TEST_R2_N8_SWITCH.sh (Release 2, TEST stage 8: ONE of homeLabels / authorizationWorklist / signatureEmail per run; the database is NOT changed) with stand-in `aws`, `curl`, `pnpm` and database tools, in a throwaway git repository.
// The stand-in `cdk synth` reads the (temporarily edited) config.ts, so the test proves the script turns on exactly the chosen switch, keeps the earlier switches and the email configuration, gates both assemblies with the real diff_gate_rt2.py,
// deploys only after both gates pass, never changes the database, and restores the config.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TCREL = "docs/releases/2026-11-20-test-plan/toolchain";
const script = join(root, TCREL, "TEST_R2_N8_SWITCH.sh");
const STACK = "Ogevia-prod-ServiceVerificationApi";
const OLDSHA = createHash("sha256").update("zip").digest("base64");
const FEATURES = "    features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },\n";

function setup(on: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "rt2n7-"));
  const repo = join(dir, "repo"); const work = join(dir, "work"); const bin = join(dir, "bin"); const calls = join(dir, "calls"); const st = join(dir, "state");
  const tc = join(repo, TCREL);
  for (const d of [tc, work, bin, st, join(repo, "infra/aws/lib"), join(repo, "infra/aws/node_modules/.bin"), join(repo, "infra/aws/scripts")]) mkdirSync(d, { recursive: true });
  writeFileSync(calls, ""); writeFileSync(join(repo, "infra/aws/lib/config.ts"), `const PROD = {\n${FEATURES}};\n`); writeFileSync(join(repo, "infra/aws/node_modules/.bin/cdk"), ""); chmodSync(join(repo, "infra/aws/node_modules/.bin/cdk"), 0o755);
  copyFileSync(join(root, TCREL, "diff_gate_rt2.py"), join(tc, "diff_gate_rt2.py"));
  writeFileSync(join(tc, "VERIFY_PENDING.sql"), "select 1;\n");
  writeFileSync(join(tc, "TEST_DB_SESSION.sh"), `#!/usr/bin/env bash\n"$@"\n`);
  // like the real tool: 0118 needs 0117 recorded (so it cannot be probed before 0117 is applied), and apply/rollback keep that state
  writeFileSync(join(tc, "TEST_PENDING_LEDGER.sh"), `#!/usr/bin/env bash\necho "ledger $1 $2" >> ${JSON.stringify(calls)}\nif [[ -f ${JSON.stringify(join(st, "fail-ledger"))} ]]; then exit 2; fi\n`);
  writeFileSync(join(repo, "infra/aws/scripts/deploy-test-slice.sh"), `#!/usr/bin/env bash\necho "web version=\${VITE_APP_VERSION:-none}" >> ${JSON.stringify(calls)}\nmkdir -p "$(dirname "$0")/../../../apps/web/dist-aws"; cp ${JSON.stringify(join(dir, "built-index.html"))} "$(dirname "$0")/../../../apps/web/dist-aws/index.html"\n`);
  for (const f of ["TEST_PENDING_LEDGER.sh", "TEST_DB_SESSION.sh"]) chmodSync(join(tc, f), 0o755);
  chmodSync(join(repo, "infra/aws/scripts/deploy-test-slice.sh"), 0o755);
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(dir, "built-index.html"), `<html><script src="/assets/index-abc.js"></script></html>`);
  writeFileSync(join(dir, "main.js"), `x={VITE_APP_VERSION:"${head}",VITE_APP_ENV:"test"}`);
  writeFileSync(join(dir, "web.json"), '{"c":1}');
  writeFileSync(join(dir, "mk.py"), `import json, sys
S1 = ["GET /v1/cover-notification-history", "GET /v1/cover-notification-settings", "GET /v1/cover-office-audiences", "GET /v1/notification-center", "GET /v1/notification-preferences",
      "POST /v1/cover-notification-settings", "POST /v1/notification-center/mark", "POST /v1/notification-preferences", "POST /v1/offices/{officeId}/cover-audience", "POST /v1/shifts/{shiftId}/notify-cover"]
S7 = ["GET /v1/readiness-overrides", "POST /v1/caregivers/{caregiverRecordId}/readiness-override", "POST /v1/readiness-overrides/{overrideId}/revoke"]
S2 = ["GET /v1/sms-settings", "POST /v1/sms-settings", "GET /v1/my-sms", "POST /v1/my-sms", "GET /v1/sms-oncall", "POST /v1/sms-oncall", "GET /v1/sms-history",
      "GET /v1/clients/{clientId}/service-location", "POST /v1/clients/{clientId}/service-location"]
SW = {"homeLabels": ["GET /v1/clients/{clientId}/service-locations", "POST /v1/clients/{clientId}/service-locations", "POST /v1/services/{serviceId}/location-rule", "POST /v1/shifts/{shiftId}/location-override", "GET /v1/shifts/{shiftId}/expected-locations", "GET /v1/verification-settings", "POST /v1/verification-settings", "GET /v1/home-labels", "POST /v1/home-labels", "POST /v1/home-labels/assign", "POST /v1/home-labels/resolve", "POST /v1/home-labels/{labelId}/deactivate", "POST /v1/home-labels/{labelId}/replace", "POST /v1/home-labels/{labelId}/link", "GET /v1/home-labels/{labelId}/history", "POST /v1/label-punch/preview", "POST /v1/label-punch", "POST /v1/visit-punch", "POST /v1/visits/{visitId}/signature-session", "POST /v1/visits/{visitId}/sign", "POST /v1/visits/{visitId}/sign-later", "POST /v1/visits/{visitId}/signature-followup/owner", "POST /v1/visits/{visitId}/signature-followup/delivery", "GET /v1/visit-exceptions", "POST /v1/visit-exceptions/{exceptionId}/resolve", "GET /v1/visit-exceptions/{exceptionId}/history", "POST /v1/visits/{visitId}/punch-corrections", "POST /v1/punch-corrections/{requestId}/decide", "GET /v1/verification-reports/{report}"], "authorizationWorklist": ["GET /v1/authorization-worklist"], "signatureEmail": ["POST /v1/visits/{visitId}/signature-link-email"]}
def build(switches, key, extra=False):
    env = {"DB_NAME": "ogevia_sv_test", "COVER_ALERT_ADDRESS_RULES": "on", "SMS_MODE": "mock", "SERVICE_LOCATION": "on", "EMAIL_FUNCTION_NAME": "Ogevia-prod-NotificationEmail"}
    r = {"Handler886CB40B": {"Type": "AWS::Lambda::Function", "Properties": {"Code": {"S3Bucket": "cdk-hnb659fds-assets-300094796789-us-west-2", "S3Key": key}, "Environment": {"Variables": env}}, "Metadata": {"aws:asset:path": "asset." + key}},
         "IdentityHandlerAB": {"Type": "AWS::Lambda::Function", "Properties": {"Code": {"S3Bucket": "cdk-hnb659fds-assets-300094796789-us-west-2", "S3Key": "id-" + key}}, "Metadata": {"aws:asset:path": "asset.id-" + key}}}
    keys = ["GET /v1/r%d" % i for i in range(270)] + S1 + S2 + S7 + [k for s in switches for k in SW[s]]
    for i, k in enumerate(keys): r["R%d" % i] = {"Type": "AWS::ApiGatewayV2::Route", "Properties": {"RouteKey": k}}
    r["NotifySweepRule"] = {"Type": "AWS::Events::Rule", "Properties": {"ScheduleExpression": "rate(5 minutes)"}}
    r["NotifySweepAllowEventRuleOgeviaprodX"] = {"Type": "AWS::Lambda::Permission", "Properties": {}}
    if extra: r["Extra"] = {"Type": "AWS::SQS::Queue", "Properties": {}}
    return {"Parameters": {"ClientQrEncryptionKey": {"Type": "String", "NoEcho": True, "Default": ""}}, "Resources": r}
if __name__ == "__main__":
    sw = [x for x in sys.argv[1].split(",") if x and x != "-"]
    json.dump(build(sw, sys.argv[2], sys.argv[3] == "1"), open(sys.argv[4], "w"))
`);
  spawnSync("python3", [join(dir, "mk.py"), on.length ? on.join(",") : "-", "old.zip", "0", join(st, "live.json")]);
  writeFileSync(join(st, "sha"), OLDSHA);
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import json, sys, os
a = sys.argv[1:]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "120"]): a = a[2:]
line = " ".join(a)
open(${JSON.stringify(calls)}, "a").write("aws " + line + "\\n")
st = ${JSON.stringify(st)}
def out(x): print(x if isinstance(x, str) else json.dumps(x))
sha = open(st + "/sha").read()
if "sts get-caller-identity" in line: out("300094796789")
elif "list-stack-resources" in line: out({"StackResourceSummaries": [{"ResourceType": "AWS::Lambda::Function", "LogicalResourceId": "Handler886CB40B", "PhysicalResourceId": "fn"}]})
elif "get-template" in line: out(open(st + "/live.json").read())
elif "rds describe-db-instances" in line: out("arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-x")
elif "lambda get-function-configuration" in line and "--query CodeSha256" in line: out(sha)
elif "lambda get-function-configuration" in line and "--query Environment.Variables " not in line: out({"FunctionName": "fn", "CodeSha256": sha, "Database": {"host": "ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com", "name": "ogevia_sv_test", "secretArn": "arn:x"}})
elif "lambda get-function " in line and "NotificationEmail" not in line: out("https://zip.example/code")
elif "lambda wait" in line: pass
elif "events list-rules" in line: out("Ogevia-prod-NotifySweep")
elif "rds create-db-snapshot" in line:
    if os.path.exists(st + "/fail-snapshot"): sys.exit(1)
    out("creating")
elif "rds describe-db-snapshots" in line:
    if os.path.exists(st + "/snapshot-creating"): sys.exit(0) if False else out("creating")
    elif "DBInstanceIdentifier" in line: out("ogevia-prod" if os.path.exists(st + "/wrong-instance") else "ogevia-postgres")
    else: out("available")
elif "lambda get-function-configuration" in line and "--query Environment.Variables " in line: out({"DB_NAME": "ogevia_sv_test", "COVER_ALERT_ADDRESS_RULES": "on", "SMS_MODE": "mock", "SERVICE_LOCATION": "on", "EMAIL_FUNCTION_NAME": "Ogevia-prod-NotificationEmail"})
elif "lambda get-function --function-name Ogevia-prod-NotificationEmail" in line: out("{}")
elif "s3 sync s3://" in line:
    d = a[3]; os.makedirs(d, exist_ok=True); open(d + "/index.html", "w").write("old"); open(d + "/config.json", "w").write(open(${JSON.stringify(join(dir, "web.json"))}).read())
elif "s3 sync" in line or "s3 cp" in line or "cloudfront create-invalidation" in line: pass
elif "update-function-code" in line: open(st + "/sha", "w").write(${JSON.stringify(OLDSHA)}); out("Successful")
elif "describe-stacks" in line and "StackStatus" in line: out("UPDATE_COMPLETE")
elif "describe-stacks" in line and "ApiUrl" in line: out("https://api.example")
elif "describe-stacks" in line and "WebOrigin" in line: out("https://site.example")
elif "describe-stacks" in line and "SiteBucketName" in line: out("prd-bucket" if "Ogevia-prd" in line else "test-bucket")
elif "describe-stacks" in line and "DistributionId" in line: out("PRDDIST" if "Ogevia-prd" in line else "DISTTEST")
else: sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
args="$*"; out=""; prev=""; for x in "$@"; do [[ "$prev" == "-o" ]] && out="$x"; prev="$x"; done
url=""; for x in "$@"; do [[ "$x" == http* ]] && url="$x"; done
has() { grep -q "$1" ${JSON.stringify(join(st, "live.json"))}; }
case "$url" in
  https://zip.example/code) [[ -n "$out" ]] && printf zip > "$out";;
  */v1/me) echo -n 401;;
  */v1/home-labels|*/v1/verification-settings|*/v1/visit-exceptions|*/label-punch/preview|*/v1/label-punch|*/signature-session) if has "/v1/home-labels"; then echo -n 401; else echo -n 404; fi;;
  */v1/authorization-worklist) if has "/v1/authorization-worklist"; then echo -n 401; else echo -n 404; fi;;
  */signature-link-email) if has "signature-link-email"; then echo -n 401; else echo -n 404; fi;;
  */index.html) if [[ -n "$out" ]]; then cp ${JSON.stringify(join(dir, "built-index.html"))} "$out"; fi;;
  */assets/index-abc.js) cat ${JSON.stringify(join(dir, "main.js"))};;
  */config.json) cat ${JSON.stringify(join(dir, "web.json"))};;
  *) echo "UNEXPECTED CURL: $args" >&2; exit 9;;
esac
`);
  writeFileSync(join(bin, "corepack"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash
[[ "$1" == "--version" ]] && { echo 9.15.4; exit 0; }
if [[ "$*" == *"cdk synth"* ]]; then out=""; prev=""; for x in "$@"; do [[ "$prev" == "--output" ]] && out="$x"; prev="$x"; done
  cfg="$(cat "$PWD/infra/aws/lib/config.ts")"; extra=0; sws=""
  for x in homeLabels authorizationWorklist signatureEmail; do [[ "$cfg" == *"$x: true"* ]] && sws="$sws,$x"; done
  [[ "$cfg" == *"assignmentHistory: true"* && "$cfg" == *"notifications: true"* && "$cfg" == *"openShiftSms: true"* && "$cfg" == *"serviceLocation: true"* && "$cfg" == *"readinessOverrides: true"* ]] || { echo "the earlier switches were not kept ON" >&2; exit 7; }
  [[ "$cfg" == *"notificationEmail:"* && "$cfg" == *"allowedRecipients: ["* ]] || { echo "the email configuration was not kept" >&2; exit 7; }
  [[ -f ${JSON.stringify(join(st, "extra"))} && -n "$sws" ]] && extra=1
  mkdir -p "$out"; python3 ${JSON.stringify(join(dir, "mk.py"))} "\${sws:-,}" new.zip $extra "$out/${STACK}.template.json"; echo "synth sw=\${sws#,}" >> ${JSON.stringify(calls)}; exit 0; fi
if [[ "$*" == *"cdk deploy"* ]]; then app=""; prev=""; for x in "$@"; do [[ "$prev" == "--app" ]] && app="$x"; prev="$x"; done
  echo "deploy $app" >> ${JSON.stringify(calls)}; cp "$app/${STACK}.template.json" ${JSON.stringify(join(st, "live.json"))}; printf NEWSHA > ${JSON.stringify(join(st, "sha"))}; exit 0; fi
exit 9
`);
  for (const f of ["aws", "curl", "pnpm", "corepack"]) chmodSync(join(bin, f), 0o755);
  return { dir, repo, work, bin, calls, head, st };
}
type S = ReturnType<typeof setup>;
function run(s: S, env: Record<string, string> = {}, mode?: string) {
  return spawnSync("bash", [script, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, REPO: s.repo, WORK: s.work, OGEVIA_RELEASE_COMMIT: s.head, OGEVIA_SWITCH: "homeLabels", OGEVIA_DEPLOY_APPROVAL: "RT2-TEST-20261123", OGEVIA_APP_BASE: s.head, OGEVIA_EXTRA_RECIPIENT: "caregiver.test@example.invalid", OGEVIA_SNAPSHOT_SLEEP: "0", OGEVIA_SNAPSHOT_POLLS: "3", OGEVIA_NO_CONFIRM: "1", OGEVIA_CF_WAIT: "0", ...env } });
}
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });
const calls = (s: S) => readFileSync(s.calls, "utf8");
const changes = (s: S) => calls(s).split("\n").filter((l) => /^(deploy|web |ledger apply|ledger rollback)/.test(l) || /aws (rds create-db-snapshot)/.test(l) || /aws (s3 sync [^s]|s3 cp|cloudfront|lambda update)/.test(l));
const gitClean = (s: S) => spawnSync("git", ["-C", s.repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim() === "";


describe("TEST_R2_N8_SWITCH.sh", () => {
  it("refuses a different commit, a bad approval reference, an unknown switch, a bad earlier-switch list, modified tracked files and application files that differ from the audited commit, before anything else", () => {
    const s = setup();
    try {
      let r = run(s, { OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(2); expect(r.stderr).toContain("not at the release commit");
      r = run(s, { OGEVIA_DEPLOY_APPROVAL: "x y" }); expect(r.status).toBe(2); expect(r.stderr).toContain("OGEVIA_DEPLOY_APPROVAL must be");
      r = run(s, { OGEVIA_SWITCH: "everything" }); expect(r.status).toBe(2); expect(r.stderr).toContain("OGEVIA_SWITCH must be");
      r = run(s, { OGEVIA_SWITCHES_ON: "homeLabels" }); expect(r.status).toBe(2); expect(r.stderr).toContain("may list only the OTHER");
      r = run(s, { OGEVIA_SWITCHES_ON: "bogus" }); expect(r.status).toBe(2);
      mkdirSync(join(s.repo, "apps/web"), { recursive: true }); writeFileSync(join(s.repo, "apps/web/x.ts"), "export const x = 1;\n");
      const git = (...a: string[]) => spawnSync("git", ["-C", s.repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
      git("add", "-A"); git("commit", "-q", "-m", "app change"); const appHead = git("rev-parse", "HEAD").stdout.trim();
      r = run(s, { OGEVIA_RELEASE_COMMIT: appHead }); expect(r.status).toBe(2); expect(r.stderr).toContain("differ from the audited commit");
      writeFileSync(join(s.repo, TCREL, "diff_gate_rt2.py"), "# changed\n");
      r = run(s, { OGEVIA_RELEASE_COMMIT: appHead }); expect(r.status).toBe(2); expect(r.stderr).toContain("tracked files in the checkout are modified");
      expect(changes(s)).toEqual([]);
    } finally { done(s); }
  });

  it("stops before any change when a migration is not applied and verified, when the switch's routes already exist, or when a gate is violated", () => {
    let s = setup();
    try { writeFileSync(join(s.st, "fail-ledger"), ""); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("is not applied and verified in TEST"); expect(changes(s)).toEqual([]); expect(gitClean(s)).toBe(true); } finally { done(s); }
    s = setup(["homeLabels"]);
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("the homeLabels routes must not exist yet"); expect(changes(s)).toEqual([]); } finally { done(s); }
    s = setup();
    try { writeFileSync(join(s.st, "extra"), ""); const r = run(s); expect(r.status).toBe(2); expect(r.stdout).toContain("EXPECTED-ONLY: NO"); expect(r.stderr).toContain("not exactly this stage"); expect(changes(s)).toEqual([]); expect(gitClean(s)).toBe(true); } finally { done(s); }
  }, 90000);

  const CASES: Array<{ sw: string; stage: string; routes: number; before: string[]; migs: string[] }> = [
    { sw: "homeLabels", stage: "stage8a", routes: 29, before: [], migs: ["0123", "0124"] },
    { sw: "authorizationWorklist", stage: "stage8b", routes: 1, before: ["homeLabels"], migs: ["0123", "0125"] },
    { sw: "signatureEmail", stage: "stage8c", routes: 1, before: ["homeLabels", "authorizationWorklist"], migs: ["0123", "0124"] },
  ];
  for (const c of CASES) {
    it(`happy path for ${c.sw}: only its ${c.routes} route(s) are added, the database is read but never changed, the earlier switches and the email function stay, deploy then web, config restored`, () => {
      const s = setup(c.before);
      try {
        const r = run(s, { OGEVIA_SWITCH: c.sw, OGEVIA_SWITCHES_ON: c.before.join(",") });
        expect(r.status, r.stderr + r.stdout).toBe(0);
        expect(r.stdout).toContain(`EXPECTED-ONLY: YES (${c.stage}, off)`); expect(r.stdout).toContain(`EXPECTED-ONLY: YES (${c.stage}, on)`);
        const total = 270 + 10 + 9 + 3 + c.before.reduce((n, x) => n + (x === "homeLabels" ? 29 : 1), 0) + c.routes;
        expect(r.stdout).toContain(`PASS ${total} routes live`);
        expect(r.stdout).toContain("PASS Handler still has SMS_MODE=mock and SERVICE_LOCATION=on"); expect(r.stdout).toContain("PASS the NotificationEmail function is still there");
        expect(r.stdout).toContain("PASS the bundle carries commit " + s.head); expect(r.stdout).toContain("RELEASE 2 STAGE 8 COMPLETE (TEST)"); expect(r.stdout).toContain("The database was not changed by this script");
        const cl = calls(s).split("\n");
        for (const m of c.migs) expect(cl, m).toContain(`ledger verify ${m}`);
        expect(cl.some((l) => /^ledger (apply|rollback)/.test(l))).toBe(false);
        expect(cl.some((l) => /rds create-db-snapshot/.test(l))).toBe(false);
        const idx = (re: RegExp) => cl.findIndex((l) => re.test(l));
        const order = [idx(/^ledger verify 0123/), idx(/^synth sw=/), idx(/^deploy .*deploy-on/), idx(/^web version=/)];
        expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(calls(s)).toMatch(new RegExp(`synth sw=${[...c.before, c.sw].filter(Boolean).join(",")}`));
        expect(calls(s)).not.toMatch(/Ogevia-prd-Service|get-secret-value|delete-db/);
        expect(gitClean(s)).toBe(true); expect(readFileSync(join(s.repo, "infra/aws/lib/config.ts"), "utf8")).not.toContain(c.sw);
      } finally { done(s); }
    }, 120000);
  }

  it("rollbacks: web restores the captured files, routes redeploys the switch-OFF assembly (404 again), api restores the ZIP; there is no database rollback in this stage", () => {
    const s = setup();
    try {
      let r = run(s); expect(r.status, r.stderr + r.stdout).toBe(0);
      r = run(s, { OGEVIA_NO_CONFIRM: "0" }, "rollback-api"); expect(r.status).not.toBe(0);
      r = run(s, {}, "rollback-web"); expect(r.status, r.stderr).toBe(0); expect(calls(s)).toMatch(/s3 sync .*web-before\/assets s3:\/\/test-bucket\/assets/);
      r = run(s, {}, "rollback-routes"); expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("ROLLBACK-ROUTES OK"); expect(calls(s)).toMatch(/deploy .*deploy-off/);
      r = run(s, {}, "rollback-api"); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("ROLLBACK-API OK");
      r = run(s, {}, "rollback-db"); expect(r.status).toBe(2); expect(r.stderr).toContain("usage");
      expect(calls(s).split("\n").some((l) => /^ledger (apply|rollback)/.test(l))).toBe(false);
    } finally { done(s); }
  }, 150000);
});
