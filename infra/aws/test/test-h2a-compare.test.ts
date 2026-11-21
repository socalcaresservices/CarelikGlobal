// TEST_H2A_COMPARE.sh (read-only comparison) with a stand-in `aws`, `curl`, `pnpm` and `corepack`, in a throwaway git repository. Nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TCREL = "docs/releases/2026-11-20-test-plan/toolchain";
const script = join(root, TCREL, "TEST_H2A_COMPARE.sh");
const TEST_HOST = "ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com";

function liveTemplate(routes: number) {
  const resources: Record<string, unknown> = {
    Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: "cdk-hnb659fds-assets-300094796789-us-west-2", S3Key: "old.zip" }, Tags: [{ Key: "environment", Value: "prod" }], Environment: { Variables: { DB_NAME: "ogevia_sv_test" } } }, Metadata: { "aws:asset:path": "asset.old" } },
  };
  for (let i = 0; i < routes; i += 1) resources[`R${i}`] = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: `GET /v1/r${i}` } };
  return { Parameters: { ClientQrEncryptionKey: { Type: "String", NoEcho: true, Default: "" } }, Resources: resources };
}

function setup(over: { account?: string; testWeb?: string; prdWeb?: string; dbName?: string; candidateRoutes?: number; candidateExtra?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "h2a-"));
  const repo = join(dir, "repo"); const work = join(dir, "work"); const bin = join(dir, "bin"); const calls = join(dir, "calls");
  mkdirSync(join(repo, TCREL), { recursive: true }); mkdirSync(work); mkdirSync(bin); writeFileSync(calls, "");
  copyFileSync(join(root, TCREL, "diff_gate_0109.py"), join(repo, TCREL, "diff_gate_0109.py"));
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").stdout.trim();
  mkdirSync(join(repo, "infra/aws/node_modules/.bin"), { recursive: true });   // untracked: the script only checks that the CDK CLI is installed
  writeFileSync(join(repo, "infra/aws/node_modules/.bin/cdk"), "#!/bin/sh\n"); chmodSync(join(repo, "infra/aws/node_modules/.bin/cdk"), 0o755);
  const live = liveTemplate(259);
  writeFileSync(join(dir, "live.json"), JSON.stringify(live));   // `aws ... --query TemplateBody` prints the template body itself
  const candidate = structuredClone(live) as any;
  candidate.Resources.Handler886CB40B.Properties.Code.S3Key = "new.zip"; candidate.Resources.Handler886CB40B.Metadata = { "aws:asset:path": "asset.new" };
  if (over.candidateExtra) candidate.Resources.Extra = { Type: "AWS::SQS::Queue", Properties: {} };
  for (let i = 259; i < (over.candidateRoutes ?? 259); i += 1) candidate.Resources[`R${i}`] = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: `GET /v1/r${i}` } };
  writeFileSync(join(dir, "candidate.json"), JSON.stringify(candidate));
  // the live Handler code ZIP and the matching CodeSha256
  const mk = spawnSync("python3", ["-c", `import zipfile,hashlib,base64,json,sys\nz=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('index.js','console.log(1)'); z.close()\nprint(base64.b64encode(hashlib.sha256(open(sys.argv[1],'rb').read()).digest()).decode())`, join(dir, "code.zip")], { encoding: "utf8" });
  const codeSha = mk.stdout.trim();
  writeFileSync(join(dir, "answers.json"), JSON.stringify({ account: over.account ?? "300094796789", testWeb: over.testWeb ?? "test-bucket", prdWeb: over.prdWeb ?? "prd-bucket", dbName: over.dbName ?? "ogevia_sv_test", codeSha }));
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import json, sys, os
a = sys.argv[1:]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "60"]): a = a[2:]
line = " ".join(a)
open(${JSON.stringify(calls)}, "a").write(line + "\\n")
ans = json.load(open(${JSON.stringify(join(dir, "answers.json"))}))
def out(x): print(x if isinstance(x, str) else json.dumps(x))
if "sts get-caller-identity" in line: out(ans["account"])
elif "describe-stacks" in line and "--stack-name Ogevia-prod-WebHosting" in line: out(ans["testWeb"] if "SiteBucketName" in line else "DISTTEST")
elif "describe-stacks" in line and "--stack-name Ogevia-prd-WebHosting" in line: out(ans["prdWeb"] if "SiteBucketName" in line else "DISTPRD")
elif "describe-stacks" in line: out({"Stacks": [{"StackName": "s", "StackStatus": "UPDATE_COMPLETE", "Parameters": [{"ParameterKey": "ClientQrEncryptionKey"}]}]})
elif "rds describe-db-instances" in line: out("arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-11111111-2222-3333-4444-555555555555-AbCdEf")
elif "get-template" in line: out(open(${JSON.stringify(join(dir, "live.json"))}).read())
elif "list-stack-resources" in line: out({"StackResourceSummaries": [{"ResourceType": "AWS::Lambda::Function", "LogicalResourceId": "Handler886CB40B", "PhysicalResourceId": "fn"}]})
elif "get-function-configuration" in line: out({"FunctionName": "fn", "CodeSha256": ans["codeSha"], "Database": {"host": ${JSON.stringify(TEST_HOST)}, "name": ans["dbName"], "secretArn": "arn:x"}})
elif "lambda get-function " in line: out("https://example.invalid/code.zip")
elif "s3 sync" in line: os.makedirs(a[a.index("sync") + 2], exist_ok=True); open(os.path.join(a[a.index("sync") + 2], "index.html"), "w").write("x")
else: sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nout=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && out="$2"; shift; done; cp ${JSON.stringify(join(dir, "code.zip"))} "$out"\n`);
  writeFileSync(join(bin, "corepack"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo 9.15.4; exit 0; fi
if [[ "$*" == *"cdk synth"* ]]; then out=""; prev=""; for x in "$@"; do [[ "$prev" == "--output" ]] && out="$x"; prev="$x"; done; mkdir -p "$out"; cp ${JSON.stringify(join(dir, "candidate.json"))} "$out/Ogevia-prod-ServiceVerificationApi.template.json"; echo "$*" >> ${JSON.stringify(join(dir, "synth-args"))}; exit 0; fi
exit 0
`);
  for (const f of ["aws", "curl", "corepack", "pnpm"]) chmodSync(join(bin, f), 0o755);
  return { dir, repo, work, bin, calls, head };
}
function run(s: ReturnType<typeof setup>, env: Record<string, string> = {}) {
  return spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, REPO: s.repo, WORK: s.work, OGEVIA_RELEASE_COMMIT: s.head, ...env } });
}
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });

describe("TEST_H2A_COMPARE.sh", () => {
  it("refuses a different commit, modified tracked files and the wrong account before any capture", () => {
    let s = setup();
    try {
      let r = run(s, { OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(2); expect(r.stderr).toContain("not at the release commit");
      writeFileSync(join(s.repo, TCREL, "diff_gate_0109.py"), "# changed\n");
      r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("tracked files in the checkout are modified");
    } finally { done(s); }
    s = setup({ account: "111111111111" });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("wrong AWS account"); expect(readFileSync(s.calls, "utf8").trim().split("\n")).toHaveLength(1); } finally { done(s); }
  });

  it("stops when the TEST web targets are shared with production, or the live Handler does not use the isolated database, before the live template is read for use", () => {
    let s = setup({ testWeb: "same", prdWeb: "same" });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("shared with production"); expect(readFileSync(s.calls, "utf8")).not.toContain("get-template"); } finally { done(s); }
    s = setup({ dbName: "ogevia_prd" });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("does not target the isolated TEST database"); } finally { done(s); }
  });

  it("passes when only the Handler code asset differs: captures the rollback ZIP and web files, synthesizes with the live context, runs the gate, and makes no change calls", () => {
    const s = setup();
    try {
      const r = run(s);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("candidate routes: 259"); expect(r.stdout).toContain("EXPECTED-ONLY: YES (off)"); expect(r.stdout).toContain("COMPARISON PASSED: NOTHING DEPLOYED");
      const cap = /CAPTURE: (\S+)/.exec(r.stdout)![1]!;
      for (const f of ["live-api.template.json", "test-lambda.zip", "qr-parameter-spec.json", "handler-tags.json", "gate-off.txt", "SHA256SUMS", "web-before/index.html"]) expect(existsSync(join(cap, f)), f).toBe(true);
      const calls = readFileSync(s.calls, "utf8");
      for (const line of calls.trim().split("\n")) expect(line).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda (get-function|get-function-configuration)|rds describe-db-instances|s3 sync s3:\/\/\S+ \S+ --only-show-errors)/);
      expect(calls).not.toMatch(/get-secret-value|put-|delete|update-|deploy|cp |rm /);
      const args = readFileSync(join(s.dir, "synth-args"), "utf8");
      for (const part of ["-c env=prod", "-c mode=plan", "liveTestBaseline=0102", "liveQrParameterSpec=", "liveTestHandlerTags=", "testDatabase=isolated", "testMasterSecretArn=arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-"]) expect(args).toContain(part);
    } finally { done(s); }
  }, 60000);

  it("fails closed when the candidate differs in anything else (an extra resource) or has the wrong route count; the capture is kept", () => {
    let s = setup({ candidateExtra: true });
    try { const r = run(s); expect(r.status).toBe(1); expect(r.stdout).toContain("EXPECTED-ONLY: NO"); expect(r.stdout).toContain("UNEXPECTED added resource Extra"); expect(r.stdout).toContain("Nothing was deployed"); expect(r.stdout).toContain("CAPTURE KEPT"); expect(r.stdout).not.toContain("COMPARISON PASSED"); } finally { done(s); }
    s = setup({ candidateRoutes: 262 });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("does not have 259 routes"); } finally { done(s); }
  }, 60000);

  it("refuses a capture directory that already has files", () => {
    const s = setup();
    try { const d = join(s.work, "taken"); mkdirSync(d); writeFileSync(join(d, "x"), "x"); const r = run(s, { OGEVIA_H2A_DIR: d }); expect(r.status).toBe(2); expect(r.stderr).toContain("new empty capture directory"); } finally { done(s); }
    void dirname;
  });
});
