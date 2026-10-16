// A web build published to the TEST environment (stacks Ogevia-prod-*) must carry the label "test".
// TEST's live /config.json has no VITE_APP_ENV key, so the BUILD value decides whether the "TEST - synthetic data only" banner shows.
// A build labelled "production" shows no banner and looks like production. This was reproduced in Chromium on 2026-10-16 and the
// scripts below used to build TEST with VITE_APP_ENV=production. These checks keep that from coming back.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const code = (rel: string) => read(rel).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** Scripts that build the web app AND publish it to TEST: they must label it test and check the result before publishing. */
const PUBLISHING_SCRIPTS = ["slice/increment-deploy.sh"];
/** Scripts that only build for TEST (they write their own fresh config.json): label only. */
const BUILD_ONLY_SCRIPTS = [];

describe("TEST web builds carry the TEST label", () => {
  it.each(PUBLISHING_SCRIPTS)("%s builds with VITE_APP_ENV=test and checks the build and the live config before publishing", (rel) => {
    const c = code(rel);
    expect(c).not.toMatch(/VITE_APP_ENV=production/);
    expect(c).toMatch(/VITE_APP_ENV=test /);
    expect(c).toContain('assert_test_web_label "$RUN/web-build"');
    expect(c).toContain('assert_test_web_label "$W"; assert_live_config_label "$WEB"');
  });
  it.each(BUILD_ONLY_SCRIPTS)("%s builds with VITE_APP_ENV=test", (rel) => {
    const c = code(rel);
    expect(c).not.toMatch(/VITE_APP_ENV=production/);
    expect(c).toMatch(/VITE_APP_ENV=(test|"\$APP_ENV") /);
  });
  it("the production deploy script still builds a production label (this guard is for TEST only)", () => {
    expect(code("scripts/deploy-production.sh")).toMatch(/VITE_APP_ENV=production /);
  });
  it("the pilot procedure no longer tells the operator to build TEST with VITE_APP_ENV=production", () => {
    const doc = readFileSync(new URL("../../../docs/releases/2026-10-14-pilot-readiness/PILOT_DEPLOYMENT_PROCEDURE.md", import.meta.url), "utf8");
    expect(doc).not.toMatch(/build with `VITE_APP_ENV=production/);
    expect(doc).toMatch(/build with `VITE_APP_ENV=test /);
    expect(doc).toContain("SMK-07");
  });
});

describe("the web label guard (pilot-lib.sh), run for real", () => {
  const lib = read("slice/pilot-lib.sh");
  const begin = lib.indexOf("# --- web label guard (begin)");
  const end = lib.indexOf("# --- web label guard (end)");
  const helpers = lib.slice(begin, end);

  function build(content: string | null): { ok: boolean; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "label-"));
    try {
      mkdirSync(join(dir, "assets"));
      if (content !== null) writeFileSync(join(dir, "assets", "index-abc.js"), content);
      const script = `die() { echo "DIE: $*"; exit 1; }\n${helpers}\nassert_test_web_label "${dir}"`;
      try { return { ok: true, out: execFileSync("bash", ["-c", script], { encoding: "utf8" }) }; }
      catch (e) { return { ok: false, out: String((e as { stdout?: string }).stdout ?? "") }; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  function liveConfig(json: string): { ok: boolean; out: string } {
    const script = `die() { echo "DIE: $*"; exit 1; }\ncurl() { echo '${json}'; }\n${helpers}\nassert_live_config_label https://example.test/`;
    try { return { ok: true, out: execFileSync("bash", ["-c", script], { encoding: "utf8" }) }; }
    catch (e) { return { ok: false, out: String((e as { stdout?: string }).stdout ?? "") }; }
  }

  it("the helper block exists", () => { expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin); });
  it("accepts a build labelled test", () => { expect(build('const e={BASE_URL:"/",VITE_APP_ENV:"test",VITE_AUTH_PROVIDER:"cognito"};').ok).toBe(true); });
  it("refuses a build labelled production (it has no test label)", () => {
    const r = build('const e={BASE_URL:"/",VITE_APP_ENV:"production",VITE_AUTH_PROVIDER:"cognito"};');
    expect(r.ok).toBe(false); expect(r.out).toContain("not labelled test");
  });
  it("refuses a build that carries both labels, and says it is labelled production", () => {
    const r = build('const a={VITE_APP_ENV:"test"};const b={VITE_APP_ENV:"production"};');
    expect(r.ok).toBe(false); expect(r.out).toContain("labelled production");
  });
  it("refuses a production build even though the banner text is in its code (the text proves nothing)", () => {
    expect(build('const t="TEST — synthetic data only";const e={VITE_APP_ENV:"production"};').ok).toBe(false);
  });
  it("refuses a build with no label at all", () => { expect(build("const e={VITE_AUTH_PROVIDER:\"cognito\"};").ok).toBe(false); });
  it("refuses an empty build folder", () => { expect(build(null).ok).toBe(false); });
  it("accepts a live config.json with no VITE_APP_ENV key (TEST today) or with test", () => {
    expect(liveConfig('{"VITE_SV_API_BASE_URL":"https://x.example"}').ok).toBe(true);
    expect(liveConfig('{"VITE_APP_ENV":"test"}').ok).toBe(true);
  });
  it("refuses a live config.json that says production", () => {
    const r = liveConfig('{"VITE_APP_ENV":"production"}');
    expect(r.ok).toBe(false); expect(r.out).toContain("must not claim to be production");
  });
});
