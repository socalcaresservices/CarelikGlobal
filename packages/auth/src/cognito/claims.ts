import { AuthError } from "../errors";
import { safeEqual } from "./pkce";

/**
 * Decodes a JWT payload WITHOUT verifying its signature. Used only for tokens
 * the browser just received over TLS directly from the Cognito token endpoint
 * (OIDC Core 3.1.3.7 allows skipping signature checks in that case). The API
 * never trusts a browser-decoded token: API Gateway verifies signatures.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new AuthError("invalid_token", "Malformed token.");
  try {
    const json = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "="));
    const payload = JSON.parse(json) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
    return payload as Record<string, unknown>;
  } catch {
    throw new AuthError("invalid_token", "Malformed token.");
  }
}

export interface IdTokenIdentity {
  readonly sub: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly expiresAt: number;
}

/** OIDC ID-token claim checks: iss, aud, token_use, nonce, exp, sub. */
export function validateIdTokenClaims(
  idToken: string,
  expected: { issuer: string; clientId: string; nonce: string | null; nowSeconds: number },
): IdTokenIdentity {
  const c = decodeJwtPayload(idToken);
  if (c.iss !== expected.issuer) throw new AuthError("invalid_token", "Token issuer is not trusted.");
  if (c.aud !== expected.clientId) throw new AuthError("invalid_token", "Token audience is not this application.");
  if (c.token_use !== "id") throw new AuthError("invalid_token", "Unexpected token type.");
  if (typeof c.sub !== "string" || !c.sub) throw new AuthError("invalid_token", "Token has no subject.");
  if (typeof c.exp !== "number" || c.exp <= expected.nowSeconds) {
    throw new AuthError("session_expired", "Your session has expired. Please sign in again.");
  }
  if (expected.nonce !== null && (typeof c.nonce !== "string" || !safeEqual(c.nonce, expected.nonce))) {
    throw new AuthError("nonce_mismatch", "Sign-in could not be verified. Please try again.");
  }
  return {
    sub: c.sub,
    email: typeof c.email === "string" ? c.email : null,
    emailVerified: c.email_verified === true || c.email_verified === "true",
    expiresAt: c.exp,
  };
}

export function accessTokenExpiry(accessToken: string): number {
  const c = decodeJwtPayload(accessToken);
  if (typeof c.exp !== "number") throw new AuthError("invalid_token", "Malformed token.");
  return c.exp;
}
