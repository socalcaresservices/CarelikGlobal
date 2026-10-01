import { AuthError } from "../errors";

/**
 * Browser-safe Cognito configuration. Every value here is public by design
 * (OAuth public client): no client secret, no AWS credentials.
 */
export interface CognitoAuthConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
  /** Managed login (hosted UI) base URL, https://<prefix>.auth.<region>.amazoncognito.com */
  readonly domain: string;
  readonly redirectUri: string;
  readonly logoutUri: string;
  readonly scopes: readonly string[];
  /** Where refresh tokens live between page loads. See PHASE_3_AUTH_ARCHITECTURE.md. */
  readonly refreshTokenPersistence: "memory" | "session";
}

export interface CognitoEnv {
  readonly VITE_COGNITO_REGION?: string;
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  readonly VITE_COGNITO_DOMAIN?: string;
  readonly VITE_COGNITO_REDIRECT_URI?: string;
  readonly VITE_COGNITO_LOGOUT_URI?: string;
  readonly VITE_COGNITO_SCOPES?: string;
  readonly VITE_COGNITO_REFRESH_PERSISTENCE?: string;
}

const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const USER_POOL_ID = /^([a-z]{2}-[a-z]+-\d)_[A-Za-z0-9]{9}$/;
const CLIENT_ID = /^[a-z0-9]{26}$/;
const DOMAIN = /^https:\/\/[a-z0-9-]+\.auth\.([a-z]{2}-[a-z]+-\d)\.amazoncognito\.com$|^https:\/\/[a-z0-9.-]+$/;
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//;

function requireValue(env: CognitoEnv, key: keyof CognitoEnv): string {
  const value = env[key]?.trim();
  if (!value) throw new AuthError("config_invalid", `Missing ${key} for Cognito authentication`);
  return value;
}

/** Redirects must be https (or http on localhost for development) and absolute. */
function assertRedirect(key: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError("config_invalid", `${key} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && !LOCALHOST.test(value)) {
    throw new AuthError("config_invalid", `${key} must use https (http only for localhost)`);
  }
  if (url.hash || url.username || url.password) {
    throw new AuthError("config_invalid", `${key} must not contain a fragment or credentials`);
  }
}

/** Fails closed: any missing or malformed value throws AuthError("config_invalid"). */
export function parseCognitoConfig(env: CognitoEnv): CognitoAuthConfig {
  const region = requireValue(env, "VITE_COGNITO_REGION");
  const userPoolId = requireValue(env, "VITE_COGNITO_USER_POOL_ID");
  const clientId = requireValue(env, "VITE_COGNITO_CLIENT_ID");
  const domain = requireValue(env, "VITE_COGNITO_DOMAIN").replace(/\/+$/, "");
  const redirectUri = requireValue(env, "VITE_COGNITO_REDIRECT_URI");
  const logoutUri = requireValue(env, "VITE_COGNITO_LOGOUT_URI");

  if (!REGION.test(region)) throw new AuthError("config_invalid", "VITE_COGNITO_REGION is not an AWS region");
  const poolMatch = USER_POOL_ID.exec(userPoolId);
  if (!poolMatch) throw new AuthError("config_invalid", "VITE_COGNITO_USER_POOL_ID is malformed");
  if (poolMatch[1] !== region) {
    throw new AuthError("config_invalid", "VITE_COGNITO_USER_POOL_ID is not in VITE_COGNITO_REGION");
  }
  if (!CLIENT_ID.test(clientId)) throw new AuthError("config_invalid", "VITE_COGNITO_CLIENT_ID is malformed");
  if (!DOMAIN.test(domain)) throw new AuthError("config_invalid", "VITE_COGNITO_DOMAIN must be an https origin");
  assertRedirect("VITE_COGNITO_REDIRECT_URI", redirectUri);
  assertRedirect("VITE_COGNITO_LOGOUT_URI", logoutUri);

  const scopes = (env.VITE_COGNITO_SCOPES ?? "openid email").split(/\s+/).filter(Boolean);
  if (!scopes.includes("openid")) throw new AuthError("config_invalid", "VITE_COGNITO_SCOPES must include openid");

  const persistence = env.VITE_COGNITO_REFRESH_PERSISTENCE ?? "session";
  if (persistence !== "memory" && persistence !== "session") {
    throw new AuthError("config_invalid", "VITE_COGNITO_REFRESH_PERSISTENCE must be memory or session");
  }

  return { region, userPoolId, clientId, domain, redirectUri, logoutUri, scopes, refreshTokenPersistence: persistence };
}

export function cognitoIssuer(config: Pick<CognitoAuthConfig, "region" | "userPoolId">): string {
  return `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
}
