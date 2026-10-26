// build-prd-tarball.sh and tarball-pin-check.sh (PRODUCTION release 2026-10-26-redesign): the REAL builder runs on the real repository at the production-bound code commit (git archive, then a local
// `cdk synth` of the archived code for the bundled release templates); the tarball is extracted and the pin check is run with fake node/pnpm/npx. No AWS, no network, synthetic.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PKG_REL, REPO_ROOT, SCRIPTS_SRC, sh, sha256 } from "./operator-prd-fixtures.js";

vi.setConfig({ testTimeout: 600000, hookTimeout: 900000 });
const CODE_COMMIT = "f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45";
const PINS = {
  OGEVIA_EXPECT_COMMIT: CODE_COMMIT,
  OGEVIA_EXPECT_MIGRATIONS_SHA: "de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef",
  OGEVIA_EXPECT_0086_SHA: "8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f",
  OGEVIA_EXPECT_0086_DOWN_SHA: "d2773fdfdf502bb2b337b6e8fb888b72f9b9da660bc944f60a7ff60bec8d2942",
  OGEVIA_EXPECT_LOCKFILE_SHA: "7f5964021b4dbeeebf703fda27e1a509c164c1aecb4436f9324003b7de88dcae",
};
const hasCommit = sh("git", ["-C", REPO_ROOT, "cat-file", "-e", `${CODE_COMMIT}^{commit}`]).code === 0;
const BUILD = join(SCRIPTS_SRC, "build-prd-tarball.sh");
const PROC = join(REPO_ROOT, PKG_REL, `OPERATOR_PROCEDURE_PRD_${CODE_COMMIT.slice(0, 7)}.md`);
let out1 = "", out2 = "", root = "", bin = "", b1: ReturnType<typeof sh>, b2: ReturnType<typeof sh>;
const build = (outDir: string, args: string[] = [], env: Record<string, string> = {}) => sh("bash", [BUILD, "--out-dir", outDir, ...args], { cwd: REPO_ROOT, env: { OGEVIA_BUILD_TIME: "2026-10-26T12:00:00Z", OGEVIA_APPROVAL_REF: "owner-go-prd-20261027-01", ...env } });

beforeAll(() => {
  if (!hasCommit) return;
  out1 = mkdtempSync(join(tmpdir(), "prdtar1-")); out2 = mkdtempSync(join(tmpdir(), "prdtar2-"));
  b1 = build(out1, ["--code-commit", CODE_COMMIT]); b2 = build(out2, ["--code-commit", CODE_COMMIT]);
  if (b1.code === 0) {
    const ex = mkdtempSync(join(tmpdir(), "prdtar-ex-"));
    expect(sh("tar", ["-xzf", join(out1, "ogevia-prd-operator-f8cd7df.tar.gz"), "-C", ex]).code).toBe(0);
    root = join(ex, "ogevia-prd-0086-f8cd7df");
    mkdirSync(join(root, "node_modules"), { recursive: true }); mkdirSync(join(root, "infra/aws/node_modules"), { recursive: true });
    bin = join(ex, "bin"); mkdirSync(bin);
    const fake = (n: string, body: string) => { writeFileSync(join(bin, n), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, n), 0o755); };
    fake("node", "echo ${FAKE_NODE:-v22.22.0}"); fake("pnpm", "echo ${FAKE_PNPM:-9.15.4}"); fake("npx", 'echo "${FAKE_CDK:-2.1143.0 (build abc)}"');
  }
});
const run = it.skipIf(!hasCommit);   // the code commit must be in the clone (a shallow clone cannot build the package)
const pin = (env: Record<string, string> = {}) => sh("bash", [join(root, PKG_REL, "scripts/tarball-pin-check.sh")], { cwd: root, env: { PATH: `${bin}:${process.env.PATH}`, ...PINS, ...env } });
const reset = () => { const t = join(out1, "ogevia-prd-operator-f8cd7df.tar.gz"); rmSync(root, { recursive: true, force: true }); const ex = join(root, ".."); sh("tar", ["-xzf", t, "-C", ex]); mkdirSync(join(root, "node_modules"), { recursive: true }); mkdirSync(join(root, "infra/aws/node_modules"), { recursive: true }); };

describe("the builder", () => {
  run("builds from the production-bound code commit, self-verifies, and states every pin", () => {
    expect(PROC && existsSync(PROC), `the procedure ${PROC} must exist`).toBe(true);
    expect(b1.code, b1.out).toBe(0);
    for (const t of [`code commit        : ${CODE_COMMIT}`, "BUILT AND SELF-VERIFIED", `migration set 0001-0085 sha256 : ${PINS.OGEVIA_EXPECT_MIGRATIONS_SHA}`, `0086 up file sha256            : ${PINS.OGEVIA_EXPECT_0086_SHA}`, `0086 down file sha256          : ${PINS.OGEVIA_EXPECT_0086_DOWN_SHA}`, `pnpm-lock.yaml sha256          : ${PINS.OGEVIA_EXPECT_LOCKFILE_SHA}`]) expect(b1.out, t).toContain(t);
  });
  run("two builds of the same inputs are byte-identical", () => {
    expect(b2.code, b2.out).toBe(0);
    expect(sha256(readFileSync(join(out1, "ogevia-prd-operator-f8cd7df.tar.gz")))).toBe(sha256(readFileSync(join(out2, "ogevia-prd-operator-f8cd7df.tar.gz"))));
  });
  run("BUILD_INFO names the production release: commit, environment, the pinned Handler and Identity builds, 241 routes, the approval reference", () => {
    const bi = JSON.parse(readFileSync(join(root, "BUILD_INFO.json"), "utf8"));
    expect(bi).toMatchObject({ code_commit: CODE_COMMIT, environment: "PRODUCTION", api_routes_in_release: 241, handler_asset: "94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip", identity_asset: "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip", approval_ref: "owner-go-prd-20261027-01", package_folder: PKG_REL });
    expect(sh("sha256sum", ["-c", "--quiet", "PACKAGE_MANIFEST.sha256"], { cwd: root }).code).toBe(0);
  });
  run("carries the seven bundled release templates, the production scripts and 0086 only under db/pending; nothing else travels", () => {
    expect(readdirSync(join(root, PKG_REL, "release-templates")).sort()).toEqual(["Ogevia-prd-Auth.json", "Ogevia-prd-DatabaseSecret.json", "Ogevia-prd-EvidenceStorage.json", "Ogevia-prd-Observability.json", "Ogevia-prd-ServiceVerificationApi.json", "Ogevia-prd-WebHosting.json", "Ogevia-prod-NetworkEgress.json"]);
    for (const s of ["lib.sh", "pkg-lib.sh", "tarball-pin-check.sh", "p0-baseline-capture.sh", "p1-diff-report.sh", "tpl_diff.py", "ledger-recheck-prd.sh", "snapshot-verify-prd.sh", "apply-0086-prd.sh", "verify-0086.sql", "diff_gate_prd.py", "assembly_check_prd.py", "deploy-guard-prd.sh", "web-prd.sh", "route-smoke-prd.sh", "record-deployed-prd.sh", "new-route-keys.json"]) expect(existsSync(join(root, PKG_REL, "scripts", s)), s).toBe(true);
    for (const old of ["apply-0086-test.sh", "deploy-guard.sh", "d1-migrate-prd.sh", "d2-assemble-prd.sh", "prd_gate.py", "p2-gate.sh"]) expect(existsSync(join(root, PKG_REL, "scripts", old)), old).toBe(false);
    expect(readdirSync(join(root, "infra/aws/db/migrations")).filter((x) => x.endsWith(".sql"))).toHaveLength(85);
    expect(existsSync(join(root, "infra/aws/db/migrations/0086_staff_management.sql"))).toBe(false);
    expect(existsSync(join(root, "infra/aws/db/pending/migrations/0086_staff_management.sql"))).toBe(true);
    expect(sh("find", [root, "(", "-name", ".git", "-o", "-name", "_backup", "-o", "-name", "cdk.out", "-o", "-name", "*.png", "-o", "-name", "*.pdf", ")", "-not", "-path", "*/node_modules/*"]).stdout.trim()).toBe("");
    expect(sh("find", [root, "-type", "l", "-not", "-path", "*/node_modules/*"]).stdout.trim()).toBe("");
  });
  run("the bundled Auth template carries the app./admin. URLs, the API template 241 routes with the 13 staff routes, and no template names a TEST stack as its own", () => {
    const api = JSON.parse(readFileSync(join(root, PKG_REL, "release-templates/Ogevia-prd-ServiceVerificationApi.json"), "utf8"));
    const keys = Object.values<any>(api.Resources).filter((r) => r.Type === "AWS::ApiGatewayV2::Route").map((r) => r.Properties.RouteKey);
    expect(keys).toHaveLength(241); for (const k of JSON.parse(readFileSync(join(SCRIPTS_SRC, "new-route-keys.json"), "utf8"))) expect(keys).toContain(k);
    expect(readFileSync(join(root, PKG_REL, "release-templates/Ogevia-prd-Auth.json"), "utf8")).toContain("https://admin.ogevia.com/auth/callback");
  });
  run("refuses an output directory inside the repository, a malformed approval reference, an unknown commit and a missing option", () => {
    let r = build(join(REPO_ROOT, "tmp-prd-out-should-not-exist"), ["--code-commit", CODE_COMMIT]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("OUTSIDE the repository"); rmSync(join(REPO_ROOT, "tmp-prd-out-should-not-exist"), { recursive: true, force: true });
    r = build(mkdtempSync(join(tmpdir(), "prdtar3-")), ["--code-commit", CODE_COMMIT], { OGEVIA_APPROVAL_REF: "x y" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("OGEVIA_APPROVAL_REF");
    r = build(mkdtempSync(join(tmpdir(), "prdtar3-")), ["--code-commit", "0".repeat(40)]); expect(r.code, r.out).toBe(1); expect(r.out).toContain("cannot resolve");
    expect(sh("bash", [BUILD], { cwd: REPO_ROOT }).code).toBe(2);
  });
});

describe("tarball-pin-check.sh", () => {
  run("holds for the tarball as built, with the toolchain installed", () => {
    const r = pin(); expect(r.code, r.out).toBe(0); expect(r.out).toContain("PINS HOLD");
    for (const t of ["PASS BUILD_INFO code commit " + CODE_COMMIT, "PASS PACKAGE_MANIFEST verifies", "PASS no file outside the manifest", "PASS db/pending holds only the two 0086 files", "PASS cdk 2.1143.0"]) expect(r.out, t).toContain(t);
  });
  run("stops on a wrong commit, migration set, 0086 file, down file or lockfile pin, and on a missing pin", () => {
    for (const [k, v] of [["OGEVIA_EXPECT_COMMIT", "0".repeat(40)], ["OGEVIA_EXPECT_MIGRATIONS_SHA", "f".repeat(64)], ["OGEVIA_EXPECT_0086_SHA", "e".repeat(64)], ["OGEVIA_EXPECT_0086_DOWN_SHA", "d".repeat(64)], ["OGEVIA_EXPECT_LOCKFILE_SHA", "c".repeat(64)]] as const) {
      const r = pin({ [k]: v }); expect(r.code, `${k}: ${r.out}`).toBe(1); expect(r.out).toContain("FAIL"); expect(r.out).not.toContain("PINS HOLD");
    }
    expect(pin({ OGEVIA_EXPECT_COMMIT: "" }).code).toBe(2);
  });
  run("stops on a changed migration, a changed 0086 file, a stray file, a stray pending file, a missing file, 0086 inside db/migrations and a changed lockfile", () => {
    const cases: Array<[string, () => void]> = [
      ["a changed migration", () => writeFileSync(join(root, "infra/aws/db/migrations/0001_roles_schemas_extensions.sql"), "-- edited\n")],
      ["a changed 0086 file", () => writeFileSync(join(root, "infra/aws/db/pending/migrations/0086_staff_management.sql"), "-- edited\n")],
      ["a stray file", () => writeFileSync(join(root, "stray.txt"), "x")],
      ["a stray pending file", () => writeFileSync(join(root, "infra/aws/db/pending/migrations/0087_x.sql"), "x")],
      ["a missing script", () => rmSync(join(root, PKG_REL, "scripts/deploy-guard-prd.sh"))],
      ["a changed release template", () => writeFileSync(join(root, PKG_REL, "release-templates/Ogevia-prd-Auth.json"), "{}")],
      ["0086 inside db/migrations", () => cpSync(join(root, "infra/aws/db/pending/migrations/0086_staff_management.sql"), join(root, "infra/aws/db/migrations/0086_staff_management.sql"))],
      ["a changed lockfile", () => writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n")],
    ];
    for (const [label, mutate] of cases) { reset(); mutate(); const r = pin(); expect(r.code, `${label}: ${r.out}`).toBe(1); expect(r.out, label).toContain("FAIL"); expect(r.out).not.toContain("PINS HOLD"); }
    reset();
  });
  run("stops on the wrong toolchain (Node, pnpm, CDK) and on dependencies that are not installed", () => {
    for (const env of [{ FAKE_NODE: "v20.1.0" }, { FAKE_PNPM: "10.0.0" }, { FAKE_CDK: "2.1000.0 (build x)" }]) { const r = pin(env); expect(r.code, r.out).toBe(1); expect(r.out).toContain("FAIL"); }
    rmSync(join(root, "node_modules"), { recursive: true }); const r = pin(); expect(r.code, r.out).toBe(1); expect(r.out).toContain("dependencies are not installed");
    reset();
  });
  run("the approval reference in BUILD_INFO must agree with the GO message", () => {
    expect(pin({ OGEVIA_DEPLOY_APPROVAL: "owner-go-prd-20261027-01" }).code).toBe(0);
    const r = pin({ OGEVIA_DEPLOY_APPROVAL: "another-ref-000001" }); expect(r.code, r.out).toBe(1); expect(r.out).toContain("differs from OGEVIA_DEPLOY_APPROVAL");
  });
});
