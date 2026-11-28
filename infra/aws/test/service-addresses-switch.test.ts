// The service-address routes (pending migration 0126) are added to an environment's API only when `features.serviceAddresses` is on. OFF in every environment.
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
const KEYS = ["GET /v1/clients/{clientId}/service-addresses", "GET /v1/clients/{clientId}/service-addresses/history", "POST /v1/service-locations/{serviceLocationId}/state", "POST /v1/service-locations/{serviceLocationId}/delete"];

describe("service addresses route switch", () => {
  it("is four JWT-only routes, all present in the API route table", () => {
    expect(SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "serviceAddresses").map((r) => `${r.method} ${r.path}`).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) { expect(ROUTES[k], k).toBeTruthy(); expect(ROUTES[k]!.public ?? false).toBe(false); }
  });
  it("is OFF in every environment, and with the switch on adds exactly those routes", () => {
    for (const env of Object.values(ENVIRONMENTS)) {
      expect(env.features.serviceAddresses ?? false).toBe(false);
      const off = routes(env); for (const k of KEYS) expect(off.map((r) => r.key)).not.toContain(k);
      const on = routes({ ...env, features: { ...env.features, serviceAddresses: true } } as OgeviaEnvironmentConfig);
      expect(on.length).toBe(off.length + KEYS.length);
      for (const k of KEYS) expect(on.find((r) => r.key === k)).toMatchObject({ auth: "JWT" });
    }
  });
});
