// TEST_H3_OFFICES.sh (TEST release of offices) with stand-in `aws`, `curl`, `pnpm` and database tools, in a throwaway git repository. Nothing touches AWS.
// The stand-in `cdk synth` reads the (temporarily edited) config.ts, so the test proves the script turns on exactly the offices switch, keeps request cleanup as it is live, and restores the file.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const TCREL = "docs/releases/2026-11-20-test-plan/toolchain";
const script = join(root, TCREL, "TEST_H3_OFFICES.sh");
const STACK = "Ogevia-prod-ServiceVerificationApi";
const OLDSHA = createHash("sha256").update("zip").digest("base64");
const FEATURES = "    features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },\n";

function setup(over: { liveRoutes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "h3-"));
  const repo = join(dir, "repo"); const work = join(dir, "work"); const bin = join(dir, "bin"); const calls = join(dir, "calls"); const st = join(dir, "state");
  const tc = join(repo, TCREL); const live = over.liveRoutes ?? 259;
  for (const d of [tc, work, bin, st, join(repo, "infra/aws/lib"), join(repo, "infra/aws/node_modules/.bin"), join(repo, "infra/aws/scripts"), join(repo, "docs/releases/2026-11-10-ux-redesign-test/toolchain")]) mkdirSync(d, { recursive: true });
  writeFileSync(calls, ""); writeFileSync(join(repo, "infra/aws/lib/config.ts"), `const PROD = {\n${FEATURES}};\n`); writeFileSync(join(repo, "infra/aws/node_modules/.bin/cdk"), ""); chmodSync(join(repo, "infra/aws/node_modules/.bin/cdk"), 0o755);
  copyFileSync(join(root, TCREL, "diff_gate_0110.py"), join(tc, "diff_gate_0110.py"));
  writeFileSync(join(tc, "VERIFY_0110.sql"), "select 1;\n");
  writeFileSync(join(tc, "TEST_DB_SESSION.sh"), `#!/usr/bin/env bash\n"$@"\n`);
  writeFileSync(join(tc, "TEST_0110_LEDGER.sh"), `#!/usr/bin/env bash\necho "ledger $1 backup=\${OGEVIA_TEST_BACKUP:-none}" >> ${JSON.stringify(calls)}\nif [[ -f ${JSON.stringify(join(st, "fail-"))}$1 ]]; then exit 2; fi\n`);
  writeFileSync(join(repo, "docs/releases/2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DB.sh"), `#!/usr/bin/env bash\necho "backup $1" >> ${JSON.stringify(calls)}\nprintf dump > "$OGEVIA_TEST_BACKUP"; (cd "$(dirname "$OGEVIA_TEST_BACKUP")" && sha256sum "$(basename "$OGEVIA_TEST_BACKUP")" > "$OGEVIA_TEST_BACKUP.sha256")\n`);
  writeFileSync(join(repo, "infra/aws/scripts/deploy-test-slice.sh"), `#!/usr/bin/env bash\necho "web version=\${VITE_APP_VERSION:-none}" >> ${JSON.stringify(calls)}\nmkdir -p "$(dirname "$0")/../../../apps/web/dist-aws/assets"\ncp ${JSON.stringify(join(dir, "built-index.html"))} "$(dirname "$0")/../../../apps/web/dist-aws/index.html"\n`);
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(dir, "built-index.html"), `<html><script src="/assets/index-abc.js"></script></html>`);
  writeFileSync(join(dir, "main.js"), `x={VITE_APP_VERSION:"${head}",VITE_APP_ENV:"test"}`);
  writeFileSync(join(dir, "web.json"), '{"c":1}');
  // the stand-in template builder (shared by the stand-in synth): base routes + request cleanup (3) + offices (6)
  writeFileSync(join(dir, "mk.py"), `import json, sys
def build(base, rc, off, key="new.zip", extra=False):
    r = {"Handler886CB40B": {"Type": "AWS::Lambda::Function", "Properties": {"Code": {"S3Bucket": "cdk-hnb659fds-assets-300094796789-us-west-2", "S3Key": key}, "Environment": {"Variables": {"DB_NAME": "ogevia_sv_test"}}, "Tags": []}, "Metadata": {"aws:asset:path": "asset." + key}}}
    keys = ["GET /v1/r%d" % i for i in range(base)]
    if rc: keys += ["POST /v1/care-notifications/read", "POST /v1/documents/{documentId}/cancel", "POST /v1/document-types/{documentTypeId}/retire"]
    if off: keys += ["GET /v1/offices", "GET /v1/client-offices", "POST /v1/offices", "POST /v1/offices/{officeId}/rename", "POST /v1/offices/{officeId}/retire", "POST /v1/clients/{clientId}/office"]
    for i, k in enumerate(keys): r["R%d" % i] = {"Type": "AWS::ApiGatewayV2::Route", "Properties": {"RouteKey": k}}
    if extra: r["Extra"] = {"Type": "AWS::SQS::Queue", "Properties": {}}
    return {"Parameters": {"ClientQrEncryptionKey": {"Type": "String", "NoEcho": True, "Default": ""}}, "Resources": r}
if __name__ == "__main__":
    base, rc, off, key, extra, out = int(sys.argv[1]), sys.argv[2] == "1", sys.argv[3] == "1", sys.argv[4], sys.argv[5] == "1", sys.argv[6]
    json.dump(build(base, rc, off, key, extra), open(out, "w"))
`);
  const liveRc = live === 262 ? 1 : 0; const baseRoutes = live === 262 || live === 259 ? 259 : live;
  spawnSync("python3", [join(dir, "mk.py"), String(baseRoutes), String(liveRc), "0", "old.zip", "0", join(st, "live.json")]);
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
elif "get-function-configuration" and "lambda get-function-configuration" in line and "--query CodeSha256" in line: out(sha)
elif "lambda get-function-configuration" in line: out({"FunctionName": "fn", "CodeSha256": sha, "Database": {"host": "ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com", "name": "ogevia_sv_test", "secretArn": "arn:x"}})
elif "lambda get-function " in line: out("https://zip.example/code")
elif "lambda wait" in line: pass
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
has() { grep -q "/v1/offices" ${JSON.stringify(join(st, "live.json"))}; }
case "$url" in
  https://zip.example/code) [[ -n "$out" ]] && printf zip > "$out";;
  */v1/me) echo -n 401;;
  */v1/offices|*/v1/client-offices|*/rename|*/retire|*/office) if has; then echo -n 401; else echo -n 404; fi;;
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
  cfg="$(cat "$PWD/infra/aws/lib/config.ts")"; rc=0; off=0; extra=0; [[ "$cfg" == *"requestCleanup: true"* ]] && rc=1; [[ "$cfg" == *"offices: true"* ]] && off=1
  [[ -f ${JSON.stringify(join(st, "extra"))} && $off == 1 ]] && extra=1
  mkdir -p "$out"; python3 ${JSON.stringify(join(dir, "mk.py"))} 259 $rc $off new.zip $extra "$out/${STACK}.template.json"; echo "synth offices=$off rc=$rc" >> ${JSON.stringify(calls)}; exit 0; fi
if [[ "$*" == *"cdk deploy"* ]]; then app=""; prev=""; for x in "$@"; do [[ "$prev" == "--app" ]] && app="$x"; prev="$x"; done
  echo "deploy $app" >> ${JSON.stringify(calls)}; cp "$app/${STACK}.template.json" ${JSON.stringify(join(st, "live.json"))}; printf NEWSHA > ${JSON.stringify(join(st, "sha"))}; exit 0; fi
exit 9
`);
  for (const f of ["aws", "curl", "pnpm", "corepack"]) chmodSync(join(bin, f), 0o755);
  return { dir, repo, work, bin, calls, head, st };
}
type S = ReturnType<typeof setup>;
function run(s: S, env: Record<string, string> = {}, mode?: string) {
  return spawnSync("bash", [script, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, REPO: s.repo, WORK: s.work, OGEVIA_RELEASE_COMMIT: s.head, OGEVIA_DEPLOY_APPROVAL: "TEST-OFFICES-0001", OGEVIA_NO_CONFIRM: "1", OGEVIA_CF_WAIT: "0", ...env }, timeout: 90000 });
}
const done = (s: { dir: string }) => rmSync(s.dir, { recursive: true, force: true });
const calls = (s: S) => readFileSync(s.calls, "utf8");
const changes = (s: S) => calls(s).split("\n").filter((l) => /^(ledger apply|deploy|web |backup)/.test(l) || /aws (s3 sync [^s]|s3 cp|cloudfront|lambda update)/.test(l));
const gitClean = (s: S) => spawnSync("git", ["-C", s.repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim() === "";

describe("TEST_H3_OFFICES.sh", () => {
  it("refuses a different commit, a bad approval reference and modified tracked files, before anything else", () => {
    const s = setup();
    try {
      let r = run(s, { OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(2); expect(r.stderr).toContain("not at the release commit");
      r = run(s, { OGEVIA_DEPLOY_APPROVAL: "x y" }); expect(r.status).toBe(2); expect(r.stderr).toContain("OGEVIA_DEPLOY_APPROVAL must be");
      writeFileSync(join(s.repo, TCREL, "diff_gate_0110.py"), "# changed\n");
      r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("tracked files in the checkout are modified");
      expect(changes(s)).toEqual([]);
    } finally { done(s); }
  });

  it("stops before any change on an unexpected live route count, a failed baseline probe, or a gate violation", () => {
    let s = setup({ liveRoutes: 260 });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("expected 259 with request cleanup off, or 262"); expect(changes(s)).toEqual([]); } finally { done(s); }
    s = setup();
    try { writeFileSync(join(s.st, "fail-probe"), ""); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("not the baseline"); expect(changes(s)).toEqual([]); expect(gitClean(s)).toBe(true); } finally { done(s); }
    s = setup();
    try { writeFileSync(join(s.st, "extra"), ""); const r = run(s); expect(r.status).toBe(2); expect(r.stdout).toContain("EXPECTED-ONLY: NO"); expect(r.stderr).toContain("not exactly the six office routes"); expect(changes(s)).toEqual([]); expect(gitClean(s)).toBe(true); } finally { done(s); }
  });

  it("stops after a failed migration without deploying the API or web", () => {
    const s = setup();
    try { writeFileSync(join(s.st, "fail-apply"), ""); const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("migration 0110 failed"); expect(changes(s).filter((l) => /^(deploy|web )/.test(l))).toEqual([]); } finally { done(s); }
  });

  for (const [live, rc, after] of [[259, "0", 265], [262, "1", 268]] as const) {
    it(`happy path with ${live} live routes: request cleanup stays ${rc === "1" ? "ON" : "OFF"}, six office routes added (${after}), backup, migration, deploy, web; the config is restored`, () => {
      const s = setup({ liveRoutes: live });
      try {
        const r = run(s);
        expect(r.status, r.stderr + r.stdout).toBe(0);
        expect(r.stdout).toContain("EXPECTED-ONLY: YES (off)"); expect(r.stdout).toContain("EXPECTED-ONLY: YES (on)"); expect(r.stdout).toContain(`PASS ${after} routes live`);
        expect(r.stdout).toContain("PASS Handler still targets ogevia_sv_test"); expect(r.stdout).toContain("PASS the bundle carries commit " + s.head); expect(r.stdout).toContain("H3 COMPLETE (TEST)");
        const c = calls(s).split("\n"); const idx = (re: RegExp) => c.findIndex((l) => re.test(l));
        const order = [idx(/^synth offices=0 rc=/), idx(/^synth offices=1 rc=/), idx(/^backup isolated-backup/), idx(/^ledger apply backup=.*ogevia_sv_test-pre-0110-/), idx(/^ledger verify/), idx(/^deploy .*deploy-on/), idx(/^web version=/)];
        expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(calls(s)).toContain(`synth offices=0 rc=${rc}`); expect(calls(s)).toContain(`synth offices=1 rc=${rc}`);
        expect(calls(s)).not.toMatch(/Ogevia-prd-Service|get-secret-value|delete/);
        expect(gitClean(s)).toBe(true); expect(readFileSync(join(s.repo, "infra/aws/lib/config.ts"), "utf8")).not.toContain("offices");
      } finally { done(s); }
    }, 90000);
  }

  it("rollbacks: web restores the captured files, routes redeploys the offices-OFF assembly (back to the pre-release count), api restores the ZIP, db runs the pinned rollback", () => {
    const s = setup();
    try {
      let r = run(s); expect(r.status, r.stderr + r.stdout).toBe(0);
      r = run(s, { OGEVIA_NO_CONFIRM: "0" }, "rollback-api"); expect(r.status).not.toBe(0);
      r = run(s, {}, "rollback-web"); expect(r.status, r.stderr).toBe(0); expect(calls(s)).toMatch(/s3 sync .*web-before\/assets s3:\/\/test-bucket\/assets/);
      r = run(s, {}, "rollback-routes"); expect(r.status, r.stderr + r.stdout).toBe(0); expect(r.stdout).toContain("ROLLBACK-ROUTES OK"); expect(calls(s)).toMatch(/deploy .*deploy-off/);
      r = run(s, {}, "rollback-api"); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("ROLLBACK-API OK");
      r = run(s, {}, "rollback-db"); expect(r.status, r.stderr).toBe(0); expect(calls(s)).toContain("ledger rollback");
    } finally { done(s); }
  }, 120000);
});
