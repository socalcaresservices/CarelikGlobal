import { describe, expect, it } from "vitest";
import { resolveAuthMode } from "../auth-provider";
import { AuthError } from "../errors";
import { TEST_ENV } from "../test/tokens";
import { cognitoIssuer, parseCognitoConfig } from "./config";

describe("provider selection is explicit and fails closed", () => {
  it("keeps Supabase (current production) when unset or 'supabase'", () => {
    expect(resolveAuthMode(undefined)).toBe("supabase");
    expect(resolveAuthMode("")).toBe("supabase");
    expect(resolveAuthMode("supabase")).toBe("supabase");
  });

  it("selects Cognito only when explicitly requested", () => {
    expect(resolveAuthMode("cognito")).toBe("cognito");
  });

  it.each(["Cognito", "COGNITO", "aws", "none", "true"])("rejects %s", (value) => {
    expect(() => resolveAuthMode(value)).toThrow(AuthError);
  });
});

describe("Cognito configuration", () => {
  it("parses a complete public configuration", () => {
    const c = parseCognitoConfig(TEST_ENV);
    expect(c).toMatchObject({ scopes: ["openid", "email"], refreshTokenPersistence: "session" });
    expect(cognitoIssuer(c)).toBe("https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TESTPOOL1");
  });

  it.each([
    "VITE_COGNITO_REGION", "VITE_COGNITO_USER_POOL_ID", "VITE_COGNITO_CLIENT_ID",
    "VITE_COGNITO_DOMAIN", "VITE_COGNITO_REDIRECT_URI", "VITE_COGNITO_LOGOUT_URI",
  ] as const)("fails closed when %s is missing", (key) => {
    expect(() => parseCognitoConfig({ ...TEST_ENV, [key]: undefined })).toThrow(/Missing/);
  });

  it.each([
    [{ VITE_COGNITO_REGION: "uswest2" }, /region/],
    [{ VITE_COGNITO_USER_POOL_ID: "us-east-1_TESTPOOL1" }, /not in VITE_COGNITO_REGION/],
    [{ VITE_COGNITO_USER_POOL_ID: "pool" }, /malformed/],
    [{ VITE_COGNITO_CLIENT_ID: "has-a-secret?" }, /malformed/],
    [{ VITE_COGNITO_DOMAIN: "http://evil.example" }, /https origin/],
    [{ VITE_COGNITO_REDIRECT_URI: "http://app.example.test/cb" }, /https/],
    [{ VITE_COGNITO_REDIRECT_URI: "/auth/callback" }, /absolute/],
    [{ VITE_COGNITO_REDIRECT_URI: "https://app.example.test/cb#frag" }, /fragment/],
    [{ VITE_COGNITO_LOGOUT_URI: "https://user:pw@app.example.test/" }, /credentials/],
    [{ VITE_COGNITO_SCOPES: "email" }, /openid/],
    [{ VITE_COGNITO_REFRESH_PERSISTENCE: "local" }, /memory or session/],
  ])("rejects %o", (patch, message) => {
    expect(() => parseCognitoConfig({ ...TEST_ENV, ...patch })).toThrow(message);
  });

  it("allows http only for localhost development redirects", () => {
    expect(parseCognitoConfig({ ...TEST_ENV, VITE_COGNITO_REDIRECT_URI: "http://localhost:5173/auth/callback" }).redirectUri)
      .toBe("http://localhost:5173/auth/callback");
  });
});
