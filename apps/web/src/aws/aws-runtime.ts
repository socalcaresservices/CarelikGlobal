import { CognitoAuthClient, parseCognitoConfig, type CognitoEnv } from "@carelik/auth";
import { createAwsApiClient, type AwsApiClient } from "@/lib/aws-api";

export interface AwsRuntime {
  readonly auth: CognitoAuthClient;
  readonly api: AwsApiClient;
}

export type AwsEnv = CognitoEnv & { VITE_SV_API_BASE_URL?: string | undefined };

/** Builds the runtime from build-time env. Fails closed on any invalid value. */
export function createAwsRuntime(env: AwsEnv): AwsRuntime {
  const config = parseCognitoConfig(env);
  const baseUrl = env.VITE_SV_API_BASE_URL?.trim();
  if (!baseUrl || !baseUrl.startsWith("https://")) {
    throw new Error("VITE_SV_API_BASE_URL must be the https API URL.");
  }
  const auth = new CognitoAuthClient(config);
  return { auth, api: createAwsApiClient({ baseUrl, getAccessToken: () => auth.getAccessToken() }) };
}

