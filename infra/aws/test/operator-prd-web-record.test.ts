// PRODUCTION 2026-10-26-redesign: the read-only baseline capture (p0, with the post-check inputs this release added), the web guard (web-prd.sh: build, publish, verify, rollback) and the deployed
// record (record-deployed-prd.sh), against a MOCKED aws CLI (stateful web bucket served as the origin), a fake vite and the REAL synthesized templates. No AWS, no network, synthetic.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { API, AUTH, NET, PKG_REL, PRD_STACKS, SCRIPTS_SRC, liveOf, release, sha256, synth } from "./operator-prd-fixtures.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 300000 });
const MOCKSRC = fileURLToPath(new URL("./operator-prd-aws-mock.sh", import.meta.url));
const CODE = "f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45", PREV = "e80b770210c54e423d28ecf48e00f1dda9506cec", PRD_API = "zk527zk4ua", REF = "owner-go-prd-20261027-01";
const work = mkdtempSync(join(tmpdir(), "prdweb-"));
const BIN = join(work, "bin"), MOCK = join(work, "mock"), OUT = join(work, "before"), TB = join(work, "pkg"), SCRIPTS = join(TB, PKG_REL, "scripts"), WEBOUT = join(work, "web-out");
const ALL = [...PRD_STACKS, NET];
const w = (p: string, v: unknown) => writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
const calls = () => (existsSync(join(MOCK, "aws-calls.log")) ? readFileSync(join(MOCK, "aws-calls.log"), "utf8") : "");
const writes = () => (existsSync(join(MOCK, "writes.log")) ? readFileSync(join(MOCK, "writes.log"), "utf8") : "");
let allWrites = "";
const clearLogs = () => { allWrites += writes(); for (const f of ["aws-calls.log", "writes.log"]) rmSync(join(MOCK, f), { force: true }); };
const setLive = (state: "before" | "after") => { for (const s of ALL) w(join(MOCK, "templates", `${s}.json`), state === "before" ? liveOf(s) : release(s)); };
const bundle = (version: string | null = PREV, extra = "") => `const e={VITE_APP_ENV:"production",VITE_AUTH_PROVIDER:"cognito",VITE_COGNITO_CLIENT_ID:"4abcdefghijk",VITE_COGNITO_DOMAIN:"https://ogevia-prd.auth.us-west-2.amazoncognito.com",VITE_COGNITO_REGION:"us-west-2",VITE_COGNITO_USER_POOL_ID:"us-west-2_FHJoX71ca",VITE_SV_API_BASE_URL:"https://${PRD_API}.execute-api.us-west-2.amazonaws.com"${version ? `,VITE_APP_VERSION:"${version}"` : ""}${extra}};\n`;
function setLiveWeb(js = bundle()) {
  rmSync(join(MOCK, "web"), { recursive: true, force: true }); mkdirSync(join(MOCK, "web/assets"), { recursive: true });
  w(join(MOCK, "web/index.html"), '<!doctype html><script type="module" src="/assets/index-OLD111.js"></script>\n'); w(join(MOCK, "web/assets/index-OLD111.js"), js); w(join(MOCK, "web/assets/style-OLD.css"), "body{}");
}
const sh = (cmd: string) => spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
const rehash = () => sh(`cd ${TB} && find . -type f ! -name PACKAGE_MANIFEST.sha256 -not -path '*/node_modules/*' -printf '%P\\n' | LC_ALL=C sort | xargs -d '\\n' sha256sum > PACKAGE_MANIFEST.sha256`);
const env = (extra: Record<string, string> = {}) => ({ OGEVIA_EXPECT_COMMIT: CODE, OGEVIA_PRD_WEB_OUT: WEBOUT, OGEVIA_DEPLOY_APPROVAL: REF, ...extra });
async function run(script: string, args: string[] = [], e: Record<string, string> = {}, input = ""): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("bash", [join(SCRIPTS, script), ...args], { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, MOCK_DIR: MOCK, HOME: work, OGEVIA_PRD_BEFORE: OUT, OGEVIA_CDN_WAIT: "0", ...e }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.stdin.on("error", () => undefined); p.stdin.end(input);
    p.on("close", (c) => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } resolve({ code: c, out }); });
  });
}
const fakeVite = `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do [[ "$1" == --outDir ]] && OUTD="$2"; shift; done
mkdir -p "$OUTD/assets"; { echo -n 'const e={'; env | grep '^VITE_' | LC_ALL=C sort | sed -E 's/^([^=]*)=(.*)$/\\1:"\\2"/' | paste -sd, ; echo -n "\${FAKE_VITE_EXTRA:-}"; echo '};'; } > "$OUTD/assets/index-NEW222.js"
echo '<!doctype html><script type="module" src="/assets/index-NEW222.js"></script>' > "$OUTD/index.html"; echo 'body{}' > "$OUTD/assets/style-NEW.css"; [[ -n "\${FAKE_VITE_CONFIG:-}" ]] && echo '{}' > "$OUTD/config.json"; exit 0
`;
beforeAll(() => {
  synth();
  for (const d of [BIN, join(MOCK, "templates"), OUT, join(TB, "apps/web/node_modules/.bin")]) mkdirSync(d, { recursive: true });
  copyFileSync(MOCKSRC, join(BIN, "aws")); chmodSync(join(BIN, "aws"), 0o755);
  w(join(MOCK, "code.zip"), "PK mock lambda zip bytes"); w(join(MOCK, "endpoint-policy.json"), { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: ["arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2/*", "arn:aws:s3:::ogevia-prd-signature-evidence-300094796789-us-west-2/*"] }] });
  cpSync(SCRIPTS_SRC, SCRIPTS, { recursive: true }); cpSync(synth().rel, join(TB, PKG_REL, "release-templates"), { recursive: true });
  w(join(TB, "apps/web/node_modules/.bin/vite"), fakeVite); chmodSync(join(TB, "apps/web/node_modules/.bin/vite"), 0o755);
  w(join(TB, "BUILD_INFO.json"), { code_commit: CODE }); rehash();
  setLive("before"); setLiveWeb();
});

describe("p0-baseline-capture.sh: read-only; captures what recovery and the post-checks need", () => {
  it("captures production (all seven stacks, the Cognito client, the routes, the API's own CORS), passes, and changes nothing in AWS", async () => {
    clearLogs(); const r = await run("p0-baseline-capture.sh"); expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("BASELINE CAPTURED"); expect(r.out).toContain("PRODUCTION"); expect(r.out).toContain("app client callbacks"); expect(r.out).toContain("API CORS origins");
    for (const f of ["routes-before.json", "cors-before.json", "api-id.txt", "cognito-client-before.json", "lambda-config-before.json", "handler-function-name.txt", "previous-api-asset.txt", "web-before.sha256", "served-main.js"]) expect(existsSync(join(OUT, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(OUT, "cognito-client-before.json"), "utf8")).callbacks).toEqual(["https://x.cloudfront.net/auth/callback"]);
    expect(readFileSync(join(OUT, "api-id.txt"), "utf8").trim()).toBe(PRD_API);
    expect(writes()).toBe("");
    for (const l of calls().split("\n").filter(Boolean)) expect(l.split(" ").slice(0, 2).join(" "), l).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda (get-function-configuration|get-function)|s3api (head-object|list-buckets|get-bucket-versioning|get-public-access-block)|apigatewayv2 (get-routes|get-api)|events list-rules|s3 sync|ec2 describe-vpc-endpoints|rds (describe-db-instances|describe-db-snapshots)|cognito-idp (list-user-pools|describe-user-pool|describe-user-pool-client)|secretsmanager describe-secret)$/);
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
  });
});

describe("web-prd.sh build: production's own embedded values plus the code commit as the version", () => {
  it("replaces the previous release's version string, reuses every other embedded value, and accepts only that difference", async () => {
    const r = await run("web-prd.sh", ["build"], env()); expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("exactly the production values plus"); expect(r.out).toContain("WEB BUILD READY");
    const js = readFileSync(join(WEBOUT, "assets/index-NEW222.js"), "utf8");
    expect(js).toContain(`VITE_APP_VERSION:"${CODE}"`); expect(js).not.toContain(PREV); expect(js).toContain('VITE_APP_ENV:"production"'); expect(js).toContain(`${PRD_API}.execute-api`); expect(js).toContain('VITE_COGNITO_USER_POOL_ID:"us-west-2_FHJoX71ca"');
    expect(writes()).not.toContain("s3 sync");   // build changes nothing in AWS
  });
  it("refuses a wrong commit, a damaged package, an unexpected embedded value, a config.json in the output, a non-production bundle, an unknown previous version and the TEST API", async () => {
    for (const [e, text] of [[{ OGEVIA_EXPECT_COMMIT: "0".repeat(40) }, "BUILD_INFO.json of this package does not name"], [{ OGEVIA_EXPECT_COMMIT: "" }, "40-character code commit"], [{ FAKE_VITE_EXTRA: ',VITE_SURPRISE:"1"' }, "differ from production's plus the version"], [{ FAKE_VITE_CONFIG: "1" }, "config.json"]] as [Record<string, string>, string][]) {
      const r = await run("web-prd.sh", ["build"], env(e)); expect(r.code === 1 || r.code === 2, `${text}: ${r.out}`).toBe(true); expect(r.out).toContain(text);
    }
    w(join(TB, "x"), "1"); const m = await run("web-prd.sh", ["build"], env()); expect(m.code).toBe(1); expect(m.out).toContain("not in its manifest"); rmSync(join(TB, "x"));
    const keep = readFileSync(join(OUT, "served-main.js"), "utf8");
    w(join(OUT, "served-main.js"), keep.replace('VITE_APP_ENV:"production"', 'VITE_APP_ENV:"test"')); expect((await run("web-prd.sh", ["build"], env())).out).toContain("not marked");
    w(join(OUT, "served-main.js"), keep.replace(PREV, "a".repeat(40))); let v = await run("web-prd.sh", ["build"], env()); expect(v.code).toBe(1); expect(v.out).toContain("is not the previous release");
    w(join(OUT, "served-main.js"), keep.replace(`,VITE_APP_VERSION:"${PREV}"`, "")); v = await run("web-prd.sh", ["build"], env()); expect(v.code).toBe(1); expect(v.out).toContain("is not the previous release");
    w(join(OUT, "served-main.js"), keep.replace(PRD_API, "s0epy5rgzb")); const a = await run("web-prd.sh", ["build"], env()); expect(a.code).toBe(1); expect(a.out).toContain("not the production API");
    w(join(OUT, "served-main.js"), keep); const ok = await run("web-prd.sh", ["build"], env()); expect(ok.code, ok.out).toBe(0);
  });
});

describe("web-prd.sh publish / verify / rollback", () => {
  it("publish refuses without each prerequisite and, on a wrong phrase, changes nothing", async () => {
    clearLogs(); const before = sh(`cd ${MOCK}/web && find . -type f | sort | xargs sha256sum`).stdout;
    rmSync(join(OUT, "db-0086.ok"), { force: true }); rmSync(join(OUT, "api-at-release.ok"), { force: true });
    const P = "PUBLISH-WEB-Ogevia-prd\n";
    let r = await run("web-prd.sh", ["publish"], env(), P); expect(r.code).toBe(1); expect(r.out).toContain("db-0086.ok");
    w(join(OUT, "db-0086.ok"), "85|0085|0086\n");
    r = await run("web-prd.sh", ["publish"], env(), P); expect(r.code).toBe(1); expect(r.out).toContain("api-at-release.ok");
    w(join(OUT, "api-at-release.ok"), "newsha\n");
    w(join(OUT, "db-0086.ok"), "85|0085\n"); r = await run("web-prd.sh", ["publish"], env(), P); expect(r.code).toBe(1); expect(r.out).toContain("0086 is not applied"); w(join(OUT, "db-0086.ok"), "85|0085|0086\n");
    r = await run("web-prd.sh", ["publish"], env({ OGEVIA_DEPLOY_APPROVAL: "x" }), P); expect(r.code).toBe(1); expect(r.out).toContain("approval reference");
    w(join(OUT, "web-before/index.html"), "damaged"); r = await run("web-prd.sh", ["publish"], env(), P); expect(r.code).toBe(1); expect(r.out).toContain("recovery capture"); copyFileSync(join(MOCK, "web/index.html"), join(OUT, "web-before/index.html"));
    w(join(WEBOUT, "assets/style-NEW.css"), "tampered"); r = await run("web-prd.sh", ["publish"], env(), P); expect(r.code).toBe(1); expect(r.out).toContain("does not match its manifest"); w(join(WEBOUT, "assets/style-NEW.css"), "body{}\n");
    r = await run("web-prd.sh", ["publish"], env(), "publish\n"); expect(r.code).toBe(0); expect(r.out).toContain("Declined");
    r = await run("web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd-TEST\n"); expect(r.code).toBe(0); expect(r.out).toContain("Declined");
    w(join(MOCK, "web/index.html"), readFileSync(join(MOCK, "web/index.html"), "utf8") + "<!-- someone published -->"); r = await run("web-prd.sh", ["publish"], env(), P); expect(r.code).toBe(1); expect(r.out).toContain("changed since the capture"); copyFileSync(join(OUT, "web-before/index.html"), join(MOCK, "web/index.html"));
    expect(writes()).toBe(""); expect(sh(`cd ${MOCK}/web && find . -type f | sort | xargs sha256sum`).stdout).toBe(before);
  });
  it("publish uploads (no --delete) to the production bucket, invalidates, and verifies the served page: byte-identical index, VITE_APP_VERSION = the commit, production, only the production API host", async () => {
    clearLogs(); const r = await run("web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(r.code, r.out).toBe(0);
    for (const t of ["the served index.html is byte-identical", `the bundle carries VITE_APP_VERSION:"${CODE}"`, 'built for production (VITE_APP_ENV:"production")', "no other API host in the bundle", "PUBLISHED AND VERIFIED"]) expect(r.out, t).toContain(t);
    const wr = writes(); expect(wr).toContain("s3 sync"); expect(wr).toContain("ogevia-prd-webhosting-mockbucket"); expect(wr).toContain("cloudfront create-invalidation --distribution-id EMOCK123"); expect(wr).toContain("--cache-control no-cache"); expect(wr).not.toContain("--delete");
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false); expect(existsSync(join(MOCK, "web/assets/index-OLD111.js"))).toBe(true);
    const v = await run("web-prd.sh", ["verify"], env()); expect(v.code, v.out).toBe(0); expect(v.out).toContain("WEB VERIFIED");
  });
  it("verify FAILS when the served page is not the build, carries the wrong version or environment, or calls another API", async () => {
    const idx = readFileSync(join(MOCK, "web/index.html"), "utf8"); const mainJs = join(MOCK, "web/assets/index-NEW222.js"); const js = readFileSync(mainJs, "utf8");
    w(join(MOCK, "web/index.html"), idx + "<!-- other -->"); let r = await run("web-prd.sh", ["verify"], env()); expect(r.code).toBe(1); expect(r.out).toContain("differs from"); w(join(MOCK, "web/index.html"), idx);
    w(mainJs, js.replace(CODE, "1".repeat(40))); r = await run("web-prd.sh", ["verify"], env()); expect(r.code).toBe(1); expect(r.out).toContain("version string is");
    w(mainJs, js.replace('VITE_APP_ENV:"production"', 'VITE_APP_ENV:"test"')); r = await run("web-prd.sh", ["verify"], env()); expect(r.code).toBe(1); expect(r.out).toContain("not production");
    w(mainJs, js.replace("};", ',X:"https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com"};')); r = await run("web-prd.sh", ["verify"], env()); expect(r.code).toBe(1); expect(r.out).toContain("another API host");
    w(mainJs, js);
  });
  it("rollback-verify proves the recovery source; rollback restores damaged/missing captured files and the captured index.html (previous version string verified); nothing is deleted", async () => {
    clearLogs(); const rv = await run("web-prd.sh", ["rollback-verify"], env()); expect(rv.code, rv.out).toBe(0); expect(rv.out).toContain("ROLLBACK SOURCE OK"); expect(writes()).toBe("");
    rmSync(join(MOCK, "web/assets/style-OLD.css")); w(join(MOCK, "web/assets/index-OLD111.js"), "damaged");
    const rv2 = await run("web-prd.sh", ["rollback-verify"], env()); expect(rv2.code).toBe(0); expect(rv2.out).toContain("missing from the bucket: assets/style-OLD.css"); expect(rv2.out).toContain("size differs: assets/index-OLD111.js");
    expect((await run("web-prd.sh", ["rollback"], env(), "yes\n")).out).toContain("Declined");
    const r = await run("web-prd.sh", ["rollback"], env(), "RESTORE-WEB-Ogevia-prd\n"); expect(r.code, r.out).toBe(0);
    for (const t of ["restored assets/style-OLD.css", "restored assets/index-OLD111.js", "ROLLED BACK AND VERIFIED", `the bundle carries VITE_APP_VERSION:"${PREV}"`]) expect(r.out, t).toContain(t);
    expect(readFileSync(join(MOCK, "web/index.html"), "utf8")).toBe(readFileSync(join(OUT, "web-before/index.html"), "utf8")); expect(writes()).not.toContain("--delete");
  });
});

describe("record-deployed-prd.sh: every deployed artifact must map to the commit", () => {
  const rec = (extra: Record<string, string> = {}) => ({ OGEVIA_EXPECT_COMMIT: CODE, OGEVIA_TARBALL_SHA256: "a".repeat(64), OGEVIA_DEPLOY_APPROVAL: REF, OGEVIA_PRD_WEB_OUT: WEBOUT, ...extra });
  it("records only when every artifact maps to the release; fails on an unchanged Lambda, a wrong asset, an ERROR event, a disabled sweep rule, a missing marker, an unsettled Auth stack or a web that is not the release", async () => {
    setLive("after"); w(join(MOCK, "code.zip"), "PK new lambda zip bytes"); w(join(OUT, "api-at-release.ok"), "newsha\n"); w(join(OUT, "db-0086.ok"), "85|0085|0086\n"); w(join(OUT, "db-0086.snapshot"), "ogevia-prod-postgres-pre-0086-prd-202610270410\n");
    const pub = await run("web-prd.sh", ["publish"], env(), "PUBLISH-WEB-Ogevia-prd\n"); expect(pub.code, pub.out).toBe(0);
    clearLogs(); const ok = await run("record-deployed-prd.sh", [], rec()); expect(ok.code, ok.out).toBe(0);
    for (const t of ["the migration marker says 85|0085|0086", "the DEPLOYED stack's Handler asset is the release's pinned build", "ComplianceSweep rule", "no ERROR event", "the served web is the release build", `DEPLOYED SHA          : ${CODE}`, "Ogevia-prd-Auth UPDATE_COMPLETE", "RECORDED"]) expect(ok.out, t).toContain(t);
    expect(readFileSync(join(OUT, "DEPLOYED_RECORD.txt"), "utf8")).toContain("pre-release snapshot  : ogevia-prod-postgres-pre-0086-prd-202610270410");
    const t = async (e: Record<string, string>, text: string) => { const r = await run("record-deployed-prd.sh", [], rec(e)); expect(r.code, `${text}: ${r.out}`).toBe(1); expect(r.out).toContain(text); };
    await t({ MOCK_LOG_ERRORS: "2" }, "ERROR events in"); await t({ MOCK_RULE_STATE: "DISABLED" }, "no ENABLED ComplianceSweep rule"); await t({ MOCK_STACK_STATUS: "UPDATE_ROLLBACK_COMPLETE" }, "is UPDATE_ROLLBACK_COMPLETE");
    w(join(MOCK, "code.zip"), "PK mock lambda zip bytes"); await t({}, "equals the one before"); w(join(MOCK, "code.zip"), "PK new lambda zip bytes");
    setLive("before"); await t({}, "the deployed Handler asset is"); setLive("after");
    rmSync(join(OUT, "db-0086.ok")); await t({}, "no 85|0085|0086 marker"); w(join(OUT, "db-0086.ok"), "85|0085|0086\n");
    const idx = readFileSync(join(MOCK, "web/index.html"), "utf8"); w(join(MOCK, "web/index.html"), idx + "x"); await t({}, "web verification failed"); w(join(MOCK, "web/index.html"), idx);
    expect((await run("record-deployed-prd.sh", [], { OGEVIA_EXPECT_COMMIT: "bad" })).code).toBe(2);
    expect((await run("record-deployed-prd.sh", [], rec({ OGEVIA_EXPECT_COMMIT: "0".repeat(40) }))).code).toBe(2);
    for (const l of calls().split("\n").filter(Boolean)) expect(l.split(" ").slice(0, 2).join(" "), l).toMatch(/^(sts get-caller-identity|cloudformation (describe-stacks|get-template|list-stack-resources)|lambda get-function-configuration|events describe-rule|logs filter-log-events)$/);
  });
  it("every write verb of the whole file were s3 sync/cp to the production bucket or one invalidation of its distribution, nothing was deleted, nothing unexpected was called", () => {
    expect(existsSync(join(MOCK, "unexpected.log"))).toBe(false);
    for (const l of (allWrites + writes()).split("\n").filter(Boolean)) expect(l, l).toMatch(/^(s3 sync |s3 cp .*s3:\/\/ogevia-prd-webhosting-mockbucket\/|cloudfront create-invalidation --distribution-id EMOCK123)/);
    expect(allWrites + writes()).not.toContain("--delete");
    void sha256; void AUTH; void API;
  });
});
