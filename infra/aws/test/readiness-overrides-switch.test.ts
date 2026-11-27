// The readiness-override routes (migration 0123) are added to an environment's API only when its `features.readinessOverrides` switch is on. OFF in code for the TEST stack and for production:
// merging does not deploy; TEST turns it on in its own stage (docs/release-train-2/test-rollout-readiness-override.md) and production stays pending the owner's approval.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { SERVICE_VERIFICATION_ROUTES } from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const keys = (cfg: OgeviaEnvironmentConfig) => {
  const api = buildOgeviaApp(newApp(), cfg, "plan").find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!;
  return Object.values(Template.fromStack(api.stack).findResources("AWS::ApiGatewayV2::Route")).map((r) => ({ key: (r.Properties as { RouteKey: string }).RouteKey, auth: (r.Properties as { AuthorizationType: string }).AuthorizationType }));
};
const ROUTES = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "readinessOverrides").map((r) => `${r.method} ${r.path}`).sort();

describe("readinessOverrides route switch", () => {
  it("marks exactly the three override routes", () => {
    expect(ROUTES).toEqual(["GET /v1/readiness-overrides", "POST /v1/caregivers/{caregiverRecordId}/readiness-override", "POST /v1/readiness-overrides/{overrideId}/revoke"]);
  });
  it("is OFF for the TEST stack and for production in code: no override route exists in either", () => {
    expect(ENVIRONMENTS.prod.features.readinessOverrides ?? false).toBe(false);
    expect(ENVIRONMENTS.prd.features.readinessOverrides ?? false).toBe(false);
    for (const k of ROUTES) { expect(keys(ENVIRONMENTS.prod).some((r) => r.key === k), k).toBe(false); expect(keys(ENVIRONMENTS.prd).some((r) => r.key === k), k).toBe(false); }
  });
  it("switched ON, TEST differs from TEST with it OFF by exactly the three JWT routes (nothing public, nothing else added)", () => {
    const on = { ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, readinessOverrides: true } } as OgeviaEnvironmentConfig;
    const have = keys(on), before = new Set(keys(ENVIRONMENTS.prod).map((r) => r.key));
    expect(have.filter((r) => !before.has(r.key)).map((r) => r.key).sort()).toEqual(ROUTES);
    for (const k of ROUTES) expect(have.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    expect(have.length).toBe(before.size + 3);
  });
});
