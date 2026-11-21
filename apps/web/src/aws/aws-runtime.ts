import { CognitoAuthClient, parseCognitoConfig, type CognitoEnv } from "@carelik/auth";
import { createAwsApiClient, createAwsPublicApiClient, type AwsApiClient } from "@/lib/aws-api";
import { resolveEnvironmentMarker, type EnvironmentMarker } from "./environment";

export interface AwsRuntime {
  readonly auth: CognitoAuthClient;
  readonly api: AwsApiClient;
  readonly publicApi: AwsApiClient;
  /** From explicit configuration (VITE_APP_ENV); never guessed. */
  readonly environment: EnvironmentMarker;
}

export type AwsEnv = CognitoEnv & { VITE_SV_API_BASE_URL?: string | undefined; VITE_APP_ENV?: string | undefined };

/** Builds the runtime from build-time env. Fails closed on any invalid value. */
export function createAwsRuntime(env: AwsEnv): AwsRuntime {
  const config = parseCognitoConfig(env);
  const baseUrl = env.VITE_SV_API_BASE_URL?.trim();
  if (!baseUrl || !baseUrl.startsWith("https://")) {
    throw new Error("VITE_SV_API_BASE_URL must be the https API URL.");
  }
  const auth = new CognitoAuthClient(config);
  return {
    auth,
    api: createAwsApiClient({ baseUrl, getAccessToken: () => auth.getAccessToken() }),
    publicApi: createAwsPublicApiClient(baseUrl),
    environment: resolveEnvironmentMarker(env.VITE_APP_ENV),
  };
}


/** Keys a deployment may set at runtime through /config.json (identifiers only, never secrets). */
const RUNTIME_KEYS = [
  "VITE_COGNITO_REGION",
  "VITE_COGNITO_USER_POOL_ID",
  "VITE_COGNITO_CLIENT_ID",
  "VITE_COGNITO_DOMAIN",
  "VITE_COGNITO_REDIRECT_URI",
  "VITE_COGNITO_LOGOUT_URI",
  "VITE_COGNITO_SCOPES",
  "VITE_COGNITO_REFRESH_PERSISTENCE",
  "VITE_SV_API_BASE_URL",
  "VITE_APP_ENV", // a label (test | demo | development | production), not an identifier or a secret
] as const;

/**
 * Merges same-origin /config.json (written by the deployment from
 * CloudFormation outputs) over the build-time env, so one build serves any
 * environment. Unknown keys and non-string values are ignored; a missing
 * file falls back to build-time values. Validation stays in createAwsRuntime.
 */
export async function loadRuntimeEnv(buildEnv: AwsEnv, fetchImpl: typeof fetch = fetch): Promise<AwsEnv> {
  let runtime: Record<string, unknown> = {};
  try {
    const response = await fetchImpl("/config.json", { cache: "no-store", credentials: "omit" });
    if (response.ok) runtime = (await response.json()) as Record<string, unknown>;
  } catch {
    runtime = {};
  }
  const merged: Record<string, string | undefined> = { ...(buildEnv as Record<string, string | undefined>) };
  for (const key of RUNTIME_KEYS) {
    const value = runtime[key];
    if (typeof value === "string" && value.trim()) merged[key] = value.trim();
  }
  return merged as AwsEnv;
}
