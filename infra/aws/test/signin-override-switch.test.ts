// The sign-in override routes (pending migration 0090) are added to an environment's API only when its `features.signInOverride` switch is on.
// It is ON for the TEST stack (`ENVIRONMENTS.prod`) in this release candidate and OFF for production (`prd`) until the owner approves a production release, so no deployed API changes by merging this code.
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
  it("is ON for the TEST stack and OFF for production: the routes exist only in TEST", () => {
    expect(ENVIRONMENTS.prod.features.signInOverride).toBe(true);
    expect(ENVIRONMENTS.prd.features.signInOverride).toBe(false);
    for (const k of OVERRIDE) { expect(keys(ENVIRONMENTS.prod).some((r) => r.key === k), k).toBe(true); expect(keys(ENVIRONMENTS.prd).some((r) => r.key === k), k).toBe(false); }
  });
  it("with the switch on the routes require a JWT (nothing is public) and are the only difference from the same stack with it off", () => {
    const off = { ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, signInOverride: false } } as OgeviaEnvironmentConfig;
    const have = keys(ENVIRONMENTS.prod);
    for (const k of OVERRIDE) expect(have.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    expect(have.length).toBe(keys(off).length + 2);
  });
});
