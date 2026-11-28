// The signing-link email route is added to an environment's API only when `features.signatureEmail` is on. OFF in every environment.
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
const KEY = "POST /v1/visits/{visitId}/signature-link-email";

describe("signing-link email route switch", () => {
  it("is one JWT-only route, present in the API route table", () => {
    expect(SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "signatureEmail").map((r) => `${r.method} ${r.path}`)).toEqual([KEY]);
    expect(ROUTES[KEY]).toBeTruthy(); expect(ROUTES[KEY]!.public ?? false).toBe(false);
  });
  it("is OFF in every environment, and with the switch on adds exactly that route", () => {
    for (const env of Object.values(ENVIRONMENTS)) {
      expect(env.features.signatureEmail ?? false).toBe(false);
      const off = routes(env); expect(off.map((r) => r.key)).not.toContain(KEY);
      const on = routes({ ...env, features: { ...env.features, signatureEmail: true } } as OgeviaEnvironmentConfig);
      expect(on.length).toBe(off.length + 1); expect(on.find((r) => r.key === KEY)).toMatchObject({ auth: "JWT" });
    }
  });
});
