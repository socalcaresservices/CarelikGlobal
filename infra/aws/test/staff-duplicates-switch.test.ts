// The bulk duplicate-staff routes (pending migration 0093) is added to an environment's API only when its `features.staffDuplicates` switch is on.
// Owner decision: OFF in both TEST and production.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { SERVICE_VERIFICATION_ROUTES } from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const keys = (cfg: OgeviaEnvironmentConfig) => {
  const api = buildOgeviaApp(newApp(), cfg, "plan").find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!;
  return Object.values(Template.fromStack(api.stack).findResources("AWS::ApiGatewayV2::Route")).map((r) => ({ key: (r.Properties as { RouteKey: string }).RouteKey, auth: (r.Properties as { AuthorizationType?: string }).AuthorizationType }));
};
const IMPORT = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "staffDuplicates").map((r) => `${r.method} ${r.path}`);

describe("staffDuplicates route switch", () => {
  it("marks exactly the two duplicate-staff routes", () => expect([...IMPORT].sort()).toEqual(["GET /v1/staff/duplicates", "POST /v1/staff/{profileId}/merge"]));
  it("is OFF for both TEST and production: neither exposes merge routes", () => {
    expect(ENVIRONMENTS.prod.features.staffDuplicates).toBe(false);
    expect(ENVIRONMENTS.prd.features.staffDuplicates).toBe(false);
    for (const k of IMPORT) { expect(keys(ENVIRONMENTS.prod).some((r) => r.key === k), k).toBe(false); expect(keys(ENVIRONMENTS.prd).some((r) => r.key === k), k).toBe(false); }
  });
  it("with the switch on the routes require a JWT (nothing is public) and are the only difference from the same stack with it off", () => {
    const off = { ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, staffDuplicates: false } } as OgeviaEnvironmentConfig;
    const have = keys({ ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, staffDuplicates: true } });
    for (const k of IMPORT) expect(have.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    expect(have.length).toBe(keys(off).length + 2);
  });
});
