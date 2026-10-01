import { AuthError } from "../errors";
import type { CognitoAuthConfig } from "./config";

/** Raw token endpoint response. Never logged. */
export interface TokenResponse {
  readonly access_token: string;
  readonly id_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly token_type: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function authorizeUrl(
  config: CognitoAuthConfig,
  params: { state: string; codeChallenge: string; nonce: string },
): string {
  const url = new URL(`${config.domain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Managed login's forgot-password entry point; returns to the normal callback. */
export function forgotPasswordUrl(config: CognitoAuthConfig): string {
  const url = new URL(`${config.domain}/forgotPassword`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
  }).toString();
  return url.toString();
}

export function logoutUrl(config: CognitoAuthConfig): string {
  const url = new URL(`${config.domain}/logout`);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUri }).toString();
  return url.toString();
}

async function postForm(fetchImpl: FetchLike, url: string, body: Record<string, string>): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new AuthError("network_error", "Could not reach the sign-in service. Check your connection and try again.");
  }
}

function assertTokenResponse(value: unknown, requireRefresh: boolean): TokenResponse {
  const v = value as Partial<TokenResponse> | null;
  if (
    !v || typeof v.access_token !== "string" || typeof v.id_token !== "string" ||
    typeof v.expires_in !== "number" || v.token_type !== "Bearer" ||
    (requireRefresh && typeof v.refresh_token !== "string")
  ) {
    throw new AuthError("token_exchange_failed", "The sign-in service returned an unexpected response.");
  }
  return v as TokenResponse;
}

export async function exchangeCode(
  fetchImpl: FetchLike,
  config: CognitoAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await postForm(fetchImpl, `${config.domain}/oauth2/token`, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });
  if (!response.ok) {
    throw new AuthError("token_exchange_failed", "Sign-in could not be completed. Please try again.");
  }
  return assertTokenResponse(await response.json(), true);
}

export async function refreshTokens(
  fetchImpl: FetchLike,
  config: CognitoAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await postForm(fetchImpl, `${config.domain}/oauth2/token`, {
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });
  if (!response.ok) {
    throw new AuthError("refresh_failed", "Your session has expired. Please sign in again.");
  }
  return assertTokenResponse(await response.json(), false);
}

/** Best effort: revocation failure must not keep a user signed in locally. */
export async function revokeRefreshToken(
  fetchImpl: FetchLike,
  config: CognitoAuthConfig,
  refreshToken: string,
): Promise<boolean> {
  try {
    const response = await postForm(fetchImpl, `${config.domain}/oauth2/revoke`, {
      token: refreshToken,
      client_id: config.clientId,
    });
    return response.ok;
  } catch {
    return false;
  }
}
