import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { webAuthProblems } from "../scripts/assert-web-auth.js";

const POOL = "us-west-2_FHJoX71ca", TEST = "us-west-2_849AYz5J7";
const DOMAIN = "https://ogevia-prd-300094796789.auth.us-west-2.amazoncognito.com", CLIENT = "prdclient0123456789abcdef";
const dirs: string[] = [];
const bundle = (main: string, extra = ""): string => {
  const d = mkdtempSync(join(tmpdir(), "webauth-")); dirs.push(d); mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), "<html></html>"); writeFileSync(join(d, "assets", "index-abc.js"), main); if (extra) writeFileSync(join(d, "assets", "other.js"), extra);
  return d;
};
const good = `x={VITE_COGNITO_USER_POOL_ID:"${POOL}",VITE_COGNITO_DOMAIN:"${DOMAIN}",VITE_COGNITO_CLIENT_ID:"${CLIENT}",VITE_APP_ENV:"production"}`;
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("assert-web-auth: the production bundle must use the production sign-in pool", () => {
  it("accepts a bundle with the production pool, domain and client", () => {
    expect(webAuthProblems(bundle(good), POOL, DOMAIN, CLIENT, TEST)).toEqual([]);
  });
  it("refuses the 2026-11-01 defect: a bundle built against the TEST pool and domain", () => {
    const bad = `x={VITE_COGNITO_USER_POOL_ID:"${TEST}",VITE_COGNITO_DOMAIN:"https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com",VITE_COGNITO_CLIENT_ID:"2af4ao08h1pl3u2grhg1cr49ma"}`;
    const p = webAuthProblems(bundle(bad), POOL, DOMAIN, CLIENT, TEST);
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.join(" ")).toMatch(/not the production value/);
    expect(p.join(" ")).toMatch(/TEST sign-in pool/);
  });
  it("refuses a bundle that is right in the main file but mentions the TEST pool anywhere else", () => {
    expect(webAuthProblems(bundle(good, `y="${TEST}"`), POOL, DOMAIN, CLIENT, TEST).join(" ")).toMatch(/TEST sign-in pool/);
    expect(webAuthProblems(bundle(good, 'z="us-west-2849ayz5j7.auth.example"'), POOL, DOMAIN, CLIENT, TEST).join(" ")).toMatch(/TEST sign-in pool/);
  });
  it("refuses a missing value and a mixed bundle", () => {
    expect(webAuthProblems(bundle(`x={VITE_COGNITO_USER_POOL_ID:"${POOL}"}`), POOL, DOMAIN, CLIENT, TEST).join(" ")).toMatch(/VITE_COGNITO_DOMAIN is not in the bundle/);
    expect(webAuthProblems(bundle(good, `q={VITE_COGNITO_USER_POOL_ID:"us-west-2_ZZZZZZZZZ"}`), POOL, DOMAIN, CLIENT, TEST).join(" ")).toMatch(/not the production value/);
  });
  it("refuses a bad expectation (the guard cannot itself be given the TEST pool or an empty value)", () => {
    expect(webAuthProblems(bundle(good), TEST, DOMAIN, CLIENT, TEST).join(" ")).toMatch(/equals the TEST pool/);
    expect(webAuthProblems(bundle(good), "None", DOMAIN, CLIENT, TEST).join(" ")).toMatch(/not a pool id/);
    expect(webAuthProblems(bundle(good), POOL, "None", CLIENT, TEST).join(" ")).toMatch(/not a sign-in domain/);
    expect(webAuthProblems(bundle(good), POOL, DOMAIN, "", TEST).join(" ")).toMatch(/no expected client/);
  });
});
