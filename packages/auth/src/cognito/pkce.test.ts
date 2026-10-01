import { describe, expect, it } from "vitest";
import { codeChallengeS256, generateCodeVerifier, generateNonce, generateState, safeEqual } from "./pkce";

describe("PKCE (RFC 7636, S256)", () => {
  it("generates 43-char base64url verifiers with no repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const v = generateCodeVerifier();
      expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(v);
    }
    expect(seen.size).toBe(200);
  });

  it("matches the RFC 7636 Appendix B test vector", async () => {
    expect(await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("rejects malformed verifiers", async () => {
    await expect(codeChallengeS256("short")).rejects.toThrow(/Invalid PKCE/);
    await expect(codeChallengeS256("x".repeat(129))).rejects.toThrow(/Invalid PKCE/);
    await expect(codeChallengeS256(`${"a".repeat(43)}!`)).rejects.toThrow(/Invalid PKCE/);
  });

  it("generates unique state and nonce values", () => {
    expect(generateState()).not.toBe(generateState());
    expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("compares secrets in constant time semantics", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
