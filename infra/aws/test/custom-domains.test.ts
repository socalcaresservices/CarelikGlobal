// Permanent hostnames are part of the code: aliases + certificate, Cognito callback/logout URLs and API CORS origins, with the CloudFront fallback kept.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { assertCustomDomains, customOriginsFor, ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { newApp } from "./helpers.js";

const HOSTS = { prd: ["app.ogevia.com", "admin.ogevia.com"], prod: ["demo.ogevia.com"] } as const;
const synth = (env: "prod" | "prd", suffix: string) => {
  const found = buildOgeviaApp(newApp(), ENVIRONMENTS[env], "plan").find((p) => p.stack.stackName.endsWith(suffix));
  return found ? Template.fromStack(found.stack) : undefined;
};
const clients = (t: Template) => Object.values(t.findResources("AWS::Cognito::UserPoolClient")).map((r) => r.Properties);

describe.each(["prd", "prod"] as const)("permanent hostnames (%s)", (env) => {
  const cfg = ENVIRONMENTS[env];
  it("CloudFront serves the hostnames over SNI with TLS 1.2 and the committed us-east-1 certificate", () => {
    const dist = Object.values(synth(env, "-WebHosting")!.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    expect(dist.Aliases).toEqual(HOSTS[env]);
    expect(dist.ViewerCertificate).toMatchObject({ AcmCertificateArn: cfg.customDomains!.certificateArn, SslSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" });
  });

  it("every browser client returns to the hostnames and keeps the CloudFront fallback", () => {
    const web = synth(env, "-WebHosting")!, auth = synth(env, "-Auth");
    const all = [...clients(web), ...(auth ? clients(auth) : [])];
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect(JSON.stringify(c.CallbackURLs)).toContain("/auth/callback");
      for (const h of HOSTS[env]) {
        expect(c.CallbackURLs).toContain(`https://${h}/auth/callback`);
        expect(c.LogoutURLs).toContain(`https://${h}/`);
      }
      expect(JSON.stringify([c.CallbackURLs, c.LogoutURLs])).not.toMatch(/http:|localhost/);
    }
  });

  it("API CORS allows the hostnames and the CloudFront fallback", () => {
    const api = Object.values(synth(env, "-ServiceVerificationApi")!.findResources("AWS::ApiGatewayV2::Api"))[0]!;
    const origins = JSON.stringify(api.Properties.CorsConfiguration.AllowOrigins);
    for (const o of customOriginsFor(cfg)) expect(origins).toContain(o);
    expect(origins).toContain("WebDistribution");
  });

  it("API CORS lists no origin twice (API Gateway rejects duplicates)", () => {
    for (const e of ["prd", "prod"] as const) {
      const api = Object.values(synth(e, "-ServiceVerificationApi")!.findResources("AWS::ApiGatewayV2::Api"))[0]!;
      const list = (api.Properties.CorsConfiguration.AllowOrigins as unknown[]).map((o) => JSON.stringify(o));
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe("assertCustomDomains", () => {
  const withDomains = (d: OgeviaEnvironmentConfig["customDomains"]): OgeviaEnvironmentConfig => ({ ...ENVIRONMENTS.prd, customDomains: d });
  const ARN = ENVIRONMENTS.prd.customDomains!.certificateArn;
  it("accepts the committed configuration and no configuration", () => {
    expect(() => assertCustomDomains(ENVIRONMENTS.prd)).not.toThrow();
    expect(() => assertCustomDomains(withDomains(undefined))).not.toThrow();
  });
  it("rejects a certificate outside us-east-1, an empty list and a malformed hostname", () => {
    expect(() => assertCustomDomains(withDomains({ hostnames: ["app.ogevia.com"], certificateArn: ARN.replace("us-east-1", "us-west-2") }))).toThrow(/us-east-1/);
    expect(() => assertCustomDomains(withDomains({ hostnames: [], certificateArn: ARN }))).toThrow(/at least one/);
    expect(() => assertCustomDomains(withDomains({ hostnames: ["https://app.ogevia.com/"], certificateArn: ARN }))).toThrow(/invalid hostname/);
  });
});
