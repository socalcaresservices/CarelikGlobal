// Synthetic, cryptographically valid Cognito-shaped JWTs from a LOCAL key pair.
// No real users, no real tokens, nothing from AWS.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export const TEST_REGION = "us-west-2";
export const TEST_POOL = "us-west-2_TESTPOOL1";
export const TEST_CLIENT = "testclient0000000000000000";
export const TEST_ISSUER = `https://cognito-idp.${TEST_REGION}.amazonaws.com/${TEST_POOL}`;
export const TEST_SUB = "11111111-2222-4333-8444-555555555555";

export async function testIssuer() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { expiresInSeconds?: number; nowSeconds?: number; key?: CryptoKey } = {}) => {
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.expiresInSeconds ?? 3600))
      .sign(opts.key ?? privateKey);
  };
  const accessToken = (overrides: Record<string, unknown> = {}, opts: Parameters<typeof sign>[1] = {}) =>
    sign({ sub: TEST_SUB, iss: TEST_ISSUER, client_id: TEST_CLIENT, token_use: "access", scope: "openid email", ...overrides }, opts);
  const idToken = (overrides: Record<string, unknown> = {}, opts: Parameters<typeof sign>[1] = {}) =>
    sign({ sub: TEST_SUB, iss: TEST_ISSUER, aud: TEST_CLIENT, token_use: "id", email: "caregiver.a1@example.test", email_verified: true, ...overrides }, opts);
  return { jwks, sign, accessToken, idToken };
}

export const TEST_ENV = {
  VITE_COGNITO_REGION: TEST_REGION,
  VITE_COGNITO_USER_POOL_ID: TEST_POOL,
  VITE_COGNITO_CLIENT_ID: TEST_CLIENT,
  VITE_COGNITO_DOMAIN: "https://ogevia-test.auth.us-west-2.amazoncognito.com",
  VITE_COGNITO_REDIRECT_URI: "https://app.example.test/auth/callback",
  VITE_COGNITO_LOGOUT_URI: "https://app.example.test/",
};
