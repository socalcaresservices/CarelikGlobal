// Permanent hostnames: alternate domain names, Cognito callback/logout URLs and API CORS, with the CloudFront URL kept as a fallback.
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { newApp } from "./helpers.js";

const CERT = "arn:aws:acm:us-east-1:300094796789:certificate/12345678-1234-1234-1234-123456789012";
const synth = (env: "prod" | "prd", suffix: string) => {
  const planned = buildOgeviaApp(newApp(), ENVIRONMENTS[env], "plan");
  return Template.fromStack(planned.find((p) => p.stack.stackName.endsWith(suffix))!.stack);
};

afterEach(() => { delete process.env.OGEVIA_WEB_CERT_ARN; });

describe("custom domains", () => {
  it("without a certificate the templates have no aliases (unchanged behavior)", () => {
    const dist = Object.values(synth("prd", "-WebHosting").findResources("AWS::CloudFront::Distribution"))[0]!;
    expect(dist.Properties.DistributionConfig.Aliases).toBeUndefined();
  });

  it.each([["prd", ["app.ogevia.com", "admin.ogevia.com"]], ["prod", ["demo.ogevia.com"]]] as const)(
    "%s: aliases, TLS 1.2 policy, callbacks and CORS include %j and keep the CloudFront URL",
    (env, hosts) => {
      process.env.OGEVIA_WEB_CERT_ARN = CERT;
      const web = synth(env, "-WebHosting");
      const dist = Object.values(web.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
      expect(dist.Aliases).toEqual(hosts);
      expect(dist.ViewerCertificate).toMatchObject({ AcmCertificateArn: CERT, SslSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" });
      const client = Object.values(web.findResources("AWS::Cognito::UserPoolClient"))[0]!.Properties;
      const callbacks = JSON.stringify(client.CallbackURLs);
      expect(callbacks).toContain("WebDistribution"); // fallback kept
      for (const h of hosts) {
        expect(client.CallbackURLs).toContain(`https://${h}/auth/callback`);
        expect(client.LogoutURLs).toContain(`https://${h}/`);
      }
      const apiApp = Object.values(synth(env, "-ServiceVerificationApi").findResources("AWS::ApiGatewayV2::Api"))[0]!;
      const origins = JSON.stringify(apiApp.Properties.CorsConfiguration.AllowOrigins);
      for (const h of hosts) expect(origins).toContain(`https://${h}`);
      expect(origins).toContain("WebDistribution");
    },
  );

  it("a deploy that names permanent hostnames is refused without the certificate", () => {
    expect(() => buildOgeviaApp(newApp(), ENVIRONMENTS.prd, "deploy", "APPROVAL-001")).toThrow(/OGEVIA_WEB_CERT_ARN/);
  });

  it("rejects a certificate outside us-east-1", () => {
    process.env.OGEVIA_WEB_CERT_ARN = CERT.replace("us-east-1", "us-west-2");
    expect(() => buildOgeviaApp(newApp(), ENVIRONMENTS.prd, "plan")).toThrow(/us-east-1/);
  });
});
