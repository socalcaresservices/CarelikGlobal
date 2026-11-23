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
  it("marks exactly the 14 staff routes (13 for the Owner and the staff list, plus the invited person's accept route from 0087)", () => {
    expect(STAFF).toHaveLength(14);
    expect(STAFF.every((k) => /\/v1\/(staff|staff-[a-z]+|role-permissions)(\/|$)/.test(k) || k === "POST /v1/me/staff-invitations/{organizationId}/accept")).toBe(true);
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
    // The one allowed difference: the route behind the release switch that is ON for TEST only (bulkImport). signInOverride is ON for production too since the owner's request of 2026-11-15;
    // bulkImport and staffDuplicates stay off in production, and nothing else may differ between the two route tables.
    const testOnly = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "bulkImport").map((r) => `${r.method} ${r.path}`).sort();
    expect(testOnly).toEqual(["POST /v1/imports/{kind}"]);
    const prodKeys = have.map((r) => r.key).sort();
    for (const k of testOnly) expect(prodKeys.includes(k), `${k} must not be in production`).toBe(false);
    // Production also has the release switches ON (request cleanup, offices, office assignments, assignment history: the live state since 2026-11-21/22); TEST patches them per release.
    const released = SERVICE_VERIFICATION_ROUTES.filter((r) => ["requestCleanup", "offices", "officeAssignments", "assignmentHistory"].includes(r.feature ?? "")).map((r) => `${r.method} ${r.path}`);
    expect(released.length).toBe(18);
    for (const k of released) expect(prodKeys.includes(k), `${k} must be in production`).toBe(true);
    expect(routeKeys("prod").map((r) => r.key).filter((k) => !testOnly.includes(k)).sort()).toEqual(prodKeys.filter((k) => !released.includes(k)));
  });
});
