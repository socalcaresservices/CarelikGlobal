// The six offices routes (pending migration 0110) are added to an environment's API only when `features.offices` is on. The switch is ABSENT (off) in every
// environment in this release candidate, so merging this code changes no deployed API and no synthesized template.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { SERVICE_VERIFICATION_ROUTES } from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const routes = (cfg: OgeviaEnvironmentConfig) => {
  const api = buildOgeviaApp(newApp(), cfg, "plan").find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!;
  return Object.values(Template.fromStack(api.stack).findResources("AWS::ApiGatewayV2::Route")).map((r) => ({ key: (r.Properties as { RouteKey: string }).RouteKey, auth: (r.Properties as { AuthorizationType?: string }).AuthorizationType }));
};
const OFFICES = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "offices").map((r) => `${r.method} ${r.path}`).sort();

describe("offices route switch", () => {
  it("marks exactly the six office routes", () => {
    expect(OFFICES).toEqual([
      "GET /v1/client-offices", "GET /v1/offices", "POST /v1/clients/{clientId}/office", "POST /v1/offices", "POST /v1/offices/{officeId}/rename", "POST /v1/offices/{officeId}/retire",
    ].sort());
  });
  it("is absent (off) in TEST and production: none of the routes exists", () => {
    for (const cfg of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      expect(cfg.features.offices ?? false).toBe(false);
      const have = routes(cfg).map((r) => r.key);
      for (const k of OFFICES) expect(have, k).not.toContain(k);
    }
  });
  it("with the switch on exactly those six routes are added, all require a JWT, and nothing else differs", () => {
    for (const base of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      const on = { ...base, features: { ...base.features, offices: true } } as OgeviaEnvironmentConfig;
      const off = routes(base); const withOn = routes(on);
      expect(withOn.length).toBe(off.length + 6);
      for (const k of OFFICES) expect(withOn.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
      expect(withOn.filter((r) => !OFFICES.includes(r.key)).map((r) => r.key).sort()).toEqual(off.map((r) => r.key).sort());
    }
  });
});

describe("office assignments route switch (0111)", () => {
  const ASSIGN = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "officeAssignments").map((r) => `${r.method} ${r.path}`).sort();
  it("marks exactly the eight 0111 routes", () => {
    expect(ASSIGN).toEqual(["GET /v1/people-facets", "POST /v1/caregivers/{caregiverRecordId}/color", "POST /v1/caregivers/{caregiverRecordId}/offices", "POST /v1/caregivers/{caregiverRecordId}/service-counties",
      "POST /v1/clients/{clientId}/offices", "POST /v1/clients/{clientId}/service-county", "POST /v1/offices/{officeId}/reactivate", "POST /v1/offices/{officeId}/update"].sort());
  });
  it("is absent (off) in TEST and production, and with the switch on exactly those eight JWT routes are added", () => {
    for (const base of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      expect(base.features.officeAssignments ?? false).toBe(false);
      const have = routes(base).map((r) => r.key); for (const k of ASSIGN) expect(have, k).not.toContain(k);
      const on = { ...base, features: { ...base.features, officeAssignments: true } } as OgeviaEnvironmentConfig;
      const withOn = routes(on); expect(withOn.length).toBe(have.length + 8);
      for (const k of ASSIGN) expect(withOn.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
    }
  });
});

describe("assignment history route switch (0112)", () => {
  const H = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "assignmentHistory").map((r) => `${r.method} ${r.path}`);
  it("is exactly one read route behind its own switch, absent (off) in TEST and production, and a JWT route when on", () => {
    expect(H).toEqual(["GET /v1/assignment-history"]);
    for (const base of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      expect(base.features.assignmentHistory ?? false).toBe(false);
      const have = routes(base).map((r) => r.key); expect(have).not.toContain(H[0]);
      const on = { ...base, features: { ...base.features, assignmentHistory: true } } as OgeviaEnvironmentConfig;
      const withOn = routes(on); expect(withOn.length).toBe(have.length + 1);
      expect(withOn.find((r) => r.key === H[0])).toMatchObject({ auth: "JWT" });
    }
  });
});
