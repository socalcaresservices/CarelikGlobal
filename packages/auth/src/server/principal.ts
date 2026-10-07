/**
 * Server-side identity contract (Phase 4 Lambda).
 *
 * API Gateway's JWT authorizer verifies the Cognito ACCESS token signature,
 * issuer, audience/client_id, and expiry before Lambda runs. Lambda then
 * builds an AuthenticatedPrincipal from the verified claims and re-checks
 * them here (defense in depth, and so the boundary is unit-testable).
 *
 * The principal deliberately carries NO organization, role, group, email, or
 * caregiver id: those are resolved in PostgreSQL from `sub`
 * (ogevia_api.begin_request -> app_users -> organization_memberships).
 */
export interface AuthenticatedPrincipal {
  readonly sub: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly tokenUse: "access";
  readonly scopes: readonly string[];
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export interface PrincipalExpectations {
  readonly issuer: string;
  /** Approved app clients. Tokens for any other client are rejected. */
  readonly clientIds: readonly string[];
  /** Scopes every request must carry (default: openid). */
  readonly requiredScopes?: readonly string[];
  /** Allowed clock skew in seconds (default 0; API Gateway already checked exp). */
  readonly clockSkewSeconds?: number;
}

export type PrincipalRejection =
  | "missing_claims"
  | "missing_sub"
  | "malformed_sub"
  | "wrong_issuer"
  | "wrong_client"
  | "wrong_token_use"
  | "expired"
  | "missing_scope"
  | "malformed_claims";

export class PrincipalError extends Error {
  readonly reason: PrincipalRejection;
  constructor(reason: PrincipalRejection) {
    // The message never echoes claim values.
    super(`Access token rejected: ${reason}`);
    this.name = "PrincipalError";
    this.reason = reason;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // API Gateway passes JWT claims to Lambda as strings.
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function scopesOf(value: unknown): string[] | null {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value) && value.every((s) => typeof s === "string")) return value as string[];
  // API Gateway renders array claims as "[a b]".
  return null;
}

/** Builds the principal from VERIFIED claims, or throws PrincipalError. */
export function principalFromClaims(
  claims: Record<string, unknown> | null | undefined,
  expected: PrincipalExpectations,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AuthenticatedPrincipal {
  if (!claims || typeof claims !== "object") throw new PrincipalError("missing_claims");
  const { sub, iss, client_id: clientId, token_use: tokenUse } = claims;
  if (sub === undefined || sub === null || sub === "") throw new PrincipalError("missing_sub");
  if (typeof sub !== "string" || !UUID.test(sub)) throw new PrincipalError("malformed_sub");
  if (typeof iss !== "string" || iss !== expected.issuer) throw new PrincipalError("wrong_issuer");
  if (tokenUse !== "access") throw new PrincipalError("wrong_token_use");
  if (typeof clientId !== "string" || !expected.clientIds.includes(clientId)) {
    throw new PrincipalError("wrong_client");
  }
  const exp = numeric(claims.exp);
  if (exp === null) throw new PrincipalError("malformed_claims");
  if (exp + (expected.clockSkewSeconds ?? 0) <= nowSeconds) throw new PrincipalError("expired");
  const scopes = scopesOf(claims.scope);
  if (scopes === null) throw new PrincipalError("malformed_claims");
  for (const required of expected.requiredScopes ?? ["openid"]) {
    if (!scopes.includes(required)) throw new PrincipalError("missing_scope");
  }
  return { sub, issuer: iss, clientId, tokenUse: "access", scopes, expiresAt: exp };
}

/**
 * Reads claims from an API Gateway HTTP API (payload v2) event:
 * event.requestContext.authorizer.jwt.claims. Returns null when absent.
 */
export function claimsFromHttpApiEvent(event: unknown): Record<string, unknown> | null {
  const claims = (event as { requestContext?: { authorizer?: { jwt?: { claims?: unknown } } } } | null)
    ?.requestContext?.authorizer?.jwt?.claims;
  return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
}
