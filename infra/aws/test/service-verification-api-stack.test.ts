import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { cognitoIssuer } from "../lib/auth-contract.js";
import { ENVIRONMENTS, OGEVIA_ACCOUNT } from "../lib/config.js";
import {
  LAMBDA_ENVIRONMENT_KEYS,
  SERVICE_VERIFICATION_ROUTES,
} from "../lib/service-verification-api-stack.js";
import { APPROVED_PUBLIC_ROUTE_KEYS } from "../lib/public-routes.js";
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
        AllowOrigins: [...prod.auth.allowedOrigins, Match.anyValue()],
      }),
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      JwtConfiguration: {
        Issuer: cognitoIssuer(prod.region, existing.cognitoUserPoolId),
        Audience: [prod.auth.appClientId, Match.anyValue()],
      },
    });
  });

  it("JWT-protects staff routes and leaves only opaque-token care links public", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const keys = Object.values(routes).map(
      (r) => (r.Properties as { RouteKey: string }).RouteKey,
    );
    expect(keys.sort()).toEqual(
      SERVICE_VERIFICATION_ROUTES.map((r) => `${r.method} ${r.path}`).sort(),
    );
    const publicKeys = new Set(
      SERVICE_VERIFICATION_ROUTES.filter((r) => r.public).map((r) => `${r.method} ${r.path}`),
    );
    for (const route of Object.values(routes)) {
      const props = route.Properties as { RouteKey: string; AuthorizationType: string };
      expect(props.AuthorizationType).toBe(publicKeys.has(props.RouteKey) ? "NONE" : "JWT");
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
      template.findResources("AWS::Lambda::Function", { Properties: { Description: "Ogevia Service Verification API" } }),
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
      template.findResources("AWS::IAM::ManagedPolicy", { Properties: { Description: "Ogevia Service Verification API handler permissions" } }),
    );
    expect(policies).toHaveLength(1);
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 2);
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
    expect(JSON.stringify(bySid.StaffDocumentObjects?.Resource)).toContain("/*/documents/*/*");
    expect(bySid.StaffDocumentObjects?.Action).toEqual(["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]);
    expect(bySid.EvidenceKeyForSignatureObjects?.Condition).toEqual({
      StringEquals: { "kms:ViaService": "s3.us-west-2.amazonaws.com" },
    });
    expect(bySid.WriteOwnLogGroup?.Action).toEqual([
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]);
    expect(JSON.stringify(bySid.AgencyLogoObjects?.Resource)).toContain("/*/branding/logo/*");
    expect(statements.map((s) => s.Sid).sort()).toEqual([
      "AgencyLogoObjects",
      "EvidenceKeyForSignatureObjects",
      "InvokeIdentityAdmin",
      "ReadAppDatabaseSecret",
      "SignatureObjects",
      "StaffDocumentObjects",
      "VpcNetworkInterfaces",
      "WriteOwnLogGroup",
    ]);
  });

  it("attaches no AWS managed policy to either Lambda role", () => {
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    expect(roles).toHaveLength(2);
    for (const role of roles) {
      expect((role.Properties as { ManagedPolicyArns?: unknown }).ManagedPolicyArns).toBeUndefined();
    }
  });

  it("the invitation identity function: outside the VPC, Cognito create/get on the one pool only, pool id its only setting", () => {
    const fn = Object.values(template.findResources("AWS::Lambda::Function", { Properties: { FunctionName: "Ogevia-prod-IdentityAdmin" } }))[0]!;
    const props = fn.Properties as Record<string, any>;
    expect(props.VpcConfig).toBeUndefined();
    expect(props.Environment.Variables).toEqual({ COGNITO_USER_POOL_ID: existing.cognitoUserPoolId });
    const [policy] = Object.values(template.findResources("AWS::IAM::ManagedPolicy", { Properties: { Description: "Ogevia identity function: own logs + AdminCreateUser/AdminGetUser on the one user pool" } }));
    const statements = (policy!.Properties as any).PolicyDocument.Statement as Array<{ Sid: string; Action: unknown; Resource: unknown }>;
    expect(statements.map((st) => st.Sid).sort()).toEqual(["CreateCaregiverSignIns", "SwitchSignInsOnOff", "WriteOwnLogGroup"]);
    const cognito = statements.find((st) => st.Sid === "CreateCaregiverSignIns")!;
    expect(cognito.Action).toEqual(["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"]);
    expect(cognito.Resource).toBe(`arn:aws:cognito-idp:us-west-2:${OGEVIA_ACCOUNT}:userpool/${existing.cognitoUserPoolId}`);
    // 0048: exactly two more actions (switch a sign-in off / on), on the same single pool ARN, and nothing broader.
    const onOff = statements.find((st) => st.Sid === "SwitchSignInsOnOff")!;
    expect(onOff.Action).toEqual(["cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser"]);
    expect(onOff.Resource).toBe(`arn:aws:cognito-idp:us-west-2:${OGEVIA_ACCOUNT}:userpool/${existing.cognitoUserPoolId}`);
    const allActions = statements.flatMap((st) => ([] as string[]).concat(st.Action as string[]));
    expect(allActions.filter((a) => a.startsWith("cognito-idp:")).sort()).toEqual([
      "cognito-idp:AdminCreateUser", "cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser", "cognito-idp:AdminGetUser",
    ]);
    expect(JSON.stringify(statements)).not.toMatch(/AdminSetUserPassword|AdminAddUserToGroup|AdminUpdateUserAttributes|AdminDeleteUser|cognito-idp:\*|secretsmanager|s3:|kms:/);
    const api = Object.values(template.findResources("AWS::IAM::ManagedPolicy", { Properties: { Description: "Ogevia Service Verification API handler permissions" } }))[0]!;
    const invoke = ((api.Properties as any).PolicyDocument.Statement as Array<{ Sid: string; Action: unknown; Resource: unknown }>).find((st) => st.Sid === "InvokeIdentityAdmin")!;
    expect(invoke.Action).toBe("lambda:InvokeFunction");
    expect(JSON.stringify(invoke.Resource)).toContain("IdentityHandler");
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

describe("Lambda invoke permission (policy-size fix, 2026-10-04)", () => {
  const t = Template.fromStack(buildOgeviaApp(newApp(), ENVIRONMENTS.prod, "plan").find((s) => s.stack.stackName.endsWith("-ServiceVerificationApi"))!.stack);
  const perms = Object.values(t.findResources("AWS::Lambda::Permission"));
  it("exactly two permissions: API Gateway (limited to this API) and the one compliance rule (limited to that rule)", () => {
    expect(perms).toHaveLength(2);
    const gw = perms.map((x) => x.Properties as Record<string, any>).find((p) => p.Principal === "apigateway.amazonaws.com")!;
    expect(gw.Action).toBe("lambda:InvokeFunction");
    const arn = JSON.stringify(gw.SourceArn);
    expect(arn).toContain("arn:");
    expect(arn).toContain(":execute-api:us-west-2:300094796789:");
    expect(arn).toMatch(/"Ref":"Api[0-9A-F]{8}"/);
    expect(arn).toContain("/*/*/*");
    const ev = perms.map((x) => x.Properties as Record<string, any>).find((p) => p.Principal === "events.amazonaws.com")!;
    expect(ev.Action).toBe("lambda:InvokeFunction");
    expect(JSON.stringify(ev.SourceArn)).toMatch(/"Fn::GetAtt":\["ComplianceSweep[0-9A-F]+","Arn"\]/);
  });
  it("the compliance run: one rule, every 15 minutes, the same handler, a constant payload with no identity, retried once", () => {
    t.resourceCountIs("AWS::Events::Rule", 1);
    const rule = Object.values(t.findResources("AWS::Events::Rule"))[0]!.Properties as Record<string, any>;
    expect(rule.ScheduleExpression).toBe("rate(15 minutes)");
    expect(rule.State).toBe("ENABLED");
    expect(rule.Targets).toHaveLength(1);
    expect(JSON.parse(rule.Targets[0].Input)).toEqual({ "ogevia-task": "compliance-sweep" });
    expect(rule.Targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: 1 });
    expect(rule.Targets[0].DeadLetterConfig).toBeUndefined();
    expect(JSON.stringify(rule.Targets[0].Arn)).toMatch(/Handler/);
  });
  it("route authentication is unchanged: every non-public route still uses the JWT authorizer", () => {
    const routes = Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map((r) => r.Properties as Record<string, any>);
    const pub = routes.filter((r) => (r.AuthorizationType ?? "NONE") === "NONE").map((r) => r.RouteKey).sort();
    expect(pub).toEqual([...APPROVED_PUBLIC_ROUTE_KEYS].sort());
    for (const r of routes.filter((x) => x.AuthorizationType !== "NONE" && x.AuthorizationType !== undefined)) {
      expect(r.AuthorizationType).toBe("JWT");
      expect(r.AuthorizerId).toBeDefined();
    }
  });
  it("worst-case resource-policy size stays far below 20 KB, also during a transition from per-route permissions", () => {
    // During the update CloudFormation creates the new permission before it deletes the
    // per-route ones, so the policy briefly holds both. 60 statements of about 345 bytes
    // reached 20,624 bytes; the transition from the pilot holds 38 + 1.
    const perStatement = 345;
    expect((38 + perms.length) * perStatement).toBeLessThan(20480 * 0.7);
  });
});
