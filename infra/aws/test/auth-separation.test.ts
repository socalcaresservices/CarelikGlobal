import { describe, expect, it } from "vitest";
import { findSharedAuth } from "../lib/auth-separation.js";
import { assertAuthConfig, ENVIRONMENTS, forbiddenUserPoolIdsFor, type OgeviaEnvironmentConfig } from "../lib/config.js";

// Live values read on 2026-10-21 from the owner's CloudShell inventory (docs/aws/INVENTORY_RECONCILIATION_2026-10-21.md).
const LIVE_POOL = "us-west-2_849AYz5J7";
const LIVE_LEGACY_CLIENT = "1i27abbina08fvg1i9u8vprgo9";
const LIVE_DOMAIN = "https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com";

const withAuth = (base: OgeviaEnvironmentConfig, envName: string, pool: string, client: string, domain: string): OgeviaEnvironmentConfig =>
  ({
    ...base,
    envName: envName as OgeviaEnvironmentConfig["envName"],
    existing: { ...base.existing, cognitoUserPoolId: pool },
    auth: { ...base.auth, appClientId: client },
    testSlice: { ...base.testSlice, cognitoDomain: domain },
  }) as OgeviaEnvironmentConfig;

describe("authentication identifiers shared between environments", () => {
  const configs = Object.values(ENVIRONMENTS);

  it("the committed configuration matches what the live account reported", () => {
    for (const c of configs) {
      expect(c.existing.cognitoUserPoolId).toBe(LIVE_POOL);
      expect(c.auth.appClientId).toBe(LIVE_LEGACY_CLIENT);
      expect(c.testSlice.cognitoDomain).toBe(LIVE_DOMAIN);
    }
  });

  // The separation is implemented in code: production owns a dedicated pool, domain and client. (Before this change the shared pool,
  // its domain and the legacy client were shared; this test failed `it.fails` until then. It is now a hard rule.)
  it("no pool, domain or client identifier is shared between environments", () => {
    expect(findSharedAuth(configs)).toEqual([]);
  });

  it("production has a dedicated pool and the pilot keeps the shared one", () => {
    expect(ENVIRONMENTS.prd.auth.dedicatedUserPool?.domainPrefix).toMatch(/^ogevia-prd-/);
    expect(ENVIRONMENTS.prod.auth.dedicatedUserPool).toBeUndefined();
    expect(ENVIRONMENTS.prod.existing.cognitoUserPoolId).toBe(LIVE_POOL);
  });

  it("production's inherited shared-pool identifiers are only ever used to FORBID that pool", () => {
    expect(forbiddenUserPoolIdsFor(ENVIRONMENTS.prd)).toEqual([LIVE_POOL]);
    expect(forbiddenUserPoolIdsFor(ENVIRONMENTS.prod)).toEqual([]);
  });

  describe("configuration guards", () => {
    const prd = ENVIRONMENTS.prd;
    it("production without a dedicated pool is refused", () => {
      expect(() => assertAuthConfig({ ...prd, auth: { ...prd.auth, dedicatedUserPool: undefined } } as OgeviaEnvironmentConfig)).toThrow(/dedicated Cognito user pool/);
    });
    it("the pilot may not acquire a dedicated pool", () => {
      expect(() => assertAuthConfig({ ...ENVIRONMENTS.prod, auth: { ...ENVIRONMENTS.prod.auth, dedicatedUserPool: { domainPrefix: "ogevia-x-1234" } } } as OgeviaEnvironmentConfig)).toThrow(/only production/);
    });
    it.each(["x", "UPPER-case-1", "has_underscore", "my-cognito-pool", "aws-pool-001"])("a malformed or reserved domain prefix %s is refused", (domainPrefix) => {
      expect(() => assertAuthConfig({ ...prd, auth: { ...prd.auth, dedicatedUserPool: { domainPrefix } } } as OgeviaEnvironmentConfig)).toThrow(/domain prefix is malformed/);
    });
    it("the shared pool's domain prefix is refused for production", () => {
      expect(() => assertAuthConfig({ ...prd, auth: { ...prd.auth, dedicatedUserPool: { domainPrefix: "us-west-2849ayz5j7" } } } as OgeviaEnvironmentConfig)).toThrow(/must differ/);
    });
  });

  describe("the checker", () => {
    const [prod] = configs as [OgeviaEnvironmentConfig];
    it("reports nothing when every environment has its own identifiers", () => {
      const a = withAuth(prod, "prod", "us-west-2_AAAAAAAAA", "a".repeat(26), "https://a.auth.us-west-2.amazoncognito.com");
      const b = withAuth(prod, "prd", "us-west-2_BBBBBBBBB", "b".repeat(26), "https://b.auth.us-west-2.amazoncognito.com");
      expect(findSharedAuth([a, b])).toEqual([]);
    });

    it("reports a pool shared by two environments but not a client that differs", () => {
      const a = withAuth(prod, "prod", "us-west-2_AAAAAAAAA", "a".repeat(26), "https://a.auth.us-west-2.amazoncognito.com");
      const b = withAuth(prod, "prd", "us-west-2_AAAAAAAAA", "b".repeat(26), "https://b.auth.us-west-2.amazoncognito.com");
      expect(findSharedAuth([a, b])).toEqual([{ kind: "userPool", value: "us-west-2_AAAAAAAAA", environments: ["prd", "prod"] }]);
    });

    it("a single environment cannot share with itself", () => {
      expect(findSharedAuth([prod])).toEqual([]);
    });
  });
});
