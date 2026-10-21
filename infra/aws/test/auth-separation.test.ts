import { describe, expect, it } from "vitest";
import { findSharedAuth } from "../lib/auth-separation.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";

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

  // KNOWN EXCEPTION, recorded so it cannot grow unnoticed. When the separation is deployed, delete this test and remove `.fails`
  // from the target test below in the same change.
  it("today pilot (prod) and production (prd) share exactly the pool, its domain and the legacy client", () => {
    expect(findSharedAuth(configs)).toEqual([
      { kind: "cognitoDomain", value: LIVE_DOMAIN, environments: ["prd", "prod"] },
      { kind: "legacyClient", value: LIVE_LEGACY_CLIENT, environments: ["prd", "prod"] },
      { kind: "userPool", value: LIVE_POOL, environments: ["prd", "prod"] },
    ]);
  });

  // TARGET (docs/aws/AUTH_SEPARATION_PHASE2_DESIGN.md part C). Expected to fail until each environment has its own pool.
  it.fails("target: no pool, domain or client identifier is shared between environments", () => {
    expect(findSharedAuth(configs)).toEqual([]);
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
