/**
 * Phase 3: current vs target settings for the EXISTING Cognito pool and the
 * EXISTING `ogevia-web` app client. This is a MODEL ONLY. Nothing here is
 * deployed: the existing client is not CloudFormation-managed, and changing
 * it is a YELLOW action for the production auth cutover (D-P1-2).
 *
 * CURRENT values are VERIFIED read-only (describe-user-pool,
 * describe-user-pool-client, describe-user-pool-domain) on 2026-10-01.
 */
export interface ClientSettings {
  readonly callbackUrls: readonly string[];
  readonly logoutUrls: readonly string[];
  readonly oauthFlows: readonly string[];
  readonly oauthScopes: readonly string[];
  readonly explicitAuthFlows: readonly string[];
  readonly generateSecret: boolean;
  readonly preventUserExistenceErrors: "ENABLED" | "LEGACY";
  readonly enableTokenRevocation: boolean;
  readonly accessTokenMinutes: number;
  readonly idTokenMinutes: number;
  readonly refreshTokenMinutes: number;
}

export const OGEVIA_WEB_CLIENT_ID = "1i27abbina08fvg1i9u8vprgo9";

export const OGEVIA_WEB_CURRENT: ClientSettings = {
  // D-P1-2: a CloudFront domain this account does not own (VERIFIED: no distribution in the account).
  callbackUrls: ["https://d84l1y8p4kdic.cloudfront.net"],
  logoutUrls: [],
  oauthFlows: ["code"],
  oauthScopes: ["email", "openid"],
  explicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_AUTH", "ALLOW_USER_SRP_AUTH"],
  generateSecret: false,
  preventUserExistenceErrors: "ENABLED",
  enableTokenRevocation: true,
  accessTokenMinutes: 60,
  idTokenMinutes: 60,
  refreshTokenMinutes: 5 * 24 * 60,
};

export const OGEVIA_WEB_TARGET: ClientSettings = {
  callbackUrls: ["https://app.ogevia.com/auth/callback"],
  logoutUrls: ["https://app.ogevia.com/"],
  oauthFlows: ["code"],
  oauthScopes: ["email", "openid"],
  // Managed login handles sign-in; the browser never posts a password to the app.
  explicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
  generateSecret: false,
  preventUserExistenceErrors: "ENABLED",
  enableTokenRevocation: true,
  accessTokenMinutes: 60,
  idTokenMinutes: 60,
  // A caregiver shift fits; shorter than today's 5 days to limit a stolen refresh token.
  refreshTokenMinutes: 12 * 60,
};

export interface SettingChange {
  readonly setting: keyof ClientSettings;
  readonly current: unknown;
  readonly target: unknown;
}

export function clientChanges(current: ClientSettings, target: ClientSettings): SettingChange[] {
  const norm = (v: unknown) => (Array.isArray(v) ? [...v].sort() : v);
  return (Object.keys(target) as Array<keyof ClientSettings>)
    .filter((k) => JSON.stringify(norm(current[k])) !== JSON.stringify(norm(target[k])))
    .map((k) => ({ setting: k, current: current[k], target: target[k] }));
}
