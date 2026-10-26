// The staff-management routes (pending migration 0086) are added to an environment's API only when its `features.staffManagement` switch is on:
// the test slice has them and, since the owner's approval of 2026-10-25 (Pacific), so does production (with migration 0086 applied first). A third environment would have them off by default.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { SERVICE_VERIFICATION_ROUTES } from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const routeKeys = (env: "prod" | "prd") => {
  const api = buildOgeviaApp(newApp(), ENVIRONMENTS[env], "plan").find((p) => p.stack.stackName === `Ogevia-${env}-ServiceVerificationApi`)!;
  const routes = Template.fromStack(api.stack).findResources("AWS::ApiGatewayV2::Route");
  return Object.values(routes).map((r) => ({ key: (r.Properties as { RouteKey: string }).RouteKey, auth: (r.Properties as { AuthorizationType: string }).AuthorizationType }));
};
const STAFF = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "staffManagement").map((r) => `${r.method} ${r.path}`).sort();

describe("staffManagement route switch", () => {
  it("marks exactly the 13 staff routes", () => {
    expect(STAFF).toHaveLength(13);
    expect(STAFF.every((k) => /\/v1\/(staff|staff-[a-z]+|role-permissions)(\/|$)/.test(k))).toBe(true);
  });
  it("is on for the test slice (prod): every staff route exists and requires a JWT", () => {
    expect(ENVIRONMENTS.prod.features.staffManagement).toBe(true);
    const have = routeKeys("prod");
    for (const k of STAFF) expect(have.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
  });
  it("is ON for production (prd), by the owner's approval: every staff route exists, requires a JWT, and the production route table equals the test slice's", () => {
    expect(ENVIRONMENTS.prd.features.staffManagement).toBe(true);
    const have = routeKeys("prd");
    for (const k of STAFF) expect(have.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    expect(have.length).toBe(routeKeys("prod").length);
    expect(have.map((r) => r.key).sort()).toEqual(routeKeys("prod").map((r) => r.key).sort());
  });
});
