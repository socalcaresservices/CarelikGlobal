// The production DISCOVERY package (docs/releases/2026-10-26-redesign-production/build-discovery-package.sh): built for real (cdk synth, local), then inspected.
// It must carry the read-only discovery scripts and the seven release templates, and NONE of the older release's pinned stage B-E scripts. No AWS.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BUILDER = join(REPO, "docs/releases/2026-10-26-redesign-production/build-discovery-package.sh");
const HANDLER = "2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip";   // the build of the fb491a5 candidate
const IDENTITY = "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip";
const out = mkdtempSync(join(tmpdir(), "prd-disc-"));
let build: { status: number | null; text: string };
const root = join(out, "ogevia-prd-discovery");
beforeAll(() => { const r = spawnSync("bash", [BUILDER, out], { cwd: REPO, encoding: "utf8" }); build = { status: r.status, text: (r.stdout ?? "") + (r.stderr ?? "") }; });
const listing = (d: string, rel = ""): string[] => readdirSync(join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listing(d, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]));

describe("production discovery package", () => {
  it("builds, and its manifest and tarball verify", () => {
    expect(build.status, build.text).toBe(0);
    expect(existsSync(join(out, "ogevia-prd-discovery.tar.gz"))).toBe(true);
    expect(spawnSync("sha256sum", ["-c", "--quiet", "MANIFEST.sha256"], { cwd: root, encoding: "utf8" }).status).toBe(0);
    const t = spawnSync("tar", ["-tzf", join(out, "ogevia-prd-discovery.tar.gz")], { encoding: "utf8" });
    expect(t.status).toBe(0); expect(t.stdout).toContain("ogevia-prd-discovery/BUILD_INFO.json");
  });
  it("carries exactly the read-only scripts and the seven release templates, including Ogevia-prd-Auth", () => {
    expect(readdirSync(join(root, "scripts")).sort()).toEqual(["ledger-prd-read.sh", "lib.sh", "p0-baseline-capture.sh", "p1-diff-report.sh", "tpl_diff.py"]);
    expect(readdirSync(join(root, "release-templates")).sort()).toEqual(["Ogevia-prd-Auth.json", "Ogevia-prd-DatabaseSecret.json", "Ogevia-prd-EvidenceStorage.json", "Ogevia-prd-Observability.json", "Ogevia-prd-ServiceVerificationApi.json", "Ogevia-prd-WebHosting.json", "Ogevia-prod-NetworkEgress.json"]);
    for (const s of ["lib.sh", "p0-baseline-capture.sh", "p1-diff-report.sh", "ledger-prd-read.sh"]) expect(spawnSync("bash", ["-n", join(root, "scripts", s)]).status, s).toBe(0);
  });
  it("ships NONE of the older release's pinned stage B-E scripts, and nothing in it names the older release", () => {
    const files = listing(root);
    for (const bad of ["d1-migrate-prd.sh", "d2-assemble-prd.sh", "d3-web-prd.sh", "deploy-guard-prd.sh", "e1-record-deployed-prd.sh", "f1-owner-transition-prd.sh", "c1-snapshot-prd.sh", "p2-gate.sh", "prd_gate.py", "prd_assembly_check.py", "window.sh"]) expect(files.map((f) => f.split("/").pop()), bad).not.toContain(bad);
    for (const f of files.filter((x) => !x.startsWith("release-templates/") && x !== "MANIFEST.sha256")) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).not.toMatch(/e80b770|eab95a809b3b|4832b6ba|"228"|has 228/);
    }
  });
  it("describes this release: the Handler and Identity assets of the candidate, 242 routes (228 + the 14 staff routes), a source commit", () => {
    const info = JSON.parse(readFileSync(join(root, "BUILD_INFO.json"), "utf8"));
    expect(info).toMatchObject({ package: "ogevia-prd-discovery", handler_asset: HANDLER, identity_asset: IDENTITY, api_routes_in_release: 242 });
    expect(info.source_commit).toMatch(/^[0-9a-f]{40}$/);
    const api = JSON.parse(readFileSync(join(root, "release-templates/Ogevia-prd-ServiceVerificationApi.json"), "utf8"));
    const routes = Object.values<any>(api.Resources).filter((r) => r.Type === "AWS::ApiGatewayV2::Route").map((r) => r.Properties.RouteKey as string);
    expect(routes).toHaveLength(242);
    for (const k of ["GET /v1/staff", "POST /v1/staff", "GET /v1/role-permissions", "GET /v1/staff-audit"]) expect(routes, k).toContain(k);
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain(HANDLER); expect(readme).toContain("OGEVIA_PRD_READ_COUNTS=1"); expect(readme).not.toMatch(/@[A-Z_]+@/);
  });
  it("the production database read stays opt-in, counts only, and hardwired to production", () => {
    const s = readFileSync(join(root, "scripts/ledger-prd-read.sh"), "utf8");
    expect(s).toContain("OGEVIA_PRD_READ_COUNTS"); expect(s).toMatch(/DB_EXPECT=ogevia_prd/); expect(s).not.toMatch(/DB_EXPECT=ogevia_sv_test/);
  });
});
