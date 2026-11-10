// The bulk import route (pending migration 0092) is added to an environment's API only when its `features.bulkImport` switch is on.
// OFF in the test slice and in production until the owner approves the release in that environment, so merging this code changes no deployed API.
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
const IMPORT = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "bulkImport").map((r) => `${r.method} ${r.path}`);

describe("bulkImport route switch", () => {
  it("marks exactly the one import route", () => expect(IMPORT).toEqual(["POST /v1/imports/{kind}"]));
  it("is OFF in the test slice and in production", () => {
    expect(ENVIRONMENTS.prod.features.bulkImport).toBe(false);
    expect(ENVIRONMENTS.prd.features.bulkImport).toBe(false);
    for (const env of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) expect(keys(env).some((r) => r.key === IMPORT[0])).toBe(false);
  });
  it("when turned on, the route exists and requires a JWT", () => {
    const on = { ...ENVIRONMENTS.prod, features: { ...ENVIRONMENTS.prod.features, bulkImport: true } } as OgeviaEnvironmentConfig;
    expect(keys(on).find((r) => r.key === IMPORT[0])).toMatchObject({ auth: "JWT" });
    expect(keys(on).length).toBe(keys(ENVIRONMENTS.prod).length + 1);
  });
});
