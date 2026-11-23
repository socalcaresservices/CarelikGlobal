// TEST_H2B_DEPLOY.sh (TEST deployment, switch OFF) with stand-in `aws`, `curl`, `pnpm` and TEST database tools, in a throwaway git repository. Nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TCREL = "docs/releases/2026-11-20-test-plan/toolchain";
const script = join(root, TCREL, "TEST_H2B_DEPLOY.sh");
const STACK = "Ogevia-prod-ServiceVerificationApi";

function template(routes: number, key: string, extra = false) {
  const resources: Record<string, unknown> = {
    Handler886CB40B: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: "cdk-hnb659fds-assets-300094796789-us-west-2", S3Key: key }, Environment: { Variables: { DB_NAME: "ogevia_sv_test" } } }, Metadata: { "aws:asset:path": "asset." + key } },
  };
  for (let i = 0; i < routes; i += 1) resources[`R${i}`] = { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: `GET /v1/r${i}` } };
  if (extra) resources.Extra = { Type: "AWS::SQS::Queue", Properties: {} };
  return { Parameters: { ClientQrEncryptionKey: { Type: "String", NoEcho: true, Default: "" } }, Resources: resources };
}
const sha = (p: string) => spawnSync("sha256sum", [p], { encoding: "utf8" }).stdout.split(" ")[0]!;

function setup(over: { extraResource?: boolean; routes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "h2b-"));
  const repo = join(dir, "repo"); const work = join(dir, "work"); const bin = join(dir, "bin"); const calls = join(dir, "calls"); const st = join(dir, "state");
  const tc = join(repo, TCREL);
  mkdirSync(tc, { recursive: true }); mkdirSync(work); mkdirSync(bin); mkdirSync(st); writeFileSync(calls, "");
  copyFileSync(join(root, TCREL, "diff_gate_0109.py"), join(tc, "diff_gate_0109.py"));
  // stand-ins for the database tools and the web deploy script, which only record that they ran
  writeFileSync(join(tc, "TEST_DB_SESSION.sh"), `#!/usr/bin/env bash\n"$@"\n`);
  writeFileSync(join(tc, "TEST_0109_LEDGER.sh"), `#!/usr/bin/env bash\necho "ledger $1 backup=\${OGEVIA_TEST_BACKUP:-none}" >> ${JSON.stringify(calls)}\nif [[ -f ${JSON.stringify(join(st, "fail-" ))}$1 ]]; then exit 2; fi\n`);
  mkdirSync(join(repo, "infra/aws/scripts"), { recursive: true });
  writeFileSync(join(repo, "infra/aws/scripts/deploy-test-slice.sh"), `#!/usr/bin/env bash\necho "web version=\${VITE_APP_VERSION:-none}" >> ${JSON.stringify(calls)}\nmkdir -p "$(dirname "$0")/../../../apps/web/dist-aws/assets"\ncp ${JSON.stringify(join(dir, "built-index.html"))} "$(dirname "$0")/../../../apps/web/dist-aws/index.html"\n`);
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").stdout.trim();
  // the H2a capture
  const cap = join(work, "h2a-20261120T000000Z"); mkdirSync(join(cap, "web-before"), { recursive: true }); mkdirSync(join(cap, "candidate-off"), { recursive: true });
  const live = template(259, "old.zip");
  writeFileSync(join(cap, "live-api.template.json"), JSON.stringify(live)); writeFileSync(join(dir, "live.json"), JSON.stringify(live));
  writeFileSync(join(cap, "candidate-off", `${STACK}.template.json`), JSON.stringify(template(259, "new.zip")));
  writeFileSync(join(dir, "deploy.json"), JSON.stringify(template(over.routes ?? 259, "new.zip", over.extraResource)));
  writeFileSync(join(cap, "release-commit.txt"), head + "\n");
  writeFileSync(join(cap, "gate-off.txt"), "routes added: 0 \nHandler code asset changed: Handler886CB40B\nEXPECTED-ONLY: YES (off)\n");
  writeFileSync(join(cap, "test-lambda.json"), JSON.stringify({ FunctionName: "fn", CodeSha256: "OLDSHA", Database: { host: "h", name: "ogevia_sv_test", secretArn: "arn:x" } }));
  writeFileSync(join(cap, "test-lambda.zip"), "zip"); writeFileSync(join(cap, "qr-parameter-spec.json"), JSON.stringify({ Type: "String", NoEcho: true, Default: "" }));
  writeFileSync(join(cap, "handler-tags.json"), "[]"); writeFileSync(join(cap, "candidate-master-arn.txt"), "arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-x\n");
  writeFileSync(join(cap, "web-targets.txt"), "test-bucket\nDISTTEST\n"); writeFileSync(join(cap, "web-before/index.html"), "old"); writeFileSync(join(cap, "web-before/config.json"), '{"c":1}');
  const sums = spawnSync("bash", ["-c", `find ${JSON.stringify(cap)} -type f -not -name SHA256SUMS -exec sha256sum {} + > ${JSON.stringify(join(cap, "SHA256SUMS"))}`]); expect(sums.status).toBe(0);
  // the H1 backup
  mkdirSync(join(work, "backup")); const bk = join(work, "backup", "ogevia_sv_test-pre-0109-20261120T000000Z.dump"); writeFileSync(bk, "dump");
  writeFileSync(bk + ".sha256", `${sha(bk)}  ${bk}\n`);
  const built = `<html><script src="/assets/index-abc.js"></script></html>`; writeFileSync(join(dir, "built-index.html"), built);
  writeFileSync(join(dir, "main.js"), `x={VITE_APP_VERSION:"${head}",VITE_APP_ENV:"test"}`);
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import json, sys, os
a = sys.argv[1:]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "120"]): a = a[2:]
line = " ".join(a)
open(${JSON.stringify(calls)}, "a").write("aws " + line + "\\n")
st = ${JSON.stringify(st)}; deployed = os.path.exists(st + "/deployed")
def out(x): print(x if isinstance(x, str) else json.dumps(x))
if "sts get-caller-identity" in line: out("300094796789")
elif "list-stack-resources" in line: out({"StackResourceSummaries": [{"ResourceType": "AWS::Lambda::Function", "LogicalResourceId": "Handler886CB40B", "PhysicalResourceId": "fn"}]})
elif "get-template" in line: out(open(${JSON.stringify(dir)} + ("/deploy.json" if deployed else "/live.json")).read())
elif "get-function-configuration" in line and "--query CodeSha256" in line: out("NEWSHA" if deployed else ("DRIFTED" if os.path.exists(st + "/drift") else "OLDSHA"))
elif "get-function-configuration" in line: out({"CodeSha256": "NEWSHA", "Database": {"host": "h", "name": "ogevia_sv_test", "secretArn": "arn:x"}})
elif "lambda wait" in line: pass
elif "s3 sync" in line or "s3 cp" in line or "cloudfront create-invalidation" in line: pass
elif "update-function-code" in line: out("Successful\tOLDSHA")
elif "describe-stacks" in line and "StackStatus" in line: out("UPDATE_COMPLETE")
elif "describe-stacks" in line and "ApiUrl" in line: out("https://api.example")
elif "describe-stacks" in line and "WebOrigin" in line: out("https://site.example")
else: sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
args="$*"; out=""; prev=""; for x in "$@"; do [[ "$prev" == "-o" ]] && out="$x"; prev="$x"; done
url="\${@: -1}"
case "$url" in
  */v1/me) echo -n 401;;
  */v1/care-notifications/read|*/cancel|*/retire) echo -n 404;;
  */index.html) if [[ -n "$out" ]]; then cp ${JSON.stringify(join(dir, "built-index.html"))} "$out"; fi;;
  */assets/index-abc.js) cat ${JSON.stringify(join(dir, "main.js"))};;
  */config.json) cat ${JSON.stringify(join(cap, "web-before/config.json"))};;
  *) echo "UNEXPECTED CURL: $args" >&2; exit 9;;
esac
`);
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash
if [[ "$*" == *"cdk synth"* ]]; then out=""; prev=""; for x in "$@"; do [[ "$prev" == "--output" ]] && out="$x"; prev="$x"; done; mkdir -p "$out"; cp ${JSON.stringify(join(dir, "deploy.json"))} "$out/${STACK}.template.json"; echo "synth $*" >> ${JSON.stringify(calls)}; exit 0; fi
if [[ "$*" == *"cdk deploy"* ]]; then echo "deploy $*" >> ${JSON.stringify(calls)}; touch ${JSON.stringify(join(st, "deployed"))}; exit 0; fi
exit 9
`);
  for (const f of ["aws", "curl", "pnpm"]) chmodSync(join(bin, f), 0o755);
  return { dir, repo, work, bin, calls, head, st, cap, bk };
}
type S = ReturnType<typeof setup>;
function run(s: S, env: Record<string, string> = {}, mode?: string) {
  return spawnSync("bash", [script, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, REPO: s.repo, WORK: s.work, OGEVIA_RELEASE_COMMIT: s.head, OGEVIA_DEPLOY_APPROVAL: "TEST-20261120-owner", OGEVIA_NO_CONFIRM: "1", OGEVIA_CF_WAIT: "0", ...env } });
}
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });
const calls = (s: S) => readFileSync(s.calls, "utf8");
const changes = (s: S) => calls(s).split("\n").filter((l) => /^(ledger apply|synth|deploy|web )/.test(l) || /aws (s3|cloudfront|lambda update)/.test(l));

describe("TEST_H2B_DEPLOY.sh", () => {
  it("refuses a different commit, a missing approval reference, modified tracked files, before anything else", () => {
    const s = setup();
    try {
      let r = run(s, { OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(2); expect(r.stderr).toContain("not at the release commit");
      r = run(s, { OGEVIA_DEPLOY_APPROVAL: "x y" }); expect(r.status).toBe(2); expect(r.stderr).toContain("OGEVIA_DEPLOY_APPROVAL must be");
      writeFileSync(join(s.repo, TCREL, "diff_gate_0109.py"), "# changed\n");
      r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("tracked files in the checkout are modified");
      expect(changes(s)).toEqual([]);
    } finally { done(s); }
  });

  it("refuses a capture that did not pass its gate, was modified, or was made for another commit; and a missing or corrupt backup; nothing is changed", () => {
    let s = setup();
    try { writeFileSync(join(s.cap, "gate-off.txt"), "EXPECTED-ONLY: NO\n"); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("gate did not pass"); expect(changes(s)).toEqual([]); } finally { done(s); }
    s = setup();
    try { writeFileSync(join(s.cap, "live-api.template.json"), "{}"); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("modified or is incomplete"); expect(changes(s)).toEqual([]); } finally { done(s); }
    s = setup();
    try { writeFileSync(join(s.cap, "release-commit.txt"), "1".repeat(40) + "\n"); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("different commit"); } finally { done(s); }
    s = setup();
    try { rmSync(s.bk + ".sha256"); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("backup from H1 is missing"); expect(changes(s)).toEqual([]); } finally { done(s); }
    s = setup();
    try { writeFileSync(s.bk, "tampered"); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("does not match its checksum"); expect(changes(s)).toEqual([]); } finally { done(s); }
  });

  it("stops on drift of the live Handler since H2a, before any change", () => {
    const s = setup();
    try { writeFileSync(join(s.st, "drift"), ""); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("live Handler code changed since H2a"); expect(changes(s)).toEqual([]); } finally { done(s); }
  });

  it("does not change anything when the deploy assembly fails the expected-only gate (extra resource) or has the wrong route count", () => {
    let s = setup({ extraResource: true });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stdout).toContain("EXPECTED-ONLY: NO"); expect(r.stderr).toContain("expected-only gate failed"); expect(changes(s).filter((l) => !l.startsWith("synth"))).toEqual([]); } finally { done(s); }
    s = setup({ routes: 262 });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("not the one H2a compared"); expect(changes(s).filter((l) => !l.startsWith("synth"))).toEqual([]); } finally { done(s); }
  });

  it("stops after a failed migration without deploying the API or web", () => {
    const s = setup();
    try { writeFileSync(join(s.st, "fail-apply"), ""); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("migration 0109 failed"); expect(changes(s).filter((l) => /^(deploy|web )/.test(l))).toEqual([]); } finally { done(s); }
  });

  it("happy path: gate on the assembly first, then migration (with the verified backup), verify, API deploy, post checks (switch OFF, 404 on the 3 routes), then web stamped with the commit", () => {
    const s = setup();
    try {
      const r = run(s);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("EXPECTED-ONLY: YES (off)"); expect(r.stdout).toContain("PASS Handler still targets ogevia_sv_test"); expect(r.stdout).toContain("API OK: new Handler code live, 259 routes, switch OFF");
      expect(r.stdout).toContain("PASS the bundle carries commit " + s.head); expect(r.stdout).toContain("PASS config.json unchanged"); expect(r.stdout).toContain("H2b COMPLETE (TEST)");
      const c = calls(s).split("\n"); const idx = (re: RegExp) => c.findIndex((l) => re.test(l));
      const order = [idx(/^synth /), idx(/^ledger apply backup=.*ogevia_sv_test-pre-0109-/), idx(/^ledger verify/), idx(/^deploy /), idx(/^web version=/)];
      expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(calls(s)).toContain("-c mode=deploy"); expect(calls(s)).toContain("--exclusively " + STACK); expect(calls(s)).toContain("web version=" + s.head);
      expect(calls(s)).not.toMatch(/Ogevia-prd-|get-secret-value|delete/);
    } finally { done(s); }
  }, 60000);

  it("rollback modes: the API restores the captured ZIP, the web restores the captured files, the database runs the pinned rollback; each needs its own confirmation by default", () => {
    const s = setup();
    try {
      let r = run(s, { OGEVIA_NO_CONFIRM: "0" }, "rollback-api"); expect(r.status).not.toBe(0); expect(r.stderr).not.toContain("UNEXPECTED");
      r = run(s, {}, "rollback-web"); expect(r.status, r.stderr).toBe(0); expect(calls(s)).toMatch(/s3 sync .*web-before\/assets s3:\/\/test-bucket\/assets/); expect(calls(s)).toContain("cloudfront create-invalidation");
      r = run(s, {}, "rollback-db"); expect(r.status, r.stderr).toBe(0); expect(calls(s)).toContain("ledger rollback");
      r = run(s, {}, "rollback-api"); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("ROLLBACK-API OK");
      expect(calls(s)).toContain("lambda update-function-code --function-name fn --zip-file fileb://");
    } finally { done(s); }
    void existsSync;
  });
});
