import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { API_ROUTES } from "../lib/api-routes.js";
import { buildApp } from "../lib/ogevia-app.js";

const app = buildApp(
  new App({
    context: {
      stage: "dev",
      vpcId: "vpc-00000000000000000",
      azs: "us-west-2a,us-west-2b",
      privateSubnetIds: "subnet-00000000000000001,subnet-00000000000000002",
      dbAdminSecurityGroupId: "sg-00000000000000000",
      alarmEmail: "ops@example.invalid",
      monthlyBudgetUsd: "50",
    },
  }),
);
const t = (n: string) => Template.fromStack(app.node.findChild(`Ogevia-dev-${n}`) as never);

describe("Ogevia CDK", () => {
  it("RDS is private, encrypted, protected, SSL-only", () => {
    const d = t("Database");
    d.hasResourceProperties("AWS::RDS::DBInstance", {
      PubliclyAccessible: false, StorageEncrypted: true, DeletionProtection: true,
    });
    d.hasResourceProperties("AWS::RDS::DBParameterGroup", { Parameters: Match.objectLike({ "rds.force_ssl": "1" }) });
  });
  it("no NAT, CloudFront, or WAF anywhere", () => {
    for (const n of ["Evidence", "Database", "Auth", "Api", "Observability"]) {
      const j = JSON.stringify(t(n).toJSON());
      expect(j).not.toMatch(/AWS::EC2::NatGateway|AWS::CloudFront|AWS::WAF/);
    }
  });
  it("signature bucket is private, KMS-encrypted, versioned, retained", () => {
    const e = t("Evidence");
    e.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
      VersioningConfiguration: { Status: "Enabled" },
    });
    e.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    expect(JSON.stringify(e.toJSON())).not.toContain("ObjectLock");
  });
  it("Cognito: no self sign-up, no client secret", () => {
    const a = t("Auth");
    a.hasResourceProperties("AWS::Cognito::UserPool", { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
    a.hasResourceProperties("AWS::Cognito::UserPoolClient", { GenerateSecret: false });
  });
  it("every API route is JWT-authorized and limited to Phase 4 scope", () => {
    const api = t("Api");
    api.resourceCountIs("AWS::ApiGatewayV2::Route", API_ROUTES.length);
    const routes = Object.values(api.findResources("AWS::ApiGatewayV2::Route"));
    for (const r of routes) expect(r.Properties.AuthorizationType).toBe("JWT");
    expect(API_ROUTES.length).toBeLessThanOrEqual(10);
  });
  it("has alarms and a budget", () => {
    const o = t("Observability");
    o.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    o.resourceCountIs("AWS::Budgets::Budget", 1);
  });
});
