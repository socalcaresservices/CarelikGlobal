// @vitest-environment node
import { generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { TEST_CLIENT, TEST_ISSUER, TEST_SUB, testIssuer } from "../test/tokens";
import { withPrincipal, type Queryable } from "./db-bridge";
import { claimsFromHttpApiEvent, PrincipalError, principalFromClaims, type PrincipalExpectations } from "./principal";
import { verifyAccessToken } from "./verify";

const expected: PrincipalExpectations = { issuer: TEST_ISSUER, clientIds: [TEST_CLIENT] };
const NOW = 1_800_000_000;
const valid = { sub: TEST_SUB, iss: TEST_ISSUER, client_id: TEST_CLIENT, token_use: "access", scope: "openid email", exp: NOW + 600 };

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PrincipalError ? e.reason : `unexpected:${String(e)}`;
  }
  return "accepted";
};

describe("principalFromClaims — JWT contract", () => {
  it("accepts a valid access-token claim set and carries no org/role/email", () => {
    const p = principalFromClaims({ ...valid, email: "x@example.test", "cognito:groups": ["owner"] }, expected, NOW);
    expect(p).toEqual({ sub: TEST_SUB, issuer: TEST_ISSUER, clientId: TEST_CLIENT, tokenUse: "access", scopes: ["openid", "email"], expiresAt: NOW + 600 });
    expect(Object.keys(p).sort()).toEqual(["clientId", "expiresAt", "issuer", "scopes", "sub", "tokenUse"]);
  });

  it.each<[string, Record<string, unknown> | null, string]>([
    ["no claims", null, "missing_claims"],
    ["missing sub", { ...valid, sub: undefined }, "missing_sub"],
    ["empty sub", { ...valid, sub: "" }, "missing_sub"],
    ["non-UUID sub", { ...valid, sub: "admin" }, "malformed_sub"],
    ["uppercase/injected sub", { ...valid, sub: `${TEST_SUB}'; drop table x;--` }, "malformed_sub"],
    ["numeric sub", { ...valid, sub: 42 }, "malformed_sub"],
    ["wrong issuer", { ...valid, iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_EVIL" }, "wrong_issuer"],
    ["issuer prefix trick", { ...valid, iss: `${TEST_ISSUER}/extra` }, "wrong_issuer"],
    ["missing issuer", { ...valid, iss: undefined }, "wrong_issuer"],
    ["ID token", { ...valid, token_use: "id", aud: TEST_CLIENT }, "wrong_token_use"],
    ["missing token_use", { ...valid, token_use: undefined }, "wrong_token_use"],
    ["unapproved client", { ...valid, client_id: "someotherclient00000000000" }, "wrong_client"],
    ["missing client_id", { ...valid, client_id: undefined }, "wrong_client"],
    ["expired", { ...valid, exp: NOW - 1 }, "expired"],
    ["exp == now", { ...valid, exp: NOW }, "expired"],
    ["non-numeric exp", { ...valid, exp: "tomorrow" }, "malformed_claims"],
    ["missing exp", { ...valid, exp: undefined }, "malformed_claims"],
    ["scope as object", { ...valid, scope: { a: 1 } }, "malformed_claims"],
    ["missing openid scope", { ...valid, scope: "email" }, "missing_scope"],
  ])("rejects %s", (_label, claims, expectedReason) => {
    expect(reason(() => principalFromClaims(claims, expected, NOW))).toBe(expectedReason);
  });

  it("accepts API Gateway string-encoded exp and array scopes", () => {
    expect(principalFromClaims({ ...valid, exp: String(NOW + 5) }, expected, NOW).expiresAt).toBe(NOW + 5);
    expect(principalFromClaims({ ...valid, scope: ["openid"] }, expected, NOW).scopes).toEqual(["openid"]);
  });

  it("enforces additional required scopes", () => {
    expect(reason(() => principalFromClaims(valid, { ...expected, requiredScopes: ["openid", "ogevia/api"] }, NOW))).toBe("missing_scope");
  });

  it("error messages never echo claim values", () => {
    try {
      principalFromClaims({ ...valid, iss: "https://attacker.example/SECRETVALUE" }, expected, NOW);
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRETVALUE");
      expect((e as Error).message).not.toContain(TEST_SUB);
    }
  });

  it("reads claims from an HTTP API v2 event and returns null when the authorizer is absent", () => {
    expect(claimsFromHttpApiEvent({ requestContext: { authorizer: { jwt: { claims: valid } } } })).toEqual(valid);
    expect(claimsFromHttpApiEvent({ requestContext: {} })).toBeNull();
    expect(claimsFromHttpApiEvent(null)).toBeNull();
    expect(reason(() => principalFromClaims(claimsFromHttpApiEvent({}), expected, NOW))).toBe("missing_claims");
  });
});

describe("verifyAccessToken — signature verification with a local JWKS", () => {
  let issuer: Awaited<ReturnType<typeof testIssuer>>;
  beforeAll(async () => {
    issuer = await testIssuer();
  });
  const now = () => Math.floor(Date.now() / 1000);
  const verifyReason = async (token: string) => {
    try {
      await verifyAccessToken(token, issuer.jwks, expected, now());
      return "accepted";
    } catch (e) {
      return e instanceof PrincipalError ? e.reason : `unexpected:${String(e)}`;
    }
  };

  it("accepts a correctly signed access token", async () => {
    const p = await verifyAccessToken(await issuer.accessToken(), issuer.jwks, expected, now());
    expect(p.sub).toBe(TEST_SUB);
  });

  it("rejects a token signed by a different key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    expect(await verifyReason(await issuer.accessToken({}, { key: privateKey }))).toBe("malformed_claims");
  });

  it("rejects a tampered payload (sub swapped after signing)", async () => {
    const token = await issuer.accessToken();
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "99999999-2222-4333-8444-555555555555", iss: TEST_ISSUER, client_id: TEST_CLIENT, token_use: "access", scope: "openid", exp: now() + 600 })).toString("base64url");
    expect(await verifyReason(`${h}.${forged}.${s}`)).toBe("malformed_claims");
  });

  it("rejects alg=none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ ...valid, exp: now() + 600 })).toString("base64url");
    expect(await verifyReason(`${header}.${body}.`)).toBe("malformed_claims");
  });

  it("rejects an expired token", async () => {
    expect(await verifyReason(await issuer.accessToken({}, { nowSeconds: now() - 7200, expiresInSeconds: 3600 }))).toBe("expired");
  });

  it("rejects the wrong issuer", async () => {
    expect(await verifyReason(await issuer.accessToken({ iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_EVIL" }))).toBe("wrong_issuer");
  });

  it("rejects an ID token presented to the API", async () => {
    expect(await verifyReason(await issuer.idToken())).toBe("wrong_token_use");
  });

  it("rejects an unapproved client", async () => {
    expect(await verifyReason(await issuer.accessToken({ client_id: "someotherclient00000000000" }))).toBe("wrong_client");
  });

  it("rejects garbage", async () => {
    expect(await verifyReason("not-a-token")).toBe("malformed_claims");
  });
});

describe("withPrincipal — sub → database bridge", () => {
  const principal = principalFromClaims(valid, expected, NOW);
  function fake(fail?: RegExp) {
    const log: Array<{ text: string; params?: unknown[] }> = [];
    const client: Queryable = {
      async query(text, params) {
        log.push({ text, ...(params ? { params } : {}) });
        if (fail && fail.test(text)) throw new Error("db failure");
        return { rows: [] };
      },
    };
    return { client, log };
  }

  it("runs begin → begin_request(sub, request_id) → work → commit", async () => {
    const { client, log } = fake();
    const result = await withPrincipal(client, principal, async (c) => {
      await c.query("select ogevia_api.list_assigned_clients()");
      return "ok";
    }, { requestId: "00000000-0000-4000-8000-000000000001" });
    expect(result).toBe("ok");
    expect(log.map((l) => l.text)).toEqual(["begin", "select ogevia_api.begin_request($1, $2)", "select ogevia_api.list_assigned_clients()", "commit"]);
    expect(log[1]!.params).toEqual([TEST_SUB, "00000000-0000-4000-8000-000000000001"]);
  });

  it("passes ONLY the sub as identity (no org, role, email)", async () => {
    const { client, log } = fake();
    await withPrincipal(client, principal, async () => null);
    const identityCall = log.find((l) => l.text.includes("begin_request"))!;
    expect(identityCall.params).toHaveLength(2);
    expect(identityCall.params![0]).toBe(TEST_SUB);
    expect(identityCall.params![1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rolls back when begin_request rejects the sub", async () => {
    const { client, log } = fake(/begin_request/);
    await expect(withPrincipal(client, principal, async () => "never")).rejects.toThrow("db failure");
    expect(log.at(-1)!.text).toBe("rollback");
    expect(log.some((l) => l.text === "commit")).toBe(false);
  });

  it("rolls back when the work fails", async () => {
    const { client, log } = fake();
    await expect(withPrincipal(client, principal, async () => { throw new Error("work"); })).rejects.toThrow("work");
    expect(log.at(-1)!.text).toBe("rollback");
  });

  it("rejects an injected SET ROLE name", async () => {
    const { client, log } = fake();
    await expect(withPrincipal(client, principal, async () => null, { setRole: "ogevia_app; drop table x" })).rejects.toThrow("invalid role name");
    expect(log.at(-1)!.text).toBe("rollback");
  });
});
