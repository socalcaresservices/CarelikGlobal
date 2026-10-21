import { generateKeyPair, createLocalJWKSet, exportJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { PrincipalError, type PrincipalExpectations } from "./principal";
import { verifyAccessToken } from "./verify";

// Two environments, each with its OWN pool (own issuer, own signing key, own client). All keys and tokens are generated here;
// nothing is real. This is the property the separation must give: a token minted in one environment is worthless in another.
const REGION = "us-west-2";
const SUB = "11111111-2222-4333-8444-555555555555";
const issuerOf = (pool: string) => `https://cognito-idp.${REGION}.amazonaws.com/${pool}`;

async function environment(pool: string, client: string) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: `${pool}-kid`, alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const expected: PrincipalExpectations = { issuer: issuerOf(pool), clientIds: [client] };
  const mint = (overrides: Record<string, unknown> = {}, opts: { expiresInSeconds?: number; nowSeconds?: number } = {}) => {
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: SUB, iss: issuerOf(pool), client_id: client, token_use: "access", scope: "openid email", ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: `${pool}-kid` })
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.expiresInSeconds ?? 3600))
      .sign(privateKey);
  };
  return { pool, client, jwks, expected, mint };
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return e instanceof PrincipalError ? e.reason : `other:${String(e)}`;
  }
};

describe("production and test sign-in are separate environments", async () => {
  const production = await environment("us-west-2_PRDPOOL01", "prdclient00000000000000000");
  const test = await environment("us-west-2_TSTPOOL01", "tstclient00000000000000000");
  const demo = await environment("us-west-2_DEMOPOOL1", "democlient0000000000000000");
  const legacyClient = "legacyclient00000000000000";

  const asProduction = (token: string) => verifyAccessToken(token, production.jwks, production.expected);
  const asTest = (token: string) => verifyAccessToken(token, test.jwks, test.expected);
  const asDemo = (token: string) => verifyAccessToken(token, demo.jwks, demo.expected);

  it("a production token is accepted by production", async () => {
    const p = await asProduction(await production.mint());
    expect(p.sub).toBe(SUB);
    expect(p.clientId).toBe(production.client);
    expect(p.issuer).toBe(issuerOf(production.pool));
  });

  it("a test (pilot) token is rejected by production", async () => {
    expect(await reason(asProduction(await test.mint()))).not.toBe("accepted");
  });

  it("a demo token is rejected by production", async () => {
    expect(await reason(asProduction(await demo.mint()))).not.toBe("accepted");
  });

  it("a production token is rejected by test and by demo", async () => {
    const token = await production.mint();
    expect(await reason(asTest(token))).not.toBe("accepted");
    expect(await reason(asDemo(token))).not.toBe("accepted");
  });

  it("each environment still accepts its own tokens (no accidental lock-out)", async () => {
    expect((await asTest(await test.mint())).clientId).toBe(test.client);
    expect((await asDemo(await demo.mint())).clientId).toBe(demo.client);
  });

  it("a token that claims production's issuer and client but is signed by another environment's key is rejected (signature)", async () => {
    const forged = await test.mint({ iss: issuerOf(production.pool), client_id: production.client });
    expect(await reason(asProduction(forged))).not.toBe("accepted");
  });

  it("wrong audience: a genuine production-pool token for a different client is rejected as wrong_client", async () => {
    expect(await reason(asProduction(await production.mint({ client_id: legacyClient })))).toBe("wrong_client");
    expect(await reason(asProduction(await production.mint({ client_id: test.client })))).toBe("wrong_client");
  });

  it("wrong issuer: a validly signed token with another pool's issuer is rejected as wrong_issuer", async () => {
    expect(await reason(asProduction(await production.mint({ iss: issuerOf(test.pool) })))).toBe("wrong_issuer");
  });

  it("expired token is rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await reason(asProduction(await production.mint({}, { nowSeconds: now - 7200, expiresInSeconds: 3600 })))).toBe("expired");
  });

  it("an ID token is rejected even when it comes from the right pool and client", async () => {
    expect(await reason(asProduction(await production.mint({ token_use: "id" })))).toBe("wrong_token_use");
  });

  it("production trusts exactly one client; a list that included the legacy client would accept it, which is why the list is one entry", async () => {
    const tolerant = { ...production.expected, clientIds: [production.client, legacyClient] };
    expect((await verifyAccessToken(await production.mint({ client_id: legacyClient }), production.jwks, tolerant)).clientId).toBe(legacyClient);
    expect(production.expected.clientIds).toEqual([production.client]);
  });
});
