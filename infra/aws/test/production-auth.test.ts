import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp, type PlannedStack } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { newApp } from "./helpers.js";

// Production's OWN sign-in. Everything here is CloudFormation-template evidence from the code that `cdk synth` emits; nothing contacts AWS.
const SHARED_POOL = ENVIRONMENTS.prod.existing.cognitoUserPoolId;
const LEGACY_CLIENT = ENVIRONMENTS.prod.auth.appClientId;
const prd = buildOgeviaApp(newApp(), ENVIRONMENTS.prd, "plan");
const prod = buildOgeviaApp(newApp(), ENVIRONMENTS.prod, "plan");
const by = (list: PlannedStack[], suffix: string) => Template.fromStack(list.find((p) => p.stack.stackName.endsWith(suffix))!.stack);
const json = (t: Template) => JSON.stringify(t.toJSON());
const only = (t: Template, type: string) => Object.values(t.findResources(type));
/** The role policies are managed policies in this stack; accept both kinds so the test follows the template, not a construct choice. */
const policyStatements = (t: Template): any[] => [...only(t, "AWS::IAM::Policy"), ...only(t, "AWS::IAM::ManagedPolicy")].flatMap((p) => (p.Properties as any).PolicyDocument.Statement as any[]);
const lambdaByDescription = (t: Template, description: string) => only(t, "AWS::Lambda::Function").find((r) => (r.Properties as { Description?: string }).Description === description)!;

describe("production's dedicated Cognito pool (Ogevia-prd-Auth)", () => {
  const auth = by(prd, "-Auth");
  const [pool] = only(auth, "AWS::Cognito::UserPool");

  it("is exactly one pool, one domain, one client and one managed-login branding", () => {
    for (const type of ["AWS::Cognito::UserPool", "AWS::Cognito::UserPoolDomain", "AWS::Cognito::UserPoolClient", "AWS::Cognito::ManagedLoginBranding"]) {
      auth.resourceCountIs(type, 1);
    }
  });

  it("matches the shared pool's security settings (read live 2026-10-21): MFA ON with an authenticator app only, no self sign-up, strong passwords", () => {
    auth.hasResourceProperties("AWS::Cognito::UserPool", {
      UserPoolName: "ogevia-prd",
      DeletionProtection: "ACTIVE",
      UserPoolTier: "ESSENTIALS",
      UsernameAttributes: ["email"],
      AutoVerifiedAttributes: ["email"],
      MfaConfiguration: "ON",
      EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      EmailConfiguration: { EmailSendingAccount: "COGNITO_DEFAULT" },
    });
    expect((pool!.Properties as any).Policies).toEqual({
      PasswordPolicy: { MinimumLength: 12, RequireUppercase: true, RequireLowercase: true, RequireNumbers: true, RequireSymbols: true, PasswordHistorySize: 5, TemporaryPasswordValidityDays: 7 },
      SignInPolicy: { AllowedFirstAuthFactors: ["PASSWORD"] },
    });
    // No SMS, no triggers, no threat-protection add-ons: only the properties listed above are set on the pool.
    expect(Object.keys(pool!.Properties as object).sort()).toEqual([
      "AccountRecoverySetting", "AdminCreateUserConfig", "AutoVerifiedAttributes", "DeletionProtection", "EmailConfiguration", "EnabledMfas",
      "MfaConfiguration", "Policies", "Schema", "UserAttributeUpdateSettings", "UserPoolName", "UserPoolTags", "UserPoolTier", "UsernameAttributes",
    ]);
  });

  it("is RETAINED on stack deletion and on replacement (losing it would sign every production user out)", () => {
    expect(pool!.DeletionPolicy).toBe("Retain");
    expect(pool!.UpdateReplacePolicy).toBe("Retain");
    expect(prd.find((p) => p.stack.stackName.endsWith("-Auth"))!.stack.terminationProtection).toBe(true);
  });

  it("has its own managed-login domain, different from the shared pool's", () => {
    auth.hasResourceProperties("AWS::Cognito::UserPoolDomain", { Domain: ENVIRONMENTS.prd.auth.dedicatedUserPool!.domainPrefix, ManagedLoginVersion: 2 });
    expect(json(auth)).not.toContain("us-west-2849ayz5j7");
  });

  it("has one public client (code + PKCE, no secret) that returns only to the production web origin", () => {
    auth.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ClientName: "ogevia-web-prd",
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "email"],
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
      PreventUserExistenceErrors: "ENABLED",
      EnableTokenRevocation: true,
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 12,
    });
    const [client] = only(auth, "AWS::Cognito::UserPoolClient");
    const p = client!.Properties as { CallbackURLs: unknown[]; LogoutURLs: unknown[] };
    expect(p.CallbackURLs).toHaveLength(1);
    expect(p.LogoutURLs).toHaveLength(1);
    expect(JSON.stringify(p)).not.toMatch(/http:|localhost|app\.ogevia\.com/);
  });

  it("exports the pool id, ARN, client id and sign-in domain for the operator", () => {
    const outputs = Object.keys((auth.toJSON() as any).Outputs);
    for (const name of ["AppClientId", "ManagedLoginDomain", "UserPoolArn", "UserPoolId"]) expect(outputs).toContain(name);
  });
});

describe("production API trusts only production's pool and client", () => {
  const api = by(prd, "-ServiceVerificationApi");
  const authorizer = only(api, "AWS::ApiGatewayV2::Authorizer")[0]!.Properties as { JwtConfiguration: { Issuer: unknown; Audience: unknown[] } };
  const handlerEnv = (lambdaByDescription(api, "Ogevia Service Verification API").Properties as any).Environment.Variables as Record<string, unknown>;
  const identity = only(api, "AWS::Lambda::Function").find((r) => (r.Properties as any).Description?.includes("Cognito create/get/disable/enable"))!;

  it("the JWT authorizer's issuer is the dedicated pool, never the shared one", () => {
    expect(JSON.stringify(authorizer.JwtConfiguration.Issuer)).toContain("Ogevia-prd-Auth");
    expect(JSON.stringify(authorizer.JwtConfiguration.Issuer)).not.toContain(SHARED_POOL);
  });

  it("the audience is exactly ONE client (production's), and neither the legacy client nor the old production client in the shared pool", () => {
    expect(authorizer.JwtConfiguration.Audience).toHaveLength(1);
    const aud = JSON.stringify(authorizer.JwtConfiguration.Audience);
    expect(aud).toContain("Ogevia-prd-Auth");
    expect(aud).not.toContain(LEGACY_CLIENT);
    expect(aud).not.toContain("Ogevia-prd-WebHosting");
  });

  it("the Lambda is configured with the dedicated pool and client, and NAMES the shared pool as forbidden", () => {
    expect(JSON.stringify(handlerEnv.COGNITO_USER_POOL_ID)).toContain("Ogevia-prd-Auth");
    expect(JSON.stringify(handlerEnv.COGNITO_APP_CLIENT_ID)).toContain("Ogevia-prd-Auth");
    expect(JSON.stringify(handlerEnv.COGNITO_APP_CLIENT_ID)).not.toContain(LEGACY_CLIENT);
    expect(handlerEnv.OGEVIA_FORBIDDEN_POOL_IDS).toBe(SHARED_POOL);
    expect(handlerEnv.OGEVIA_ENV).toBe("prd");
    expect(handlerEnv.DB_NAME).toBe("ogevia_prd");
  });

  it("production invitations use the new pool: the identity function and its permissions name only the dedicated pool", () => {
    expect((identity.Properties as any).Environment.Variables).toEqual({ COGNITO_USER_POOL_ID: expect.anything() });
    expect(JSON.stringify((identity.Properties as any).Environment.Variables.COGNITO_USER_POOL_ID)).toContain("Ogevia-prd-Auth");
    const statements = policyStatements(api);
    const cognito = statements.filter((s) => [s.Action].flat().some((a: string) => a.startsWith("cognito-idp:")));
    expect(cognito.map((s) => s.Sid).sort()).toEqual(["CreateCaregiverSignIns", "SwitchSignInsOnOff"]);
    for (const s of cognito) {
      expect(s.Resource).toBeDefined();
      expect(JSON.stringify(s.Resource)).toContain("Ogevia-prd-Auth");
      expect(JSON.stringify(s.Resource)).not.toContain(SHARED_POOL);
    }
    expect([cognito.flatMap((s) => [s.Action].flat())].flat().sort()).toEqual([
      "cognito-idp:AdminCreateUser", "cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser", "cognito-idp:AdminGetUser",
    ]);
  });

  it("the shared pool's id appears nowhere in production's API template except the forbidden-pool setting", () => {
    expect(json(api).split(SHARED_POOL).length - 1).toBe(1);
    expect(json(api).split(LEGACY_CLIENT).length - 1).toBe(0);
  });

  it("every non-public route still requires the authorizer; public routes are unchanged", () => {
    const routes = only(api, "AWS::ApiGatewayV2::Route").map((r) => r.Properties as { AuthorizationType?: string; RouteKey: string });
    const open = routes.filter((r) => r.AuthorizationType !== "JWT");
    expect(open.length).toBe(10);
    for (const r of open) expect(r.RouteKey).toContain("/v1/public/");
    expect(routes.length).toBeGreaterThan(200);
  });
});

describe("the pilot/test environment is left exactly as it is", () => {
  const api = by(prod, "-ServiceVerificationApi");
  const authorizer = only(api, "AWS::ApiGatewayV2::Authorizer")[0]!.Properties as { JwtConfiguration: { Issuer: unknown; Audience: unknown[] } };
  const handlerEnv = (lambdaByDescription(api, "Ogevia Service Verification API").Properties as any).Environment.Variables as Record<string, unknown>;

  it("has no Auth stack", () => {
    expect(prod.map((p) => p.stack.stackName)).not.toContain("Ogevia-prod-Auth");
  });

  it("still trusts the shared pool with the legacy client and its own web client", () => {
    expect(authorizer.JwtConfiguration.Issuer).toContain(SHARED_POOL);
    expect(authorizer.JwtConfiguration.Audience).toHaveLength(2);
    expect(authorizer.JwtConfiguration.Audience[0]).toBe(LEGACY_CLIENT);
    expect(handlerEnv.COGNITO_USER_POOL_ID).toBe(SHARED_POOL);
    expect(handlerEnv).not.toHaveProperty("OGEVIA_FORBIDDEN_POOL_IDS");
  });

  it("its identity function is still scoped to the shared pool's ARN", () => {
    const statements = policyStatements(api);
    const cognito = statements.filter((s) => [s.Action].flat().some((a: string) => a.startsWith("cognito-idp:")));
    expect(cognito.length).toBe(2);
    for (const s of cognito) expect(JSON.stringify(s.Resource)).toContain(SHARED_POOL);
  });
});

describe("production's other stacks do not change", () => {
  it("the web hosting stack for production has no dependency on the new pool and still creates its existing client", () => {
    const web = by(prd, "-WebHosting");
    expect(json(web)).not.toContain("Ogevia-prd-Auth");
    web.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  });
});
