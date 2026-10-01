// Phase 3 authentication contract, modeled in Phase 1 so the API stack and the
// future Cognito work agree on one boundary. Nothing here creates or modifies a
// Cognito resource; the existing user pool is only referenced.

/**
 * Ogevia roles, mirrored from `public.system_role` in the Supabase schema
 * (platform_foundation + add_caregiver_role + add_scheduler_system_role).
 */
export const OGEVIA_SYSTEM_ROLES = [
  "platform_owner",
  "organization_owner",
  "organization_admin",
  "manager",
  "scheduler",
  "coordinator",
  "staff",
  "caregiver",
  "read_only",
] as const;
export type OgeviaSystemRole = (typeof OGEVIA_SYSTEM_ROLES)[number];

/**
 * Server-side authorization boundary.
 *
 * API Gateway's JWT authorizer proves only that the caller holds a valid,
 * unexpired Cognito access token issued by the Ogevia pool for the Ogevia app
 * client. It does NOT decide tenant or role access:
 * - Organization membership and role are resolved in PostgreSQL from the
 *   token's `sub` (users.cognito_sub -> organization_memberships), per
 *   request, inside the Lambda.
 * - `organization_id`, role, timestamps, amounts, and authorization status are
 *   never accepted from the request body as trusted input.
 * - Cognito groups, if used later, are a coarse convenience only. A user can
 *   belong to several organizations with different roles, which a flat group
 *   list cannot express, so groups never replace the database check.
 */
export const AUTHORIZATION_BOUNDARY = {
  trustedTokenClaims: ["sub", "token_use", "client_id", "iss", "exp"] as const,
  requiredTokenUse: "access",
  tenantResolution: "database:organization_memberships by cognito sub",
  roleResolution: "database:organization_memberships.role",
} as const;

/**
 * Requirements for the SPA app client used by the React frontend. Phase 3
 * creates or adopts a client that satisfies these; Phase 1 does not create one.
 */
export const APP_CLIENT_REQUIREMENTS = {
  generateSecret: false, // public browser client; a secret cannot be kept there
  authFlows: ["authorization_code_with_pkce", "refresh_token"],
  prohibitedFlows: ["implicit", "USER_PASSWORD_AUTH"],
  accessTokenValidityMinutes: 60,
  idTokenValidityMinutes: 60,
  refreshTokenValidityDays: 30,
  preventUserExistenceErrors: true,
  enableTokenRevocation: true,
  oauthScopes: ["openid", "email"],
} as const;

/** The issuer URL API Gateway uses to validate Cognito JWTs. */
export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}
