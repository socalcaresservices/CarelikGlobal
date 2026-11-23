// TEST_H2C_ENABLE.sh (turns the request-cleanup switch on for TEST) with stand-in `aws`, `curl`, `pnpm` and database tools, in a throwaway git repository
// that contains the real infra/aws/lib/config.ts and the real pinned patch. Nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TCREL = "docs/releases/2026-11-20-test-plan/toolchain";
const PATCHREL = "docs/releases/2026-11-20-test-plan/TEST-requestCleanup-on.patch";
const script = join(root, TCREL, "TEST_H2C_ENABLE.sh");
const STACK = "Ogevia-prod-ServiceVerificationApi";
const NEW_ROUTES = ["POST /v1/care-notifications/read", "POST /v1/documents/{documentId}/cancel", "POST /v1/document-types/{documentTypeId}/retire"];

function template(extraRoutes: string[], extraResource = false) {
  const resources: Record<string, unknown> = { Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: "cdk-hnb659fds-assets-300094796789-us-west-2", S3Key: "new.zip" } }, Metadata: { "aws:asset:path": "asset.new" } } };
  for (let i = 0; i < 259; i += 1) resources[`R${i}`] = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: `GET /v1/r${i}` } };
  extraRoutes.forEach((k, i) => { resources[`N${i}`] = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: k } }; });
  if (extraResource) resources.Extra = { Type: "AWS::SQS::Queue", Properties: {} };
  return { Parameters: {}, Resources: resources };
}

function setup(over: { extraResource?: boolean; alreadyOn?: boolean; noH2b?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "h2c-"));
  const repo = join(dir, "repo"); const work = join(dir, "work"); const bin = join(dir, "bin"); const calls = join(dir, "calls"); const st = join(dir, "state");
  const tc = join(repo, TCREL);
  mkdirSync(tc, { recursive: true }); mkdirSync(join(repo, "infra/aws/lib"), { recursive: true }); mkdirSync(work); mkdirSync(bin); mkdirSync(st); writeFileSync(calls, "");
  copyFileSync(join(root, TCREL, "diff_gate_0109.py"), join(tc, "diff_gate_0109.py"));
  copyFileSync(join(root, "infra/aws/lib/config.ts"), join(repo, "infra/aws/lib/config.ts"));
  copyFileSync(join(root, PATCHREL), join(repo, PATCHREL));
  writeFileSync(join(tc, "TEST_DB_SESSION.sh"), `#!/usr/bin/env bash\n"$@"\n`);
  writeFileSync(join(tc, "TEST_0109_LEDGER.sh"), `#!/usr/bin/env bash\necho "ledger $1" >> ${JSON.stringify(calls)}\n`);
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").stdout.trim();
  const cap = join(work, "h2a-20261120T000000Z"); mkdirSync(join(cap, "deploy-off"), { recursive: true });
  const off = template([]); const on = template(NEW_ROUTES, over.extraResource);
  writeFileSync(join(cap, "release-commit.txt"), head + "\n"); writeFileSync(join(cap, "after-live.json"), JSON.stringify(off)); writeFileSync(join(cap, "lambda-after.json"), "{}");
  writeFileSync(join(cap, "deploy-off", `${STACK}.template.json`), JSON.stringify(off));
  writeFileSync(join(cap, "candidate-master-arn.txt"), "arn:x\n"); writeFileSync(join(cap, "qr-parameter-spec.json"), "{}"); writeFileSync(join(cap, "handler-tags.json"), "[]");
  writeFileSync(join(cap, "test-lambda.json"), JSON.stringify({ Database: { host: "h", name: "ogevia_sv_test", secretArn: "arn:x" } }));
  if (over.noH2b) rmSync(join(cap, "after-live.json"));
  writeFileSync(join(dir, "off.json"), JSON.stringify(off)); writeFileSync(join(dir, "on.json"), JSON.stringify(on));
  writeFileSync(join(st, "mode"), over.alreadyOn ? "on" : "off");
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "120"]): a = a[2:]
line = " ".join(a)
open(${JSON.stringify(calls)}, "a").write("aws " + line + "\\n")
mode = open(${JSON.stringify(join(st, "mode"))}).read().strip()
def out(x): print(x if isinstance(x, str) else json.dumps(x))
if "sts get-caller-identity" in line: out("300094796789")
elif "list-stack-resources" in line: out({"StackResourceSummaries": [{"ResourceType": "AWS::Lambda::Function", "LogicalResourceId": "Handler886CB40B", "PhysicalResourceId": "fn"}]})
elif "get-template" in line: out(open(${JSON.stringify(dir)} + "/" + mode + ".json").read())
elif "describe-stacks" in line and "StackStatus" in line: out("UPDATE_COMPLETE")
elif "describe-stacks" in line and "ApiUrl" in line: out("https://api.example")
elif "get-function-configuration" in line: out({"CodeSha256": "S", "Database": {"host": "h", "name": "ogevia_sv_test", "secretArn": "arn:x"}})
elif "lambda wait" in line: pass
else: sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
url="\${@: -1}"; mode=$(cat ${JSON.stringify(join(st, "mode"))})
case "$url" in
  */v1/me) echo -n 401;;
  */v1/care-notifications/read|*/cancel|*/retire) if [[ "$mode" == on ]]; then echo -n 401; else echo -n 404; fi;;
  *) echo "UNEXPECTED CURL: $url" >&2; exit 9;;
esac
`);
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash
cfg=${JSON.stringify(join(repo, "infra/aws/lib/config.ts"))}
if [[ "$*" == *"cdk synth"* ]]; then
  grep -q 'staffDuplicates: false, requestCleanup: true' "$cfg" || { echo "synth ran WITHOUT the patch" >&2; exit 7; }
  out=""; prev=""; for x in "$@"; do [[ "$prev" == "--output" ]] && out="$x"; prev="$x"; done; mkdir -p "$out"; cp ${JSON.stringify(join(dir, "on.json"))} "$out/${STACK}.template.json"; echo "synth" >> ${JSON.stringify(calls)}; exit 0
fi
if [[ "$*" == *"cdk deploy"* ]]; then
  echo "deploy $*" >> ${JSON.stringify(calls)}
  if [[ "$*" == *"deploy-on"* ]]; then echo on > ${JSON.stringify(join(st, "mode"))}; else echo off > ${JSON.stringify(join(st, "mode"))}; fi
  exit 0
fi
exit 9
`);
  for (const f of ["aws", "curl", "pnpm"]) chmodSync(join(bin, f), 0o755);
  return { dir, repo, work, bin, calls, head, st, cap };
}
type S = ReturnType<typeof setup>;
function run(s: S, env: Record<string, string> = {}, mode?: string) {
  return spawnSync("bash", [script, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, REPO: s.repo, WORK: s.work, OGEVIA_RELEASE_COMMIT: s.head, OGEVIA_DEPLOY_APPROVAL: "TEST-20261120-owner", OGEVIA_NO_CONFIRM: "1", ...env } });
}
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });
const calls = (s: S) => readFileSync(s.calls, "utf8");
const clean = (s: S) => spawnSync("git", ["-C", s.repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim() === "";

describe("TEST_H2C_ENABLE.sh", () => {
  it("refuses a different commit, a bad approval reference and missing H2b evidence before any change", () => {
    let s = setup();
    try {
      let r = run(s, { OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(2); expect(r.stderr).toContain("not at the release commit");
      r = run(s, { OGEVIA_DEPLOY_APPROVAL: "x y" }); expect(r.status).toBe(2);
      expect(calls(s)).not.toMatch(/deploy|synth/);
    } finally { done(s); }
    s = setup({ noH2b: true });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("H2b evidence is missing"); expect(calls(s)).not.toMatch(/deploy|synth/); } finally { done(s); }
  });

  it("stops if the switch is already on (the three routes do not answer 404), before any change", () => {
    const s = setup({ alreadyOn: true });
    try { const r = run(s); expect(r.status).toBe(2); expect(calls(s)).not.toMatch(/deploy|synth/); } finally { done(s); }
  });

  it("does not deploy when the assembly has any difference beyond the three routes, and always restores config.ts", () => {
    const s = setup({ extraResource: true });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stdout).toContain("EXPECTED-ONLY: NO"); expect(r.stderr).toContain("expected-only gate failed"); expect(calls(s)).not.toContain("deploy "); expect(clean(s)).toBe(true); } finally { done(s); }
  });

  it("happy path: database verified, patch applied only for the synthesis, gate --expect on, one-stack deploy, 262 routes, the three routes answer 401, database verified again, checkout restored", () => {
    const s = setup();
    try {
      const r = run(s);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      for (const t of ["no drift since H2b", "EXPECTED-ONLY: YES (on)", "routes added: 3", "EXPECTED-ONLY: YES (post)", "live routes: 262", "PASS Handler still targets ogevia_sv_test", "H2c COMPLETE (TEST)"]) expect(r.stdout, t).toContain(t);
      expect((r.stdout.match(/without a token \(switch ON\): 401/g) ?? []).length).toBe(3);
      expect(calls(s)).toContain("--exclusively " + STACK); expect(calls(s)).not.toMatch(/Ogevia-prd-|get-secret-value/);
      expect(calls(s).match(/ledger verify/g)?.length).toBe(2);
      expect(clean(s)).toBe(true);
    } finally { done(s); }
  }, 60000);

  it("rollback-switch redeploys the saved OFF assembly and checks the three routes are 404 again", () => {
    const s = setup({ alreadyOn: true });
    try {
      const r = run(s, {}, "rollback-switch");
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("EXPECTED-ONLY: YES (post)"); expect(r.stdout).toContain("ROLLBACK-SWITCH OK"); expect(calls(s)).toContain("deploy-off");
    } finally { done(s); }
  });
});
