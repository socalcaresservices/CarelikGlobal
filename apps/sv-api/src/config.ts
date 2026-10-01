/**
 * Runtime configuration from the Lambda environment (identifiers only; no
 * secret values). Fails closed: a missing or malformed value stops cold start
 * instead of running with a partial security configuration.
 */
export interface ApiConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly appClientIds: readonly string[];
  readonly issuer: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbSecretArn: string;
  /** Optional SET LOCAL ROLE after connect (when the login user is not ogevia_app itself). */
  readonly dbSetRole: string | undefined;
  readonly evidenceBucket: string;
  readonly evidenceKeyArn: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${key}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const region = required(env, "AWS_REGION");
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new ConfigError("AWS_REGION is malformed");
  const userPoolId = required(env, "COGNITO_USER_POOL_ID");
  if (!new RegExp(`^${region}_[A-Za-z0-9]+$`).test(userPoolId)) {
    throw new ConfigError("COGNITO_USER_POOL_ID does not belong to AWS_REGION");
  }
  const appClientIds = required(env, "COGNITO_APP_CLIENT_ID").split(",").map((s) => s.trim()).filter(Boolean);
  if (appClientIds.length === 0 || appClientIds.some((id) => !/^[a-z0-9]{26}$/.test(id))) {
    throw new ConfigError("COGNITO_APP_CLIENT_ID is malformed");
  }
  const dbPort = Number(required(env, "DB_PORT"));
  if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) throw new ConfigError("DB_PORT is malformed");
  const dbSecretArn = required(env, "DB_SECRET_ARN");
  if (!dbSecretArn.startsWith("arn:aws:secretsmanager:")) throw new ConfigError("DB_SECRET_ARN is malformed");
  const dbSetRole = env.DB_SET_ROLE?.trim() || undefined;
  if (dbSetRole && !/^[a-z_][a-z0-9_]*$/.test(dbSetRole)) throw new ConfigError("DB_SET_ROLE is malformed");
  const evidenceKeyArn = required(env, "EVIDENCE_KEY_ARN");
  if (!evidenceKeyArn.startsWith("arn:aws:kms:")) throw new ConfigError("EVIDENCE_KEY_ARN is malformed");
  return {
    region,
    userPoolId,
    appClientIds,
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    dbHost: required(env, "DB_HOST"),
    dbPort,
    dbSecretArn,
    dbSetRole,
    evidenceBucket: required(env, "EVIDENCE_BUCKET"),
    evidenceKeyArn,
  };
}
