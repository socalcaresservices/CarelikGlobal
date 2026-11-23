// TEST_WEB_FIX.sh (web-only TEST publish) with stand-in `aws`, `curl` and the web deploy script, in a throwaway git repository. Nothing touches AWS.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "docs/releases/2026-11-20-test-plan/toolchain/TEST_WEB_FIX.sh");

function setup(over: { sharedTargets?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wf-")); const repo = join(dir, "repo"); const work = join(dir, "work"); const bin = join(dir, "bin"); const calls = join(dir, "calls");
  for (const d of [join(repo, "infra/aws/scripts"), work, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(calls, "");
  writeFileSync(join(repo, "infra/aws/scripts/deploy-test-slice.sh"), `#!/usr/bin/env bash\necho "web version=\${VITE_APP_VERSION:-none}" >> ${JSON.stringify(calls)}\nmkdir -p "$(dirname "$0")/../../../apps/web/dist-aws"\ncp ${JSON.stringify(join(dir, "built-index.html"))} "$(dirname "$0")/../../../apps/web/dist-aws/index.html"\n`);
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x");
  const head = git("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(dir, "built-index.html"), `<html><script src="/assets/index-abc.js"></script></html>`);
  writeFileSync(join(dir, "main.js"), `x={VITE_APP_VERSION:"${head}",VITE_APP_ENV:"test"}`); writeFileSync(join(dir, "web.json"), '{"c":1}');
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import sys, os
a = sys.argv[1:]
while a[:2] in (["--cli-connect-timeout", "5"], ["--cli-read-timeout", "120"]): a = a[2:]
line = " ".join(a); open(${JSON.stringify(calls)}, "a").write("aws " + line + "\\n")
if "sts get-caller-identity" in line: print("300094796789")
elif "describe-stacks" in line and "SiteBucketName" in line: print("${over.sharedTargets ? "test-bucket" : "prd-bucket"}" if "Ogevia-prd" in line else "test-bucket")
elif "describe-stacks" in line and "DistributionId" in line: print("${over.sharedTargets ? "DISTTEST" : "PRDDIST"}" if "Ogevia-prd" in line else "DISTTEST")
elif "describe-stacks" in line and "WebOrigin" in line: print("https://site.example")
elif "s3 sync s3://" in line:
    d = a[3]; os.makedirs(d + "/assets", exist_ok=True); open(d + "/index.html", "w").write('<script src="/assets/index-old.js"></script>'); open(d + "/assets/index-old.js", "w").write("old"); open(d + "/config.json", "w").write(open(${JSON.stringify(join(dir, "web.json"))}).read())
elif "s3 sync" in line or "s3 cp" in line or "cloudfront create-invalidation" in line: pass
else: sys.stderr.write("UNEXPECTED AWS CALL: " + line + "\\n"); sys.exit(9)
`);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
out=""; prev=""; url=""; for x in "$@"; do [[ "$prev" == "-o" ]] && out="$x"; [[ "$x" == http* ]] && url="$x"; prev="$x"; done
case "$url" in
  */index.html) [[ -n "$out" ]] && cp ${JSON.stringify(join(dir, "built-index.html"))} "$out";;
  */assets/index-abc.js) cat ${JSON.stringify(join(dir, "main.js"))};;
  */config.json) cat ${JSON.stringify(join(dir, "web.json"))};;
  *) echo "UNEXPECTED CURL: $*" >&2; exit 9;;
esac
`);
  for (const f of ["aws", "curl"]) chmodSync(join(bin, f), 0o755);
  return { dir, repo, work, bin, calls, head };
}
type S = ReturnType<typeof setup>;
const run = (s: S, env: Record<string, string> = {}, mode?: string) => spawnSync("bash", [script, ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, REPO: s.repo, WORK: s.work, OGEVIA_RELEASE_COMMIT: s.head, OGEVIA_DEPLOY_APPROVAL: "TEST-WEBFIX-0001", OGEVIA_NO_CONFIRM: "1", OGEVIA_CF_WAIT: "0", ...env }, timeout: 60000 });
const calls = (s: S) => readFileSync(s.calls, "utf8");
const writes = (s: S) => calls(s).split("\n").filter((l) => /^web /.test(l) || /aws (s3 sync [^s]|s3 cp|cloudfront)/.test(l));
const done = (s: S) => rmSync(s.dir, { recursive: true, force: true });

describe("TEST_WEB_FIX.sh", () => {
  it("refuses a different commit, a bad approval reference, modified tracked files and shared production web targets, before any change", () => {
    let s = setup();
    try {
      let r = run(s, { OGEVIA_RELEASE_COMMIT: "0".repeat(40) }); expect(r.status).toBe(2); expect(r.stderr).toContain("not at the release commit");
      r = run(s, { OGEVIA_DEPLOY_APPROVAL: "x y" }); expect(r.status).toBe(2); expect(r.stderr).toContain("OGEVIA_DEPLOY_APPROVAL must be");
      writeFileSync(join(s.repo, "infra/aws/scripts/deploy-test-slice.sh"), "# changed\n");
      r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("modified"); expect(writes(s)).toEqual([]);
    } finally { done(s); }
    s = setup({ sharedTargets: true });
    try { const r = run(s); expect(r.status).toBe(2); expect(r.stderr).toContain("shared with production"); expect(writes(s)).toEqual([]); } finally { done(s); }
  });
  it("publishes the web stamped with the commit after capturing the live files, verifies it, and never touches the API or database", () => {
    const s = setup();
    try {
      const r = run(s);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("PASS the bundle carries commit " + s.head); expect(r.stdout).toContain("PASS config.json unchanged"); expect(r.stdout).toContain("TEST WEB PUBLISHED");
      const c = calls(s).split("\n"); expect(c.findIndex((l) => /s3 sync s3:\/\/test-bucket /.test(l))).toBeLessThan(c.findIndex((l) => /^web version=/.test(l)));
      expect(calls(s)).toContain("web version=" + s.head);
      expect(calls(s)).not.toMatch(/lambda|cloudformation (deploy|update)|rds|secretsmanager|Ogevia-prd-WebHosting.*(s3|cloudfront)/);
    } finally { done(s); }
  });
  it("rollback-web restores the captured files only", () => {
    const s = setup();
    try {
      expect(run(s).status).toBe(0);
      const r = run(s, {}, "rollback-web"); expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("ROLLBACK-WEB done");
      expect(calls(s)).toMatch(/s3 sync .*web-before\/assets s3:\/\/test-bucket\/assets/); expect(calls(s)).toContain("cloudfront create-invalidation --distribution-id DISTTEST");
    } finally { done(s); }
  });
});
