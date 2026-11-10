// The sign-in override routes (pending migration 0090) are added to an environment's API only when its `features.signInOverride` switch is on.
// It is OFF in the test slice and in production until the owner approves the release in that environment, so no deployed API changes by merging this code.
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
  it("is OFF in the test slice and in production: neither route is in the API", () => {
    expect(ENVIRONMENTS.prod.features.signInOverride).toBe(false);
    expect(ENVIRONMENTS.prd.features.signInOverride).toBe(false);
    for (const env of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) for (const k of OVERRIDE) expect(keys(env).some((r) => r.key === k), k).toBe(false);
  });
  it("when the switch is turned on, both routes exist and require a JWT (nothing is public)", () => {
    const on = { ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, signInOverride: true } } as OgeviaEnvironmentConfig;
    const have = keys(on);
    for (const k of OVERRIDE) expect(have.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    expect(have.length).toBe(keys(ENVIRONMENTS.prod).length + 2);
  });
});
