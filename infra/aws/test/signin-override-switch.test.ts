// The sign-in override routes (migration 0103) are added to an environment's API only when its `features.signInOverride` switch is on.
// It is ON for the TEST stack (`ENVIRONMENTS.prod`) and, by the owner's request of 2026-11-15, for production (`ENVIRONMENTS.prd`). Merging does not deploy: the production API changes only when the
// release in docs/releases/2026-11-15-signin-override-production/ is executed, and its change must be exactly these two routes.
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
const OVERRIDE = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "signInOverride").map((r) => `${r.method} ${r.path}`).sort();

describe("signInOverride route switch", () => {
  it("marks exactly the two override routes", () => {
    expect(OVERRIDE).toEqual(["GET /v1/signin-overrides", "POST /v1/caregivers/{caregiverRecordId}/signin-override"]);
  });
  it("is ON for the TEST stack and for production: the two routes exist in both", () => {
    expect(ENVIRONMENTS.prod.features.signInOverride).toBe(true);
    expect(ENVIRONMENTS.prd.features.signInOverride).toBe(true);
    for (const k of OVERRIDE) { expect(keys(ENVIRONMENTS.prod).some((r) => r.key === k), k).toBe(true); expect(keys(ENVIRONMENTS.prd).some((r) => r.key === k), k).toBe(true); }
  });
  it("production with the switch ON differs from production with it OFF by exactly the two JWT routes (nothing public, nothing else added)", () => {
    const off = { ...ENVIRONMENTS.prd, features: { ...ENVIRONMENTS.prd.features, signInOverride: false } } as OgeviaEnvironmentConfig;
    const on = keys(ENVIRONMENTS.prd), before = new Set(keys(off).map((r) => r.key));
    expect(on.filter((r) => !before.has(r.key)).map((r) => r.key).sort()).toEqual(OVERRIDE);
    for (const k of OVERRIDE) expect(on.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    expect(before.size).toBe(on.length - 2);
  });
  it("with the switch on the routes require a JWT (nothing is public) and are the only difference from the same stack with it off", () => {
    const off = { ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, signInOverride: false } } as OgeviaEnvironmentConfig;
    const have = keys(ENVIRONMENTS.prod);
    for (const k of OVERRIDE) expect(have.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    expect(have.length).toBe(keys(off).length + 2);
  });
});
