// infra/aws/slice/test-web-release.sh publishes the web app to the TEST environment only. These tests keep that true.
//
// Static checks read the script. Behaviour checks RUN the script against test doubles (fixtures/test-web-release/{aws,curl,npx}) that
// simulate a TEST and a PROD site bucket on local disk, so the guards, the failure handling and the whole publish, verify and
// rollback cycle are exercised without AWS. The doubles never talk to the network. Requires bash, git, jq, python3 and GNU date.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIX = join(here, "fixtures/test-web-release");
const SCRIPT_TEXT = readFileSync(join(here, "../slice/test-web-release.sh"), "utf8");
const CODE = SCRIPT_TEXT.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const SECONDS = 60_000;

// --------------------------------------------------------------------------------------------- static
describe("test-web-release.sh (static)", () => {
  it("every aws call is a read, or one of the three TEST writes (s3 sync, s3 cp, cloudfront create-invalidation)", () => {
    const awsLines = CODE.split("\n").filter((l) => !/^for t in /.test(l));   // the tool-presence loop names "aws jq curl"
    const calls = [...awsLines.join("\n").matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(calls.length).toBeGreaterThan(8);
    const writes = new Set(["s3 sync", "s3 cp", "cloudfront create-invalidation"]);
    for (const c of calls) expect(c, c).toMatch(/^[a-z0-9-]+ (describe-|list-|get-|head-|wait)|^(s3 sync|s3 cp|cloudfront create-invalidation)$/);
    expect(new Set(calls.filter((c) => writes.has(c))).size).toBe(3);
  });
  it("cannot touch the database, secrets, other services or deletions", () => {
    for (const bad of [/--delete/, /\bs3 rm\b/, /\bs3 mv\b/, /secretsmanager/, /get-secret-value/, /start-session/, /\bpsql\b/, /\bcdk\b/, /cognito-idp/, /\blambda\b/, /\biam\b/, /\brds\b/, /route53/, /\bssm\b/, /put-/, /delete-/, /update-/, /modify-/, /create-(?!invalidation)/, /--dangerously/])
      expect(CODE, String(bad)).not.toMatch(bad);
  });
  it("every S3 address the script uses is the TEST bucket variable, and config.json is excluded from uploads", () => {
    const lines = CODE.split("\n").filter((l) => /\baws s3 (sync|cp)\b/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const l of lines) for (const m of l.matchAll(/"s3:\/\/([^"]+)"/g)) expect(m[1]!.startsWith("$BUCKET"), l).toBe(true);
    expect(CODE).toMatch(/--exclude "config\.json"/);
  });
  it("builds with VITE_APP_ENV=test only, checks the baked-in label, and refuses production", () => {
    expect(CODE).not.toMatch(/VITE_APP_ENV=production/);
    expect(CODE).toMatch(/VITE_APP_ENV=test VITE_AUTH_PROVIDER=cognito/);
    expect(CODE).toMatch(/VITE_APP_ENV:\[\[:space:\]\]\*"test"/);
    expect(CODE).toMatch(/is labelled production; refusing/);
  });
  it("has the environment guards: baseline, TEST/PROD separation, live config, window, approval", () => {
    for (const needle of ["merge-base --is-ancestor", "application files differ from the approved release commit", "are not separated", "must not claim to be production",
      "window_open", "OGEVIA_WINDOW_END", "OGEVIA_DEPLOY_APPROVAL", "PUBLISH TEST", "ROLLBACK TEST", "the TEST bucket name contains 'prd'"])
      expect(SCRIPT_TEXT, needle).toContain(needle);
    expect(CODE).toContain('TEST_PREFIX=Ogevia-prod');
    expect(CODE).toMatch(/PROD_PREFIX=Ogevia-prd/);
  });
  it("PROD is only ever READ (its stack outputs, for the separation check)", () => {
    const prodUses = CODE.split("\n").filter((l) => /PROD_PREFIX|prd/.test(l) && /\baws\b/.test(l) && !/cfout/.test(l));
    expect(prodUses).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------- behaviour
interface Ctx { dir: string; repo: string; home: string; script: string; baseline: string; s3: string; calls: string }
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const sh = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "twr-")); made.push(dir);
  const bin = join(dir, "bin"); mkdirSync(bin);
  for (const n of ["aws", "curl", "npx"]) { copyFileSync(join(FIX, n), join(bin, n)); chmodSync(join(bin, n), 0o755); }
  const s3 = join(dir, "s3"); mkdirSync(join(s3, "test-bucket/assets"), { recursive: true }); mkdirSync(join(s3, "prd-bucket/assets"), { recursive: true });
  writeFileSync(join(s3, "test-bucket/index.html"), '<html>OLD TEST INDEX <script src="/assets/index-OLD.js"></script></html>');
  writeFileSync(join(s3, "test-bucket/assets/index-OLD.js"), "old-js"); writeFileSync(join(s3, "test-bucket/favicon.svg"), "fav");
  writeFileSync(join(s3, "test-bucket/config.json"), '{"VITE_SV_API_BASE_URL":"https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com","VITE_COGNITO_REGION":"us-west-2"}');
  writeFileSync(join(s3, "prd-bucket/index.html"), "PROD INDEX"); writeFileSync(join(s3, "prd-bucket/config.json"), '{"VITE_APP_ENV":"production"}');
  const repo = join(dir, "repo"); mkdirSync(repo);
  sh(repo, ["init", "-q"]); sh(repo, ["checkout", "-q", "-b", "main"]);
  for (const f of ["apps/web/package.json", "packages/shared/index.ts", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "turbo.json", "tsconfig.base.json", "docs/readme.md"]) {
    mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), `${f}\n`);
  }
  sh(repo, ["add", "-A"]); sh(repo, ["commit", "-q", "-m", "baseline"]);
  const baseline = sh(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const script = join(dir, "test-web-release.sh");
  writeFileSync(script, SCRIPT_TEXT, { mode: 0o755 });   // the release commit is supplied by the environment, as an operator would
  return { dir, repo, home: join(dir, "home"), script, baseline, s3, calls: join(dir, "calls.log") };
}
const windowEnd = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
interface Out { code: number; out: string; err: string; text: string }
function run(c: Ctx, args: string[], o: { mode?: string; input?: string; approval?: string | null; window?: string | null; commit?: string | null } = {}): Out {
  mkdirSync(c.home, { recursive: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: c.home, TMPDIR: c.dir, MOCK_T: c.dir, MOCK_MODE: o.mode ?? "ok", PATH: `${join(c.dir, "bin")}:${process.env.PATH}` };
  delete env.OGEVIA_DEPLOY_APPROVAL; delete env.OGEVIA_WINDOW_END; delete env.OGEVIA_RELEASE_COMMIT;
  if (o.commit !== null) env.OGEVIA_RELEASE_COMMIT = o.commit ?? c.baseline;
  if (o.approval !== null) env.OGEVIA_DEPLOY_APPROVAL = o.approval ?? "owner-go-test-web-1";
  if (o.window !== null) env.OGEVIA_WINDOW_END = o.window ?? windowEnd(90);
  const r = spawnSync("bash", [c.script, ...args], { cwd: c.repo, encoding: "utf8", env, input: o.input ?? "", timeout: 50_000 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
}
const sha = (p: string) => spawnSync("sha256sum", [p], { encoding: "utf8" }).stdout.split(" ")[0];
const tree = (d: string) => spawnSync("bash", ["-c", `cd "${d}" && find . -type f | sort | xargs sha256sum | sha256sum`], { encoding: "utf8" }).stdout;
const calls = (c: Ctx) => (existsSync(c.calls) ? readFileSync(c.calls, "utf8").split("\n").filter(Boolean) : []);
const runDir = (c: Ctx) => join(c.home, `ogevia-test-web-release-${c.baseline.slice(0, 7)}`);   // the script names its folder after the baseline

describe("test-web-release.sh (behaviour, against test doubles)", () => {
  it("usage: no or unknown step prints the header and exits 2", () => {
    const c = setup(); const r = run(c, []); expect(r.code).toBe(2); expect(r.text).toContain("TEST-ONLY WEB RELEASE");
  }, SECONDS);

  it("a build whose bundle does not carry the release commit as VITE_APP_VERSION is a failure (exit 3) and no BUILD_OK record is written", () => {
    const c = setup(); const r = run(c, ["build"], { mode: "build_wrong_version" });
    expect(r.code).toBe(3); expect(r.text).toMatch(/does not carry VITE_APP_VERSION/);
    expect(existsSync(join(runDir(c), "BUILD_OK"))).toBe(false);
  }, SECONDS);
  it("a good build records that the version is in the bundle", () => {
    const c = setup(); const r = run(c, ["build"]);
    expect(r.code).toBe(0); expect(readFileSync(join(runDir(c), "BUILD_OK"), "utf8")).toContain("version_in_bundle=yes");
  }, SECONDS);

  describe("guards refuse before anything is written (exit 2)", () => {
    it.each([["is not set", null], ["is too short", "d82fefc"], ["is not hex", "z".repeat(40)], ["is upper case", "A".repeat(40)]])("an OGEVIA_RELEASE_COMMIT that %s is refused", (_n, commit) => {
      const c = setup(); const r = run(c, ["preflight"], { commit });
      expect(r.code).toBe(2); expect(r.text).toMatch(/OGEVIA_RELEASE_COMMIT/);
      expect(calls(c)).toEqual([]);
    }, SECONDS);

    const cases: [string, string, RegExp][] = [
      ["live config.json says production", "live_prod_label", /must not claim to be production/],
      ["live config.json points at another API", "live_other_api", /expected s0epy5rgzb/],
      ["a TEST resource equals the PROD resource", "same_bucket", /not separated/],
      ["TEST web address is not the documented one", "wrong_web_host", /expected d2xumch5w0izfg/],
      ["TEST API id is not the documented one", "wrong_api", /expected s0epy5rgzb/],
      ["the AWS account is not the Ogevia account", "wrong_account", /not the Ogevia account/],
    ];
    it.each(cases)("%s", (_n, mode, re) => {
      const c = setup(); const r = run(c, ["preflight"], { mode });
      expect(r.code).toBe(2); expect(r.text).toMatch(re);
      expect(calls(c).some((l) => /^aws (s3 (sync|cp)|cloudfront create)/.test(l))).toBe(false);
    }, SECONDS);

    it("a live config.json that already says test is accepted", () => {
      const c = setup(); const r = run(c, ["preflight"], { mode: "live_test_label" }); expect(r.code).toBe(0); expect(r.text).toContain("VITE_APP_ENV: test");
    }, SECONDS);
    it("a checkout that does not contain the baseline is refused", () => {
      const c = setup(); sh(c.repo, ["checkout", "-q", "--orphan", "other"]); sh(c.repo, ["commit", "-q", "--allow-empty", "-m", "unrelated"]);
      const r = run(c, ["preflight"]); expect(r.code).toBe(2); expect(r.text).toMatch(/does not contain the approved release commit|HEAD does not contain/);
    }, SECONDS);
    it("changed application files are refused; a documentation-only change is allowed", () => {
      const c = setup();
      writeFileSync(join(c.repo, "docs/readme.md"), "changed docs\n"); sh(c.repo, ["commit", "-q", "-am", "docs only"]);
      expect(run(c, ["preflight"]).code).toBe(0);
      writeFileSync(join(c.repo, "apps/web/package.json"), "changed app\n"); sh(c.repo, ["commit", "-q", "-am", "app change"]);
      const r = run(c, ["preflight"]); expect(r.code).toBe(2); expect(r.text).toContain("application files differ from the approved release commit");
    }, SECONDS);
    it("local changes to tracked files are refused", () => {
      const c = setup(); writeFileSync(join(c.repo, "pnpm-lock.yaml"), "dirty\n"); const r = run(c, ["preflight"]);
      expect(r.code).toBe(2); expect(r.text).toMatch(/application files differ|local changes/);
    }, SECONDS);
  });

  describe("failures are reported as failures (exit 3), with the real exit code and no account number", () => {
    it("a failed AWS command", () => {
      const c = setup(); const r = run(c, ["preflight"], { mode: "no_creds" });
      expect(r.code).toBe(3); expect(r.text).toContain("exit code 255"); expect(r.text).not.toContain("300094796789");
    }, SECONDS);
    it("a missing CloudFormation output is not a pass", () => {
      const c = setup(); const r = run(c, ["preflight"], { mode: "missing_output" }); expect(r.code).toBe(3); expect(r.text).toContain("missing or malformed");
    }, SECONDS);
  });

  describe("build", () => {
    it("builds with the test label and records it", () => {
      const c = setup(); const r = run(c, ["build"]); expect(r.code).toBe(0); expect(r.text).toContain("BUILD OK");
      expect(readFileSync(join(runDir(c), "BUILD_OK"), "utf8")).toMatch(/label=test/);
      expect(existsSync(join(runDir(c), "web-build/config.json"))).toBe(false);
    }, SECONDS);
    it.each([["a build labelled production", "build_prod_label"], ["a build with no label at all (the banner text in its code is not a label)", "build_no_label"]])(
      "refuses %s", (_n, mode) => { const c = setup(); const r = run(c, ["build"], { mode }); expect(r.code).toBe(3); expect(r.text).toMatch(/not labelled test|labelled production/); }, SECONDS);
    it("a failed build is a failure; a config.json produced by the build is removed", () => {
      const c = setup(); expect(run(c, ["build"], { mode: "build_fails" }).code).toBe(3);
      const d = setup(); expect(run(d, ["build"], { mode: "build_with_config" }).code).toBe(0); expect(existsSync(join(runDir(d), "web-build/config.json"))).toBe(false);
    }, SECONDS);
  });

  describe("publish, verify, rollback", () => {
    function ready(): Ctx { const c = setup(); expect(run(c, ["build"]).code).toBe(0); expect(run(c, ["capture"]).code).toBe(0); return c; }

    it("publish refuses without a build, a capture, an approval reference, a window, or the typed phrase", () => {
      const c = setup(); expect(run(c, ["publish"], { input: "PUBLISH TEST" }).text).toContain("run 'build' first");
      expect(run(c, ["build"]).code).toBe(0); expect(run(c, ["publish"], { input: "PUBLISH TEST" }).text).toContain("run 'capture' first");
      expect(run(c, ["capture"]).code).toBe(0);
      const before = sha(join(c.s3, "test-bucket/index.html"));
      const cases: [string, Partial<Parameters<typeof run>[2]>, RegExp][] = [
        ["no approval reference", { approval: null, input: "PUBLISH TEST" }, /approval reference/],
        ["no window", { window: null, input: "PUBLISH TEST" }, /OGEVIA_WINDOW_END/],
        ["a window in the past", { window: windowEnd(-5), input: "PUBLISH TEST" }, /window ended/],
        ["a window more than 4 hours ahead", { window: windowEnd(600), input: "PUBLISH TEST" }, /more than 4 hours/],
        ["a malformed window", { window: "tomorrow-ish", input: "PUBLISH TEST" }, /not a valid time/],
        ["the wrong typed phrase", { input: "yes" }, /not confirmed/],
      ];
      for (const [name, o, re] of cases) { const r = run(c, ["publish"], o); expect(r.code, name).toBe(2); expect(r.text, name).toMatch(re); }
      expect(sha(join(c.s3, "test-bucket/index.html"))).toBe(before);
    }, SECONDS);

    it("publish refuses a build folder that contains config.json", () => {
      const c = ready(); writeFileSync(join(runDir(c), "web-build/config.json"), "{}");
      const r = run(c, ["publish"], { input: "PUBLISH TEST" }); expect(r.code).toBe(3); expect(r.text).toContain("must never be uploaded");
    }, SECONDS);

    it("a failed upload is a failure with the real exit code and no ARN", () => {
      const c = ready(); const r = run(c, ["publish"], { mode: "sync_fails", input: "PUBLISH TEST" });
      expect(r.code).toBe(3); expect(r.text).toContain("exit code 1"); expect(r.text).not.toContain("arn:aws:iam");
    }, SECONDS);

    it("full cycle: publish changes TEST only; verify passes; a stale cache fails verify; rollback restores the captured site", () => {
      const c = ready();
      const oldIndex = sha(join(c.s3, "test-bucket/index.html")), oldCfg = sha(join(c.s3, "test-bucket/config.json")), prd = tree(join(c.s3, "prd-bucket"));
      const p = run(c, ["publish"], { input: "PUBLISH TEST" }); expect(p.code).toBe(0); expect(p.text).toContain("PUBLISH DONE");
      expect(sha(join(c.s3, "test-bucket/index.html"))).not.toBe(oldIndex);
      expect(sha(join(c.s3, "test-bucket/config.json"))).toBe(oldCfg);                       // config.json untouched
      expect(tree(join(c.s3, "prd-bucket"))).toBe(prd);                                      // PROD byte-for-byte unchanged
      expect(existsSync(join(c.s3, "test-bucket/assets/index-OLD.js"))).toBe(true);          // nothing deleted
      const v = run(c, ["verify"]); expect(v.code).toBe(0); expect(v.text).toContain("byte-identical"); expect(v.text).toContain("browser check is still required");
      expect(run(c, ["verify"], { mode: "stale_cache" }).code).toBe(3);
      expect(run(c, ["rollback"], { input: "no" }).code).toBe(2);
      const rb = run(c, ["rollback"], { input: "ROLLBACK TEST" }); expect(rb.code).toBe(0); expect(rb.text).toContain("ROLLBACK DONE");
      expect(sha(join(c.s3, "test-bucket/index.html"))).toBe(oldIndex);                      // captured site restored
      expect(sha(join(c.s3, "test-bucket/config.json"))).toBe(oldCfg);
      expect(tree(join(c.s3, "prd-bucket"))).toBe(prd);
      // scope evidence from every logged call
      const log = calls(c).filter((l) => l.startsWith("aws "));
      const writes = log.filter((l) => /^aws (s3 cp|cloudfront create-invalidation)/.test(l) || /^aws s3 sync (?!s3:\/\/)/.test(l));
      expect(writes.length).toBeGreaterThan(4);
      for (const w of writes) { if (/s3:\/\//.test(w)) expect(w).toContain("s3://test-bucket"); else expect(w).toContain("ETEST"); }
      expect(writes.filter((l) => /prd-bucket|EPRD/.test(l))).toEqual([]);
      expect(log.filter((l) => /secretsmanager|\brds\b|cognito-idp|\blambda\b|\biam\b|route53|--delete/.test(l))).toEqual([]);
      expect(log.filter((l) => /^aws s3 cp/.test(l) && /config\.json/.test(l))).toEqual([]);
    }, 3 * SECONDS);
  });
});
