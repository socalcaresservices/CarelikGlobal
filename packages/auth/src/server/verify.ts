import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { PrincipalError, principalFromClaims, type AuthenticatedPrincipal, type PrincipalExpectations } from "./principal";

/**
 * Full signature verification of a Cognito ACCESS token (RS256 against the
 * pool's JWKS). Production relies on API Gateway for this; this function
 * exists for defense in depth and for tests with a local synthetic issuer.
 */
export async function verifyAccessToken(
  token: string,
  keys: JWTVerifyGetKey,
  expected: PrincipalExpectations,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AuthenticatedPrincipal> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, keys, {
      issuer: expected.issuer,
      algorithms: ["RS256"],
      currentDate: new Date(nowSeconds * 1000),
      clockTolerance: expected.clockSkewSeconds ?? 0,
    });
    payload = result.payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new PrincipalError("expired");
    if (error instanceof errors.JWTClaimValidationFailed && error.claim === "iss") {
      throw new PrincipalError("wrong_issuer");
    }
    throw new PrincipalError("malformed_claims");
  }
  return principalFromClaims(payload, expected, nowSeconds);
}

/** Cognito JWKS for a pool (fetched and cached by jose). */
export function cognitoJwks(issuer: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
}
