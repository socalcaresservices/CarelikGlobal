import { CfnOutput, RemovalPolicy, Stack, Token, Validations, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Duration } from "aws-cdk-lib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Construct } from "constructs";
import { assertCognitoTemplate, renderInvitationEmail } from "./invitation-email.js";
import { assertAuthConfig, type OgeviaEnvironmentConfig, customOriginsFor } from "./config.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CUSTOM_MESSAGE_ENTRY = resolve(REPO_ROOT, "apps/sv-api/src/custom-message-index.ts");

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

    // Branded invitation (OFF unless config.auth.invitationEmail is set): the pool then carries the rendered message and, optionally, an SES sender.
    const invite = config.auth.invitationEmail;
    let inviteMessage: { emailSubject: string; emailMessage: string } | undefined;
    if (invite) {
      const rendered = renderInvitationEmail({ companyName: invite.companyName, signInUrl: Token.isUnresolved(webOrigin) ? "https://app.ogevia.com" : webOrigin, ...(invite.logoUrl ? { logoUrl: invite.logoUrl } : {}), ...(invite.accentColor ? { accentColor: invite.accentColor } : {}), ...(invite.supportEmail ? { supportEmail: invite.supportEmail } : {}) });
      assertCognitoTemplate(rendered);
      inviteMessage = { emailSubject: rendered.subject, emailMessage: rendered.html };
      if (invite.sender && !/^arn:aws:ses:[a-z0-9-]+:\d{12}:identity\/.+$/.test(invite.sender.sesIdentityArn)) throw new Error("invitation email: sender.sesIdentityArn must be an SES identity ARN");
    }
    // Release Train 2 (priority B): Cognito custom-message trigger (branded invitation, branded password reset, per-office look from ClientMetadata). Created only when the
    // environment sets auth.invitationEmail. Pure function: no VPC, no database, no secrets; its role can only write its own logs. It fails open (Cognito's own message).
    let customMessage: lambda.Function | undefined;
    if (invite) {
      const cmLogs = new logs.LogGroup(this, "CustomMessageLogGroup", { retention: config.logRetention, removalPolicy: RemovalPolicy.RETAIN });
      const cmRole = new iam.Role(this, "CustomMessageRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), description: "Ogevia Cognito custom-message trigger (logs only)" });
      const cmPolicy = new iam.ManagedPolicy(this, "CustomMessagePolicy", { description: "Ogevia custom-message trigger: own logs only", roles: [cmRole] });
      cmPolicy.addStatements(new iam.PolicyStatement({ sid: "WriteOwnLogGroup", actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [cmLogs.logGroupArn] }));
      customMessage = new nodejs.NodejsFunction(this, "CustomMessageHandler", {
        description: "Ogevia Cognito custom message: branded invitation and password reset",
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        entry: CUSTOM_MESSAGE_ENTRY,
        handler: "handler",
        projectRoot: REPO_ROOT,
        depsLockFilePath: resolve(REPO_ROOT, "pnpm-lock.yaml"),
        bundling: { format: nodejs.OutputFormat.CJS, target: "node22", minify: true, sourceMap: false, forceDockerBundling: false },
        memorySize: 128,
        timeout: Duration.seconds(3),   // Cognito allows 5 s for a trigger
        role: cmRole,
        logGroup: cmLogs,
        environment: {
          BRAND_COMPANY: invite.companyName, SIGN_IN_URL: Token.isUnresolved(webOrigin) ? "https://app.ogevia.com" : webOrigin,
          ...(invite.logoUrl ? { BRAND_LOGO_URL: invite.logoUrl } : {}), ...(invite.accentColor ? { BRAND_ACCENT: invite.accentColor } : {}), ...(invite.supportEmail ? { BRAND_SUPPORT_EMAIL: invite.supportEmail } : {}),
        },
      });
      customMessage.node.addDependency(cmPolicy);
      Validations.of(customMessage).acknowledge({ id: "HIPAA.Security-LambdaInsideVPC", reason: "A pure template function: no database, S3, KMS or secret access and no network use. Cognito invokes it directly; it fails open." });
    }
    this.userPool = new cognito.CfnUserPool(this, "UserPool", {
      userPoolName: `ogevia-${config.envName}`,
      deletionProtection: "ACTIVE",
      userPoolTier: "ESSENTIALS",
      usernameAttributes: ["email"],
      autoVerifiedAttributes: ["email"],
      mfaConfiguration: "ON",
      enabledMfas: ["SOFTWARE_TOKEN_MFA"],
      adminCreateUserConfig: { allowAdminCreateUserOnly: true, ...(inviteMessage ? { inviteMessageTemplate: inviteMessage } : {}) },
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
      ...(customMessage ? { lambdaConfig: { customMessage: customMessage.functionArn } } : {}),
      accountRecoverySetting: { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] },
      emailConfiguration: invite?.sender ? { emailSendingAccount: "DEVELOPER", from: invite.sender.from, sourceArn: invite.sender.sesIdentityArn } : { emailSendingAccount: "COGNITO_DEFAULT" },
      schema: [{ name: "email", attributeDataType: "String", required: true, mutable: true }],
      userAttributeUpdateSettings: { attributesRequireVerificationBeforeUpdate: ["email"] },
    });
    // Retain on stack deletion AND on replacement (a replaced pool would lose every user).
    this.userPool.applyRemovalPolicy(RemovalPolicy.RETAIN);
    if (customMessage) {
      new lambda.CfnPermission(this, "CustomMessageInvoke", { action: "lambda:InvokeFunction", functionName: customMessage.functionName, principal: "cognito-idp.amazonaws.com", sourceArn: this.userPool.attrArn });
    }

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
      callbackUrLs: [`${webOrigin}/auth/callback`, ...customOriginsFor(config).map((o) => `${o}/auth/callback`)],
      logoutUrLs: [`${webOrigin}/`, ...customOriginsFor(config).map((o) => `${o}/`)],
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
