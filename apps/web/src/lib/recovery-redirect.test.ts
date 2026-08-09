import { describe, expect, it } from "vitest";
import { getRecoveryRedirectPath } from "./recovery-redirect";

describe("getRecoveryRedirectPath", () => {
  it("redirects a PKCE recovery code landing on the root to /reset-password", () => {
    expect(getRecoveryRedirectPath("/", "?code=abc123&type=recovery", "")).toBe(
      "/reset-password?code=abc123&type=recovery"
    );
  });

  it("redirects an implicit-flow recovery hash landing on the root", () => {
    expect(getRecoveryRedirectPath("/", "", "#access_token=xyz&type=recovery")).toBe(
      "/reset-password#access_token=xyz&type=recovery"
    );
  });

  it("does nothing when already on /reset-password", () => {
    expect(getRecoveryRedirectPath("/reset-password", "?code=abc123&type=recovery", "")).toBeNull();
  });

  it("does nothing for a normal navigation with no recovery marker", () => {
    expect(getRecoveryRedirectPath("/clients", "", "")).toBeNull();
  });

  it("ignores a code param that isn't a recovery type (e.g. an OAuth callback)", () => {
    expect(getRecoveryRedirectPath("/", "?code=abc123", "")).toBeNull();
  });
});
