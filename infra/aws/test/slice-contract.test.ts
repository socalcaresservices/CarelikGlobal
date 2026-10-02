// Phase 3-6 infrastructure contract for the testable vertical slice.
import { Template } from "aws-cdk-lib/assertions";
import { ROUTE_KEYS } from "@carelik/sv-api";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { SERVICE_VERIFICATION_ROUTES } from "../lib/service-verification-api-stack.js";
import { scanTemplate, type CfnTemplate } from "../lib/template-scan.js";
import { contentSecurityPolicy } from "../lib/web-hosting-stack.js";
import { newApp } from "./helpers.js";

const prod = ENVIRONMENTS.prod;
const planned = buildOgeviaApp(newApp(), prod, "plan");
const byName = (suffix: string) => {
  const s = planned.find((p) => p.stack.stackName.endsWith(suffix))!.stack;
  return Template.fromStack(s);
};
const api = byName("-ServiceVerificationApi");
const web = byName("-WebHosting");

describe("API routes == handler routes with explicit auth contracts", () => {
  it("CDK routes are exactly the handler's route table", () => {
    expect(SERVICE_VERIFICATION_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual(ROUTE_KEYS);
  });

  it("JWT protects app routes; only declared capability routes are public", () => {
    const routes = Object.values(api.findResources("AWS::ApiGatewayV2::Route"));
    expect(routes).toHaveLength(ROUTE_KEYS.length);
    for (const r of routes) {
      const declared = SERVICE_VERIFICATION_ROUTES.find((route) => `${route.method} ${route.path}` === r.Properties.RouteKey);
      expect(r.Properties.AuthorizationType).toBe(declared?.auth === "public" ? "NONE" : "JWT");
      if (declared?.auth === "public") expect(r.Properties.AuthorizerId).toBeUndefined();
      else expect(r.Properties.AuthorizerId).toBeDefined();
      expect(r.Properties.RouteKey).not.toBe("$default");
    }
  });

  it("the authorizer accepts exactly the existing client and the test-slice client", () => {
    const [authz] = Object.values(api.findResources("AWS::ApiGatewayV2::Authorizer"));
    const audience = authz!.Properties.JwtConfiguration.Audience as unknown[];
    expect(audience).toHaveLength(2);
    expect(audience[0]).toBe(prod.auth.appClientId);
    expect(JSON.stringify(audience[1])).toContain("TestSliceAppClient");
  });
});

describe("Lambda runs the real bundled handler", () => {
  const [fn] = Object.values(api.findResources("AWS::Lambda::Function"));
  it("code is a bundled asset (not the Phase 1 inline placeholder)", () => {
    expect(fn!.Properties.Code.ZipFile).toBeUndefined();
    expect(fn!.Properties.Code.S3Key).toMatch(/\.zip$/);
    expect(fn!.Properties.Handler).toBe("index.handler");
    expect(fn!.Properties.Runtime).toBe("nodejs24.x");
  });
  it("environment: test database, ogevia_app role, RDS CA, both client ids; no secret values", () => {
    const vars = fn!.Properties.Environment.Variables;
    expect(vars.DB_NAME).toBe(prod.testSlice.databaseName);
    expect(vars.DB_SET_ROLE).toBe("ogevia_app");
    expect(vars.NODE_EXTRA_CA_CERTS).toBe("/var/runtime/ca-cert.pem");
    expect(JSON.stringify(vars.COGNITO_APP_CLIENT_ID)).toContain(prod.auth.appClientId);
    expect(JSON.stringify(vars)).not.toMatch(/password|resolve:secretsmanager/i);
  });
  it("the API stack depends on the egress endpoints", () => {
    const apiStack = planned.find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!.stack;
    expect(apiStack.dependencies.map((d) => d.stackName)).toContain("Ogevia-prod-NetworkEgress");
  });
});

describe("Web hosting (Phase 6)", () => {
  it("site bucket is private and only CloudFront (OAC) can read it", () => {
    web.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    web.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    const policies = JSON.stringify(web.findResources("AWS::S3::BucketPolicy"));
    expect(policies).toContain("cloudfront.amazonaws.com");
    expect(policies).toContain("AWS:SourceArn");
  });

  it("HTTPS only, SPA rewrite, strict security headers", () => {
    const [dist] = Object.values(web.findResources("AWS::CloudFront::Distribution"));
    expect(dist!.Properties.DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    web.resourceCountIs("AWS::CloudFront::Function", 1);
    const [policy] = Object.values(web.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
    const sec = policy!.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    expect(sec.FrameOptions.FrameOption).toBe("DENY");
    expect(sec.StrictTransportSecurity.AccessControlMaxAgeSec).toBe(31536000);
    const csp = sec.ContentSecurityPolicy.ContentSecurityPolicy as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain(prod.testSlice.cognitoDomain);
  });

  it("CSP allows no third-party script or connect origins beyond the API and Cognito", () => {
    const csp = contentSecurityPolicy("https://x.auth.us-west-2.amazoncognito.com", "us-west-2");
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src"))!;
    expect(connect.split(" ").slice(1)).toEqual(["'self'", "https://*.execute-api.us-west-2.amazonaws.com", "https://x.auth.us-west-2.amazoncognito.com"]);
  });

  it("test-slice app client: public, code flow only, callbacks bound to the distribution", () => {
    const [client] = Object.values(web.findResources("AWS::Cognito::UserPoolClient"));
    const p = client!.Properties;
    expect(p.UserPoolId).toBe(prod.existing.cognitoUserPoolId);
    expect(p.GenerateSecret).toBe(false);
    expect(p.AllowedOAuthFlows).toEqual(["code"]);
    expect(p.AllowedOAuthScopes).toEqual(["openid", "email"]);
    expect(p.ExplicitAuthFlows).toEqual(["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]);
    expect(p.PreventUserExistenceErrors).toBe("ENABLED");
    expect(p.EnableTokenRevocation).toBe(true);
    expect(JSON.stringify(p.CallbackURLs)).toContain("WebDistribution");
    expect(JSON.stringify(p.CallbackURLs)).toContain("/auth/callback");
    web.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 1);
  });

  it("creates no user pool and never references the existing ogevia-web client for change", () => {
    for (const { stack } of planned) {
      const t = Template.fromStack(stack).toJSON() as CfnTemplate;
      const types = Object.values(t.Resources ?? {}).map((r) => r.Type);
      expect(types).not.toContain("AWS::Cognito::UserPool");
      expect(types).not.toContain("AWS::Cognito::UserPoolDomain");
      expect(types.filter((x) => x === "AWS::Cognito::UserPoolClient").length).toBeLessThanOrEqual(1);
    }
  });
});

describe("template scanner negative controls (each rule must fire)", () => {
  const scan = (stack: string, Resources: CfnTemplate["Resources"]) => scanTemplate(stack, { Resources }).map((v) => v.rule);
  it("unauthenticated and catch-all routes", () => {
    expect(scan("x", { R: { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: "GET /v1/me", AuthorizationType: "NONE" } } })).toContain("unauthenticated-route");
    expect(scan("x", { R: { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: "$default", AuthorizationType: "JWT", AuthorizerId: "a" } } })).toContain("catch-all-route");
    expect(scan("x", { R: { Type: "AWS::ApiGatewayV2::Route", Properties: { RouteKey: "ANY /{proxy+}", AuthorizationType: "JWT", AuthorizerId: "a" } } })).toContain("catch-all-route");
  });
  it("authorizer without audience", () => {
    expect(scan("x", { A: { Type: "AWS::ApiGatewayV2::Authorizer", Properties: { AuthorizerType: "JWT", JwtConfiguration: {} } } })).toContain("weak-authorizer");
  });
  it("app client with secret, implicit flow, http callback, or password flow", () => {
    const rules = scan("x", {
      C: { Type: "AWS::Cognito::UserPoolClient", Properties: { GenerateSecret: true, AllowedOAuthFlows: ["implicit"], CallbackURLs: ["http://evil.example/cb"], ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH"] } },
    });
    expect(rules).toEqual(expect.arrayContaining(["client-secret", "oauth-flow", "insecure-redirect", "password-flow"]));
  });
  it("rules on existing security groups, even inside the NetworkEgress stack", () => {
    expect(scan("Ogevia-prod-NetworkEgress", { I: { Type: "AWS::EC2::SecurityGroupIngress", Properties: { GroupId: "sg-064ffce3bcbe8eb3b", FromPort: 443, ToPort: 443 } } })).toContain("rule-on-existing-sg");
    expect(scan("Ogevia-prod-ServiceVerificationApi", { I: { Type: "AWS::EC2::SecurityGroupIngress", Properties: { GroupId: { Ref: "X" } } } })).toContain("deferred-or-existing-resource-type");
  });
  it("endpoints and SGs outside the NetworkEgress stack", () => {
    expect(scan("Ogevia-prod-WebHosting", { E: { Type: "AWS::EC2::VPCEndpoint", Properties: {} } })).toContain("deferred-or-existing-resource-type");
  });
  it("unscoped gateway endpoint policy and interface endpoint without private DNS", () => {
    expect(scan("Ogevia-prod-NetworkEgress", { G: { Type: "AWS::EC2::VPCEndpoint", Properties: { VpcEndpointType: "Gateway", PolicyDocument: { Statement: [{ Effect: "Allow", Resource: "*" }] } } } })).toContain("endpoint-policy");
    expect(scan("Ogevia-prod-NetworkEgress", { I: { Type: "AWS::EC2::VPCEndpoint", Properties: { VpcEndpointType: "Interface", PrivateDnsEnabled: false } } })).toContain("endpoint-private-dns");
  });
  it("CloudFront allowing plain HTTP", () => {
    expect(scan("x", { D: { Type: "AWS::CloudFront::Distribution", Properties: { DistributionConfig: { DefaultCacheBehavior: { ViewerProtocolPolicy: "allow-all" } } } } })).toContain("cloudfront-http");
  });
  it("VPC Lambda without an ordered ENI policy", () => {
    const fn = { Type: "AWS::Lambda::Function", Properties: { VpcConfig: { SubnetIds: ["s"], SecurityGroupIds: ["g"] }, Role: { "Fn::GetAtt": ["R", "Arn"] } } };
    const pol = { Type: "AWS::IAM::ManagedPolicy", Properties: { Roles: [{ Ref: "R" }], PolicyDocument: { Statement: [{ Effect: "Allow", Action: ["ec2:CreateNetworkInterface"], Resource: "*" }] } } };
    expect(scan("x", { F: { ...fn, DependsOn: ["R"] } as never, P: pol })).toContain("vpc-lambda-eni-ordering");
    expect(scan("x", { F: { ...fn, DependsOn: ["R", "P"] } as never, P: pol })).not.toContain("vpc-lambda-eni-ordering");
    expect(scan("x", { F: fn })).toContain("vpc-lambda-eni-policy");
  });
  it("NAT gateways stay deferred everywhere", () => {
    expect(scan("Ogevia-prod-NetworkEgress", { N: { Type: "AWS::EC2::NatGateway", Properties: {} } })).toContain("deferred-or-existing-resource-type");
  });
});

describe("Lambda creation ordering (regression: first deploy failed on CreateNetworkInterface)", () => {
  const resources = api.toJSON().Resources as Record<string, { Type: string; DependsOn?: string[]; Properties?: Record<string, unknown> }>;
  const [fnId, fn] = Object.entries(resources).find(([, r]) => r.Type === "AWS::Lambda::Function")!;
  const roleRef = (fn.Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
  const enIActions = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"];
  const enIPolicies = Object.entries(resources).filter(([, r]) => {
    if (r.Type !== "AWS::IAM::ManagedPolicy" && r.Type !== "AWS::IAM::Policy") return false;
    const roles = JSON.stringify(r.Properties!.Roles ?? []);
    const actions = JSON.stringify((r.Properties!.PolicyDocument as { Statement: unknown[] }).Statement);
    return roles.includes(roleRef) && enIActions.every((a) => actions.includes(a));
  });

  it("the execution role receives the ENI permissions from exactly one attached policy", () => {
    expect(enIPolicies).toHaveLength(1);
  });

  it(`${fnId} DependsOn the policy that grants its ENI permissions`, () => {
    expect(fn.DependsOn ?? []).toEqual(expect.arrayContaining([enIPolicies[0]![0], roleRef]));
  });

  it("ENI actions stay least-privilege (exactly the 5 VPC attachment actions on *)", () => {
    const statements = (resources[enIPolicies[0]![0]]!.Properties!.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown }> }).Statement;
    const wildcard = statements.filter((st) => JSON.stringify(st.Resource) === '"*"');
    expect(wildcard).toHaveLength(1);
    expect([...(wildcard[0]!.Action as string[])].sort()).toEqual([
      "ec2:AssignPrivateIpAddresses",
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:UnassignPrivateIpAddresses",
    ]);
    const managed = JSON.stringify(resources[roleRef]!.Properties!.ManagedPolicyArns ?? []);
    expect(managed).not.toMatch(/AWSLambdaVPCAccessExecutionRole|AdministratorAccess/);
  });
});
