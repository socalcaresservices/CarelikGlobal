// The NFC / QR visit-verification routes (pending migration 0120) are added to an environment's API only when `features.homeLabels` is on. The switch is OFF in every environment.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../../../apps/sv-api/src/routes.js";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { SERVICE_VERIFICATION_ROUTES } from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const routes = (cfg: OgeviaEnvironmentConfig) => {
  const api = buildOgeviaApp(newApp(), cfg, "plan").find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!;
  return Object.values(Template.fromStack(api.stack).findResources("AWS::ApiGatewayV2::Route")).map((r) => ({ key: (r.Properties as { RouteKey: string }).RouteKey, auth: (r.Properties as { AuthorizationType?: string }).AuthorizationType }));
};
const LABEL_ROUTES = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "homeLabels").map((r) => `${r.method} ${r.path}`).sort();

describe("home label (0120) route switch", () => {
  it("marks 29 routes, every one of them a handler in the API route table, none public", () => {
    expect(LABEL_ROUTES).toHaveLength(29);
    for (const k of LABEL_ROUTES) { expect(ROUTES[k], k).toBeTruthy(); expect(ROUTES[k]!.public ?? false, k).toBe(false); }
    expect(SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "homeLabels").some((r) => r.public)).toBe(false);
  });
  it("is OFF in every environment: none of the routes exists, so the synthesized API is unchanged", () => {
    for (const env of Object.values(ENVIRONMENTS)) {
      expect(env.features.homeLabels ?? false).toBe(false);
      const keys = routes(env).map((r) => r.key);
      for (const k of LABEL_ROUTES) expect(keys, k).not.toContain(k);
    }
  });
  it("with the switch on exactly those routes are added, all require a JWT, and nothing else differs", () => {
    for (const base of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      const off = routes(base);
      const on = routes({ ...base, features: { ...base.features, homeLabels: true } } as OgeviaEnvironmentConfig);
      expect(on.length).toBe(off.length + LABEL_ROUTES.length);
      for (const k of LABEL_ROUTES) expect(on.find((r) => r.key === k), k).toMatchObject({ auth: "JWT" });
      expect(on.filter((r) => !LABEL_ROUTES.includes(r.key)).map((r) => r.key).sort()).toEqual(off.map((r) => r.key).sort());
    }
  });
});
