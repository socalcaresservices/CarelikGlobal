import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { newApp } from "./helpers.js";

// `cdk synth` (the CLI) stamps every resource with Metadata "aws:cdk:path"; the context flag below is what turns that on. The production plan synthesizes with the CLI, so these tests must too.
const cliApp = () => { const a = newApp(); a.node.setContext("aws:cdk:enable-path-metadata", true); return a; };

// The production deploy script (plan / apply / rollback) run end to end against a FAKE aws, curl, npx and corepack, in a throw-away git checkout.
// No network, no AWS. The "live" production template is the real synthesized prd template (switch off) plus the six accepted routes production carries outside CDK;
// the candidate is the real synthesized template with the switch on.
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const fakes = fileURLToPath(new URL("./fixtures/fake-aws/", import.meta.url));
const DEPLOY = "production-signin-override-deploy.sh";
const RETAINED = ["GET /v1/business-documents", "POST /v1/business-documents", "GET /v1/reports/missing-visits", "POST /v1/shifts/{shiftId}/missing-visit", "POST /v1/checkin", "POST /v1/clients/{clientId}/qr-card"];
const GOOD_VERIFY = "== 10. VERDICT\nproduction database ogevia_prd\nVERDICT: PASS\n== done. Nothing was written.\n";

let root: string, repo: string, sha: string, live0: any, candidate: any;
const created: string[] = [];

const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
beforeAll(() => {
  const synth = (on: boolean) => {
    const cfg = { ...ENVIRONMENTS.prd, features: { ...ENVIRONMENTS.prd.features, signInOverride: on } } as OgeviaEnvironmentConfig;
    const api = buildOgeviaApp(cliApp(), cfg, "plan").find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!;
    return Template.fromStack(api.stack).toJSON() as any;
  };
  live0 = synth(false); candidate = synth(true);
  RETAINED.forEach((k, i) => { live0.Resources[`Retained${i}`] = structuredClone(live0.Resources.ApiGETv1attention23065B04); live0.Resources[`Retained${i}`].Properties.RouteKey = k; });
  root = mkdtempSync(join(tmpdir(), "signin-deploy-test-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, "infra/aws/scripts"), { recursive: true });
  for (const f of [DEPLOY, "production-signin-override-release.py"]) copyFileSync(join(scripts, f), join(repo, "infra/aws/scripts", f));
  git("init", "-q"); git("config", "user.email", "t@example.test"); git("config", "user.name", "t"); git("add", "-A"); git("commit", "-q", "-m", "release");
  sha = git("rev-parse", "HEAD").stdout.trim();
}, 120000);
afterAll(() => { rmSync(root, { recursive: true, force: true }); for (const w of created) rmSync(w, { recursive: true, force: true }); });

let fake: string, verify: string;
beforeEach(() => {
  fake = mkdtempSync(join(root, "fake-"));
  writeFileSync(join(fake, "live.json"), JSON.stringify(live0));
  writeFileSync(join(fake, "candidate.json"), JSON.stringify(candidate));
  verify = join(fake, "verify.txt"); writeFileSync(verify, GOOD_VERIFY);
  git("checkout", "-q", "--", "."); // a clean tracked tree
});

const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("bash", [join(repo, "infra/aws/scripts", DEPLOY), ...args], {
    encoding: "utf8", cwd: repo, timeout: 120000,
    env: { PATH: `${fakes}:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp", FAKE: fake, OGEVIA_SMOKE_SLEEP: "0",
           OGEVIA_DEPLOY_APPROVAL: "owner-signin-override-go", OGEVIA_RELEASE_SHA: sha, ...env },
  });
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  const w = /(\/tmp\/ogevia-signin-override\.[A-Za-z0-9]+)/.exec(text)?.[1];
  if (w && !created.includes(w)) created.push(w);
  return { status: r.status, text, workspace: w };
};
const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf8") : "");
const executes = () => calls().split("\n").filter((l) => l.startsWith("cloudformation execute-change-set")).length;
const liveKeys = () => Object.values<any>(JSON.parse(readFileSync(join(fake, "live.json"), "utf8")).Resources).filter((r) => r.Type === "AWS::ApiGatewayV2::Route").map((r) => r.Properties.RouteKey);
const OVERRIDE = ["GET /v1/signin-overrides", "POST /v1/caregivers/{caregiverRecordId}/signin-override"];
const planned = () => { const p = run(["plan", verify]); expect(p.status, p.text).toBe(0); expect(p.workspace).toBeTruthy(); return p.workspace!; };

describe("plan", () => {
  it("builds and checks the change, creates a change set, and changes nothing in production", () => {
    const p = run(["plan", verify]);
    expect(p.status, p.text).toBe(0);
    expect(p.text).toContain("PLAN READY. Nothing is changed yet.");
    expect(p.text).toContain("PASS: the live production template plus exactly two JWT routes");
    expect(p.text).toContain("PASS: the change set adds exactly the two sign-in override routes");
    expect(executes()).toBe(0);
    expect(liveKeys().some((k) => OVERRIDE.includes(k))).toBe(false);
    expect(readFileSync(join(p.workspace!, "state.env"), "utf8")).toContain(`SHA=${sha}`);
    expect(calls()).toContain("cloudformation create-change-set");
  });

  it.each([
    ["no owner approval", {}, { OGEVIA_DEPLOY_APPROVAL: "" }, /owner approval is missing/],
    ["the wrong AWS account", {}, { FAKE_ACCOUNT: "111111111111" }, /wrong AWS account/],
    ["no release SHA", {}, { OGEVIA_RELEASE_SHA: "" }, /40-character/],
    ["a different release SHA", {}, { OGEVIA_RELEASE_SHA: "0".repeat(40) }, /not at the release SHA/],
    ["a stack that is not settled", {}, { FAKE_STATUS: "UPDATE_IN_PROGRESS" }, /not settled/],
    ["a different API", {}, { FAKE_API_ID: "s0epy5rgzb" }, /expected zk527zk4ua/],
    ["a Handler that is not production's", {}, { FAKE_HANDLER_LINE: "FAKESHA=\togevia_sv_test\tprod" }, /not the production Handler/],
  ])("refuses %s and changes nothing", (_n, _x, env, re) => {
    const p = run(["plan", verify], env as Record<string, string>);
    expect(p.status).not.toBe(0);
    expect(p.text).toMatch(re);
    expect(executes()).toBe(0);
    expect(calls()).not.toContain("create-change-set");
  });

  it("refuses a checkout with modified tracked files", () => {
    writeFileSync(join(repo, "infra/aws/scripts/production-signin-override-release.py"), "# edited\n", { flag: "a" });
    try { const p = run(["plan", verify]); expect(p.status).not.toBe(0); expect(p.text).toMatch(/tracked files are modified/); } finally { git("checkout", "-q", "--", "."); }
  });

  it.each([
    ["a verification that failed", "VERDICT: FAIL\nownership\n", /did not print VERDICT: PASS/],
    ["a verification with no verdict", "ogevia_prd\nnothing here\n", /did not print VERDICT: PASS/],
    ["a verification that does not name ogevia_prd", "VERDICT: PASS\n", /does not name ogevia_prd/],
  ])("refuses %s", (_n, content, re) => {
    writeFileSync(verify, content);
    const p = run(["plan", verify]);
    expect(p.status).not.toBe(0); expect(p.text).toMatch(re); expect(calls()).not.toContain("create-change-set");
  });

  it("refuses a verification older than two hours, and a missing one", () => {
    const old = new Date(Date.now() - 3 * 3600e3); utimesSync(verify, old, old);
    expect(run(["plan", verify]).text).toMatch(/older than 2 hours/);
    expect(run(["plan", join(fake, "absent.txt")]).text).toMatch(/saved output of VERIFY_PRODUCTION_DB/);
  });

  it("refuses a live stack that already has an override route", () => {
    const live = structuredClone(candidate); RETAINED.forEach((k, i) => { live.Resources[`Retained${i}`] = structuredClone(live.Resources.ApiGETv1attention23065B04); live.Resources[`Retained${i}`].Properties.RouteKey = k; });
    writeFileSync(join(fake, "live.json"), JSON.stringify(live));
    const p = run(["plan", verify]); expect(p.status).not.toBe(0); expect(p.text).toMatch(/override routes are not absent|already has the route/); expect(calls()).not.toContain("create-change-set");
  });

  it("refuses a candidate that also enables bulk import", () => {
    const c = structuredClone(candidate); c.Resources.Import = structuredClone(c.Resources.ApiGETv1attention23065B04); c.Resources.Import.Properties.RouteKey = "POST /v1/imports/{kind}";
    writeFileSync(join(fake, "candidate.json"), JSON.stringify(c));
    const p = run(["plan", verify]); expect(p.status).not.toBe(0); expect(p.text).toMatch(/must stay off/); expect(calls()).not.toContain("create-change-set");
  });

  it("deletes a change set that holds anything besides the two routes, and applies nothing", () => {
    const p = run(["plan", verify], { FAKE_EXTRA_CHANGE: "1" });
    expect(p.status).not.toBe(0);
    expect(p.text).toMatch(/not exactly the two routes; it was deleted/);
    expect(readdirSync(fake).some((f) => f.startsWith("deleted-"))).toBe(true);
    expect(executes()).toBe(0);
  });
});

describe("apply", () => {
  it("executes the planned change set once, verifies it, and the live stack gains exactly the two routes", () => {
    const w = planned();
    const before = liveKeys().length;
    const a = run(["apply", w]);
    expect(a.status, a.text).toBe(0);
    expect(a.text).toContain("SIGN-IN OVERRIDE ROUTES ARE LIVE IN PRODUCTION.");
    expect(a.text).toContain("GET  no token    : 401");
    expect(executes()).toBe(1);
    const keys = liveKeys();
    expect(keys.length).toBe(before + 2);
    for (const k of [...OVERRIDE, ...RETAINED]) expect(keys, k).toContain(k);   // the six accepted routes are still there
    expect(keys.some((k) => ["POST /v1/imports/{kind}", "GET /v1/staff/duplicates"].includes(k))).toBe(false);
  });

  it.each([
    ["no owner approval", { OGEVIA_DEPLOY_APPROVAL: "" }, /owner approval is missing/],
    ["a release SHA that is not the planned one", { OGEVIA_RELEASE_SHA: "1".repeat(40) }, /must be the SHA that was planned/],
    ["no release SHA", { OGEVIA_RELEASE_SHA: "" }, /must be the SHA that was planned/],
  ])("refuses %s", (_n, env, re) => {
    const w = planned();
    const a = run(["apply", w], env as Record<string, string>);
    expect(a.status).not.toBe(0); expect(a.text).toMatch(re); expect(executes()).toBe(0);
  });

  it("refuses a workspace path it did not create", () => {
    for (const bad of ["/etc", "/tmp", "/tmp/ogevia-signin-override.", `${fake}`, ""]) {
      const a = run(["apply", bad]); expect(a.status, bad).not.toBe(0); expect(a.text, bad).toMatch(/invalid or missing workspace/);
    }
    expect(executes()).toBe(0);
  });

  it("stops without applying when someone changed the production stack after the plan", () => {
    const w = planned();
    const live = JSON.parse(readFileSync(join(fake, "live.json"), "utf8")); live.Resources.Retained0.Properties.RouteKey = "GET /v1/something-else";
    writeFileSync(join(fake, "live.json"), JSON.stringify(live));
    const a = run(["apply", w]); expect(a.status).not.toBe(0); expect(a.text).toMatch(/templates differ|AssertionError/); expect(executes()).toBe(0);
  });

  it("rolls itself back when the smoke check fails, leaving the stack as captured", () => {
    const w = planned();
    const original = JSON.stringify(JSON.parse(readFileSync(join(fake, "live.json"), "utf8")));
    const a = run(["apply", w], { FAKE_CURL_CODE: "404" });
    expect(a.status).not.toBe(0);
    expect(a.text).toContain("SMOKE FAILED: rolling back.");
    expect(a.text).toContain("PASS: the rollback change set removes exactly the two sign-in override routes");
    expect(a.text).toContain("ROLLED BACK");
    expect(executes()).toBe(2);
    expect(JSON.stringify(JSON.parse(readFileSync(join(fake, "live.json"), "utf8")))).toBe(original);
  });

  it("does not roll back by itself when the stack update fails: CloudFormation does that, and the operator is told what to send", () => {
    const w = planned();
    const a = run(["apply", w], { FAKE_WAIT_FAIL: "1" });
    expect(a.status).toBe(1); expect(a.text).toMatch(/describe-stack-events/); expect(executes()).toBe(1);
  });

  it("rolls back when the live stack after the change is not the planned template", () => {
    const w = planned();
    const a = run(["apply", w], { FAKE_EXECUTE_NOOP: "1" });
    expect(a.status).not.toBe(0); expect(a.text).toMatch(/rolling back/);
  });
});

describe("rollback", () => {
  it("removes exactly the two routes after an apply, and the stack equals the captured template", () => {
    const w = planned();
    const original = JSON.stringify(JSON.parse(readFileSync(join(fake, "live.json"), "utf8")));
    expect(run(["apply", w]).status).toBe(0);
    const r = run(["rollback", w]);
    expect(r.status, r.text).toBe(0);
    expect(r.text).toContain("ROLLED BACK");
    expect(liveKeys().some((k) => OVERRIDE.includes(k))).toBe(false);
    expect(JSON.stringify(JSON.parse(readFileSync(join(fake, "live.json"), "utf8")))).toBe(original);
  });
  it("refuses a workspace it did not create", () => {
    expect(run(["rollback", "/tmp"]).text).toMatch(/invalid or missing workspace/);
  });
});

describe("the script itself", () => {
  const text = readFileSync(join(scripts, DEPLOY), "utf8");
  it("never deploys the CDK stack, reads no secret, and calls only the AWS operations it needs", () => {
    const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/cdk deploy|secretsmanager|delete-route|create-route|delete-stack|update-stack/);
    const used = new Set([...code.matchAll(/\bA ([a-z0-9]+) ([a-z-]+)/g)].map((m) => `${m[1]} ${m[2]}`));
    const allowed = new Set(["sts get-caller-identity", "cloudformation get-template", "cloudformation describe-stacks", "cloudformation list-stack-resources", "cloudformation create-change-set",
      "cloudformation wait", "cloudformation describe-change-set", "cloudformation delete-change-set", "cloudformation execute-change-set", "lambda get-function-configuration", "s3 cp",
      "apigatewayv2 get-routes", "logs filter-log-events"]);
    expect([...used].filter((x) => !allowed.has(x))).toEqual([]);
    for (const verb of ["cloudformation create-change-set", "cloudformation execute-change-set", "s3 cp"]) expect(used.has(verb), verb).toBe(true);
  });
  it("pages through the stack's resources: describe-stack-resources returns only the first 100 of ~270 and would miss the Handler (found on the first real run)", () => {
    const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toContain("describe-stack-resources");
    expect(code).toContain("list-stack-resources");
  });
  it("is bash, executable and syntax-valid", () => {
    expect(spawnSync("bash", ["-n", join(scripts, DEPLOY)]).status).toBe(0);
    chmodSync(join(fakes, "aws"), 0o755);
  });
});
