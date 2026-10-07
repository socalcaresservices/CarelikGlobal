import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { OgeviaConfig } from "./config.js";

export const OGEVIA_GROUPS = ["platform_admin", "org_admin", "manager", "caregiver"] as const;

export interface AuthStackProps extends StackProps {
  /** Frontend origins (Netlify) allowed as OAuth redirect targets. */
  callbackUrls: string[];
}

/**
 * Individual identities only: admin-created users, no self sign-up.
 * Groups are coarse role hints; tenant (organization_id) and effective role are
 * resolved server-side from the database, never trusted from the token.
 */
export class AuthStack extends Stack {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, cfg: OgeviaConfig, props: AuthStackProps) {
    super(scope, id, props);
    this.userPool = new cognito.UserPool(this, "Pool", {
      userPoolName: `ogevia-${cfg.stage}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    });
    for (const g of OGEVIA_GROUPS) {
      new cognito.CfnUserPoolGroup(this, `Group-${g}`, { userPoolId: this.userPool.userPoolId, groupName: g });
    }
    this.client = this.userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: props.callbackUrls,
        logoutUrls: props.callbackUrls,
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });
  }
}
