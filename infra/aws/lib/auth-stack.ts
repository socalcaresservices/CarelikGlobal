import { CfnOutput, RemovalPolicy, Stack, Token, Validations, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import { assertAuthConfig, type OgeviaEnvironmentConfig } from "./config.js";

export interface ProductionAuthStackProps extends StackProps {
  readonly config: OgeviaEnvironmentConfig;
  /** The production web origin (https://<distribution>.cloudfront.net): the only place the sign-in may return to. */
  readonly webOrigin: string;
}

/**
 * PRODUCTION'S OWN sign-in: a dedicated Cognito user pool, its managed-login domain and ONE public app client (code + PKCE).
 * Settings copy the shared pilot pool as read live on 2026-10-21 (MFA ON with an authenticator app only, admin-create-only, 12-character
 * passwords with history 5, email as username, Essentials tier, deletion protection ACTIVE, Cognito-default email). Nothing here is
 * shared with the pilot/test slice, whose pool is left unchanged (its identifier lives only in config.ts).
 *
 * Roles, tenants and permissions stay in PostgreSQL (no groups, no custom attributes). The pool is RETAINED when this stack is deleted:
 * losing it would sign every production user out with no backup of the pool (docs/aws/CONTINUITY_AND_RECOVERY.md).
 *
 * Settings that CANNOT be changed after the pool exists: email as the username and the standard `email` attribute. They are final here.
 */
export class ProductionAuthStack extends Stack {
  public readonly userPool: cognito.CfnUserPool;
  public readonly userPoolDomain: cognito.CfnUserPoolDomain;
  public readonly appClient: cognito.CfnUserPoolClient;
  /** Tokens until deploy time; use only as CloudFormation references. */
  public readonly userPoolId: string;
  public readonly userPoolArn: string;
  public readonly appClientId: string;

  constructor(scope: Construct, id: string, props: ProductionAuthStackProps) {
    super(scope, id, { ...props, terminationProtection: props.config.terminationProtection });
    const { config, webOrigin } = props;
    assertAuthConfig(config);
    const dedicated = config.auth.dedicatedUserPool;
    if (!dedicated) throw new Error(`env "${config.envName}" has no dedicated user pool; ProductionAuthStack must not be created for it`);
    // A real deployment passes a CloudFormation token; a literal must be a bare https origin (no path, no http).
    if (!Token.isUnresolved(webOrigin) && !/^https:\/\/[a-z0-9.-]+$/i.test(webOrigin)) {
      throw new Error("The production web origin must be a bare https origin");
    }

    this.userPool = new cognito.CfnUserPool(this, "UserPool", {
      userPoolName: `ogevia-${config.envName}`,
      deletionProtection: "ACTIVE",
      userPoolTier: "ESSENTIALS",
      usernameAttributes: ["email"],
      autoVerifiedAttributes: ["email"],
      mfaConfiguration: "ON",
      enabledMfas: ["SOFTWARE_TOKEN_MFA"],
      adminCreateUserConfig: { allowAdminCreateUserOnly: true },
      policies: {
        passwordPolicy: {
          minimumLength: 12,
          requireUppercase: true,
          requireLowercase: true,
          requireNumbers: true,
          requireSymbols: true,
          passwordHistorySize: 5,
          temporaryPasswordValidityDays: 7,
        },
        signInPolicy: { allowedFirstAuthFactors: ["PASSWORD"] },
      },
      accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] },
      emailConfiguration: { emailSendingAccount: "COGNITO_DEFAULT" },
      schema: [{ name: "email", attributeDataType: "String", required: true, mutable: true }],
      userAttributeUpdateSettings: { attributesRequireVerificationBeforeUpdate: ["email"] },
    });
    // Retain on stack deletion AND on replacement (a replaced pool would lose every user).
    this.userPool.applyRemovalPolicy(RemovalPolicy.RETAIN);

    this.userPoolDomain = new cognito.CfnUserPoolDomain(this, "UserPoolDomain", {
      domain: dedicated.domainPrefix,
      userPoolId: this.userPool.ref,
      managedLoginVersion: 2,
    });

    this.appClient = new cognito.CfnUserPoolClient(this, "WebClient", {
      userPoolId: this.userPool.ref,
      clientName: `ogevia-web-${config.envName}`,
      generateSecret: false,
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthFlows: ["code"],
      allowedOAuthScopes: ["openid", "email"],
      supportedIdentityProviders: ["COGNITO"],
      callbackUrLs: [`${webOrigin}/auth/callback`],
      logoutUrLs: [`${webOrigin}/`],
      explicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
      preventUserExistenceErrors: "ENABLED",
      enableTokenRevocation: true,
      accessTokenValidity: 60,
      idTokenValidity: 60,
      refreshTokenValidity: 12,
      authSessionValidity: 3,
      tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "hours" },
    });

    const branding = new cognito.CfnManagedLoginBranding(this, "ManagedLogin", {
      userPoolId: this.userPool.ref,
      clientId: this.appClient.ref,
      useCognitoProvidedValues: true,
    });
    branding.addDependency(this.userPoolDomain);

    this.userPoolId = this.userPool.ref;
    this.userPoolArn = this.userPool.attrArn;
    this.appClientId = this.appClient.ref;

    new CfnOutput(this, "UserPoolId", { value: this.userPoolId });
    new CfnOutput(this, "UserPoolArn", { value: this.userPoolArn });
    new CfnOutput(this, "AppClientId", { value: this.appClientId });
    new CfnOutput(this, "ManagedLoginDomain", { value: `https://${dedicated.domainPrefix}.auth.${config.region}.amazoncognito.com` });

    // Same sign-in controls as the shared pool; the items below are the ones the pilot also accepts.
    for (const ack of [
      {
        id: "AwsSolutions-COG3",
        reason:
          "Advanced security (threat protection) is a paid Plus-tier feature; the owner has not approved that cost. MFA is ON and self sign-up is disabled, as on the shared pool.",
      },
    ]) {
      Validations.of(this.userPool).acknowledge(ack);
    }
  }
}
