import { describe, expect, it } from "vitest";
import { clientChanges, OGEVIA_WEB_CURRENT, OGEVIA_WEB_TARGET } from "../lib/cognito-target.js";
import { ENVIRONMENTS } from "../lib/config.js";

describe("ogevia-web current -> target (model only; D-P1-2)", () => {
  it("the only required changes are callback, logout, password-flow removal and refresh lifetime", () => {
    expect(clientChanges(OGEVIA_WEB_CURRENT, OGEVIA_WEB_TARGET).map((c) => c.setting)).toEqual([
      "callbackUrls",
      "logoutUrls",
      "explicitAuthFlows",
      "refreshTokenMinutes",
    ]);
  });
  it("target keeps a public code-flow client with no secret and https-only redirects", () => {
    expect(OGEVIA_WEB_TARGET.generateSecret).toBe(false);
    expect(OGEVIA_WEB_TARGET.oauthFlows).toEqual(["code"]);
    for (const url of [...OGEVIA_WEB_TARGET.callbackUrls, ...OGEVIA_WEB_TARGET.logoutUrls]) expect(url).toMatch(/^https:\/\/app\.ogevia\.com\//);
  });
  it("target callback origin matches the API CORS origin", () => {
    expect(ENVIRONMENTS.prod.auth.allowedOrigins).toContain(new URL(OGEVIA_WEB_TARGET.callbackUrls[0]!).origin);
  });
});
