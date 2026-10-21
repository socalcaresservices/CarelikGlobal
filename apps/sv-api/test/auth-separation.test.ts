// Production authentication separation, API side: the Lambda's fail-closed startup guard, cross-environment rejection through the real
// handler, and the identity (invitation) function being bound to ITS pool only. Synthetic values only; nothing contacts AWS.
import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { createIdentityHandler } from "../src/identity-handler";
import { claims, event } from "./fixtures";

const REGION = "us-west-2";
const SHARED_POOL = "us-west-2_SHAREDPILOT"; // the pilot/test pool
const PRD_POOL = "us-west-2_PRDONLY01";
const id26 = (prefix: string) => (prefix + "0".repeat(26)).slice(0, 26); // Cognito client ids are 26 lowercase alphanumerics
const PRD_CLIENT = id26("prdwebclient");
const LEGACY_CLIENT = id26("legacyclient");
const PILOT_CLIENT = id26("pilotclient");
const issuerOf = (pool: string) => `https://cognito-idp.${REGION}.amazonaws.com/${pool}`;

const BASE = {
  AWS_REGION: REGION,
  DB_HOST: "db.internal.example",
  DB_PORT: "5432",
  DB_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:000000000000:secret:test",
  EVIDENCE_BUCKET: "ogevia-test-evidence",
  EVIDENCE_KEY_ARN: "arn:aws:kms:us-west-2:000000000000:key/00000000-0000-4000-8000-000000000000",
};
const PRD_ENV = {
  ...BASE,
  OGEVIA_ENV: "prd",
  DB_NAME: "ogevia_prd",
  COGNITO_USER_POOL_ID: PRD_POOL,
  COGNITO_APP_CLIENT_ID: PRD_CLIENT,
  OGEVIA_FORBIDDEN_POOL_IDS: SHARED_POOL,
};

describe("production Lambda startup guard (fail closed)", () => {
  it("starts with its own pool, exactly one client, and the shared pool named forbidden", () => {
    const c = loadConfig(PRD_ENV);
    expect(c.issuer).toBe(issuerOf(PRD_POOL));
    expect(c.appClientIds).toEqual([PRD_CLIENT]);
    expect(c.forbiddenUserPoolIds).toEqual([SHARED_POOL]);
  });

  it("refuses to start on the shared pilot pool", () => {
    expect(() => loadConfig({ ...PRD_ENV, COGNITO_USER_POOL_ID: SHARED_POOL })).toThrow(/must not use/);
  });

  it("refuses to start without the forbidden-pool setting (a missing list must not silently trust the pilot's sign-in)", () => {
    expect(() => loadConfig({ ...PRD_ENV, OGEVIA_FORBIDDEN_POOL_IDS: undefined })).toThrow(/requires OGEVIA_FORBIDDEN_POOL_IDS/);
    expect(() => loadConfig({ ...PRD_ENV, OGEVIA_FORBIDDEN_POOL_IDS: "" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PRD_ENV, OGEVIA_FORBIDDEN_POOL_IDS: " , " })).toThrow(ConfigError);
  });

  it("refuses to start with more than one client (the legacy client must not be added back)", () => {
    expect(() => loadConfig({ ...PRD_ENV, COGNITO_APP_CLIENT_ID: `${PRD_CLIENT},${LEGACY_CLIENT}` })).toThrow(/exactly one/);
  });

  it("refuses a malformed forbidden-pool list", () => {
    expect(() => loadConfig({ ...PRD_ENV, OGEVIA_FORBIDDEN_POOL_IDS: "not a pool" })).toThrow(/malformed/);
    expect(() => loadConfig({ ...PRD_ENV, OGEVIA_FORBIDDEN_POOL_IDS: "us-east-1_OTHERREGION" })).toThrow(/malformed/);
  });

  it("the pilot/test Lambda is unchanged: shared pool, two clients, no forbidden list needed", () => {
    const c = loadConfig({ ...BASE, OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test", COGNITO_USER_POOL_ID: SHARED_POOL, COGNITO_APP_CLIENT_ID: `${LEGACY_CLIENT},${PILOT_CLIENT}` });
    expect(c.appClientIds).toEqual([LEGACY_CLIENT, PILOT_CLIENT]);
    expect(c.forbiddenUserPoolIds).toEqual([]);
  });

  it("any environment refuses a pool it was told to forbid", () => {
    expect(() => loadConfig({ ...BASE, OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test", COGNITO_USER_POOL_ID: PRD_POOL, COGNITO_APP_CLIENT_ID: PILOT_CLIENT, OGEVIA_FORBIDDEN_POOL_IDS: PRD_POOL })).toThrow(/must not use/);
  });
});

describe("tokens through the real handler: production accepts production's and nothing else", () => {
  const SUB = "11111111-2222-4333-8444-555555555555";
  const db = { connect: vi.fn(async () => { throw new Error("database must not be reached for a rejected token"); }) };
  const prdHandler = (config = loadConfig(PRD_ENV)) =>
    createHandler({ config, db: db as never, evidence: new MemoryEvidenceStore(), log: () => undefined });
  const as = (iss: string, client: string, extra: Record<string, unknown> = {}) => event("GET /v1/me", { claims: claims(SUB, { iss, client_id: client, ...extra }) });

  it.each([
    ["a test (pilot) token: pilot issuer and pilot client", as(issuerOf(SHARED_POOL), PILOT_CLIENT)],
    ["the legacy client in the shared pool", as(issuerOf(SHARED_POOL), LEGACY_CLIENT)],
    ["a pilot user's token minted for production's client id (cannot exist, rejected anyway by issuer)", as(issuerOf(SHARED_POOL), PRD_CLIENT)],
    ["production's issuer but the legacy client", as(issuerOf(PRD_POOL), LEGACY_CLIENT)],
    ["production's issuer but a pilot client", as(issuerOf(PRD_POOL), PILOT_CLIENT)],
    ["a demo pool token", as(issuerOf("us-west-2_DEMOPOOL01"), id26("democlient"))],
    ["an expired production token", as(issuerOf(PRD_POOL), PRD_CLIENT, { exp: "1000" })],
    ["a production ID token", as(issuerOf(PRD_POOL), PRD_CLIENT, { token_use: "id" })],
  ])("rejects %s with 401 before any database work", async (_label, ev) => {
    const r = await prdHandler()(ev);
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.body).error.code).toBe("unauthenticated");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("the pilot handler rejects a production token the same way", async () => {
    const pilot = createHandler({
      config: loadConfig({ ...BASE, OGEVIA_ENV: "prod", DB_NAME: "ogevia_sv_test", COGNITO_USER_POOL_ID: SHARED_POOL, COGNITO_APP_CLIENT_ID: `${LEGACY_CLIENT},${PILOT_CLIENT}` }),
      db: db as never, evidence: new MemoryEvidenceStore(), log: () => undefined,
    });
    expect((await pilot(as(issuerOf(PRD_POOL), PRD_CLIENT))).statusCode).toBe(401);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("does not reject a well-formed production token at the authentication step (it reaches the database layer)", async () => {
    const r = await prdHandler()(as(issuerOf(PRD_POOL), PRD_CLIENT));
    expect(r.statusCode).not.toBe(401);
    expect(db.connect).toHaveBeenCalledTimes(1);
  });
});

describe("the identity (invitation) function acts on exactly the pool it is configured with", () => {
  const SUB = "0f0e0d0c-1111-4222-8333-444455556666";
  function fake() {
    const sent: { name: string; input: Record<string, any> }[] = [];
    return { sent, client: { send: async (c: any) => { sent.push({ name: c.constructor.name, input: c.input }); return { User: { Attributes: [{ Name: "sub", Value: SUB }] }, UserAttributes: [{ Name: "sub", Value: SUB }], UserStatus: "FORCE_CHANGE_PASSWORD" }; } } };
  }

  it.each([
    [{ action: "invite", email: "owner@example.test" }],
    [{ action: "resend", email: "owner@example.test" }],
    [{ action: "disable", sub: SUB }],
    [{ action: "enable", sub: SUB }],
  ] as const)("%j is sent only to the configured pool", async (request) => {
    const c = fake();
    await createIdentityHandler(c.client as never, PRD_POOL, () => undefined)(request as never);
    expect(c.sent.length).toBeGreaterThan(0);
    for (const call of c.sent) expect(call.input.UserPoolId).toBe(PRD_POOL);
    expect(JSON.stringify(c.sent)).not.toContain(SHARED_POOL);
  });

  it("two functions with two pools never touch each other's pool", async () => {
    const prd = fake(), pilot = fake();
    await createIdentityHandler(prd.client as never, PRD_POOL, () => undefined)({ action: "invite", email: "a@example.test" });
    await createIdentityHandler(pilot.client as never, SHARED_POOL, () => undefined)({ action: "invite", email: "b@example.test" });
    expect(new Set(prd.sent.map((c) => c.input.UserPoolId))).toEqual(new Set([PRD_POOL]));
    expect(new Set(pilot.sent.map((c) => c.input.UserPoolId))).toEqual(new Set([SHARED_POOL]));
  });
});
