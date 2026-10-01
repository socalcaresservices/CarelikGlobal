import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { cognitoIssuer } from "../lib/auth-contract.js";
import { ENVIRONMENTS } from "../lib/config.js";
import {
  LAMBDA_ENVIRONMENT_KEYS,
  SERVICE_VERIFICATION_ROUTES,
} from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const prod = ENVIRONMENTS.prod;
const existing = prod.existing;

function synth() {
  const [, api] = buildOgeviaApp(newApp(), prod, "plan");
  return Template.fromStack(api!.stack);
}

describe("ServiceVerificationApiStack (FUTURE, Phase 4)", () => {
  const template = synth();

  it("models one HTTP API with a Cognito JWT authorizer on the existing user pool", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: Match.objectLike({
        AllowOrigins: [...prod.auth.allowedOrigins],
      }),
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: {
        Issuer: cognitoIssuer(prod.region, existing.cognitoUserPoolId),
        Audience: [prod.auth.appClientId],
      },
    });
  });

  it("protects every Service Verification route with the JWT authorizer", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const keys = Object.values(routes).map(
      (r) => (r.Properties as { RouteKey: string }).RouteKey,
    );
    expect(keys.sort()).toEqual(
      SERVICE_VERIFICATION_ROUTES.map((r) => `${r.method} ${r.path}`).sort(),
    );
    for (const route of Object.values(routes)) {
      expect(
        (route.Properties as { AuthorizationType: string }).AuthorizationType,
      ).toBe("JWT");
    }
  });

  it("throttles the stage and writes PHI-free access logs to a retained, finite log group", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 20,
        ThrottlingBurstLimit: 50,
      }),
      AccessLogSettings: Match.objectLike({ Format: Match.anyValue() }),
    });
    const stage = Object.values(
      template.findResources("AWS::ApiGatewayV2::Stage"),
    )[0]!;
    const format = (
      stage.Properties as { AccessLogSettings: { Format: string } }
    ).AccessLogSettings.Format;
    for (const banned of [
      "$context.path",
      "identity.sourceIp",
      "requestOverride",
      "$input",
      "querystring",
    ]) {
      expect(format).not.toContain(banned);
    }
    template.allResourcesProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 365,
    });
  });

  it("runs the Lambda in the existing private subnets with the existing application security group", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      VpcConfig: {
        SubnetIds: existing.vpc.privateSubnets.map((s) => s.subnetId),
        SecurityGroupIds: [existing.securityGroups.prodApp],
      },
    });
    // The RDS security group already admits 5432 from the app SG; CDK adds nothing.
    template.resourceCountIs("AWS::EC2::SecurityGroup", 0);
    template.resourceCountIs("AWS::EC2::SecurityGroupIngress", 0);
    template.resourceCountIs("AWS::EC2::SecurityGroupEgress", 0);
  });

  it("exposes exactly the environment contract, pointing at the existing database by reference", () => {
    const fn = Object.values(
      template.findResources("AWS::Lambda::Function"),
    )[0]!;
    const vars = (
      fn.Properties as { Environment: { Variables: Record<string, unknown> } }
    ).Environment.Variables;
    expect(Object.keys(vars).sort()).toEqual(
      [...LAMBDA_ENVIRONMENT_KEYS].sort(),
    );
    const db = existing.databases.prod;
    expect(vars.DB_HOST).toBe(db.endpointAddress);
    expect(vars.DB_PORT).toBe(String(db.port));
    expect(vars.DB_SECRET_ARN).toBe(existing.appDatabaseSecretArn);
    expect(vars.COGNITO_USER_POOL_ID).toBe(existing.cognitoUserPoolId);
    expect(JSON.stringify(vars)).not.toMatch(
      /resolve:secretsmanager|password/i,
    );
  });

  it("grants least-privilege access: one secret by exact ARN, signature objects, KMS via S3 only", () => {
    const policies = Object.values(
      template.findResources("AWS::IAM::ManagedPolicy"),
    );
    expect(policies).toHaveLength(1);
    template.resourceCountIs("AWS::IAM::Policy", 0);
    const statements = (
      policies[0]!.Properties as {
        PolicyDocument: {
          Statement: Array<{
            Sid: string;
            Action: string | string[];
            Resource: unknown;
            Condition?: unknown;
          }>;
        };
      }
    ).PolicyDocument.Statement;
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));

    expect(bySid.ReadAppDatabaseSecret).toMatchObject({
      Action: "secretsmanager:GetSecretValue",
      Resource: existing.appDatabaseSecretArn,
    });
    // The RDS master secret is never granted to the application.
    expect(JSON.stringify(statements)).not.toContain(
      existing.databases.prod.masterSecretArn,
    );
    expect(JSON.stringify(bySid.SignatureObjects?.Resource)).toContain(
      "/*/*/client-signature.png",
    );
    expect(bySid.SignatureObjects?.Action).toEqual([
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]);
    expect(bySid.EvidenceKeyForSignatureObjects?.Condition).toEqual({
      StringEquals: { "kms:ViaService": "s3.us-west-2.amazonaws.com" },
    });
    expect(bySid.WriteOwnLogGroup?.Action).toEqual([
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]);
    expect(statements.map((s) => s.Sid).sort()).toEqual([
      "EvidenceKeyForSignatureObjects",
      "ReadAppDatabaseSecret",
      "SignatureObjects",
      "VpcNetworkInterfaces",
      "WriteOwnLogGroup",
    ]);
  });

  it("attaches no AWS managed policy to the Lambda role", () => {
    const role = Object.values(template.findResources("AWS::IAM::Role"))[0]!;
    expect(
      (role.Properties as { ManagedPolicyArns?: unknown }).ManagedPolicyArns,
    ).toBeUndefined();
  });

  it("refuses to synthesize without a verified Cognito app client", () => {
    const unverified = {
      ...prod,
      auth: { ...prod.auth, appClientId: "__X__" },
    };
    expect(() => buildOgeviaApp(newApp(), unverified, "plan")).toThrow(
      /API auth contract not verified yet: appClientId/,
    );
  });
});
