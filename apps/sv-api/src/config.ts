/**
 * Runtime configuration from the Lambda environment (identifiers only; no
 * secret values). Fails closed: a missing or malformed value stops cold start
 * instead of running with a partial security configuration.
 */
export interface ApiConfig {
  /** OGEVIA_ENV: "prd" is production and fails closed on the database name. */
  readonly environment: string | undefined;
  readonly region: string;
  readonly userPoolId: string;
  readonly appClientIds: readonly string[];
  /** OGEVIA_FORBIDDEN_POOL_IDS: user pools this deployment must never run on (production names the shared pilot pool). */
  readonly forbiddenUserPoolIds: readonly string[];
  readonly issuer: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbSecretArn: string;
  /** Database name; overrides the secret's dbname (e.g. the test-slice database). */
  readonly dbName: string | undefined;
  /** Optional SET LOCAL ROLE after connect (when the login user is not ogevia_app itself). */
  readonly dbSetRole: string | undefined;
  readonly evidenceBucket: string;
  readonly evidenceKeyArn: string;
  /** Identity Lambda for caregiver invitations (0025); unset = invitations switched off. */
  readonly identityFunctionName: string | undefined;
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
  const forbiddenUserPoolIds = (env.OGEVIA_FORBIDDEN_POOL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (forbiddenUserPoolIds.some((id) => !new RegExp(`^${region}_[A-Za-z0-9]+$`).test(id))) {
    throw new ConfigError("OGEVIA_FORBIDDEN_POOL_IDS is malformed");
  }
  if (forbiddenUserPoolIds.includes(userPoolId)) {
    throw new ConfigError("COGNITO_USER_POOL_ID is a user pool this environment must not use");
  }
  // Production has its OWN sign-in: exactly one app client, and the shared pilot pool must be named forbidden. A missing list stops
  // cold start instead of letting production trust the pilot's sign-in.
  if (env.OGEVIA_ENV?.trim() === "prd") {
    if (forbiddenUserPoolIds.length === 0) throw new ConfigError("OGEVIA_ENV=prd requires OGEVIA_FORBIDDEN_POOL_IDS (the shared pilot pool)");
    if (appClientIds.length !== 1) throw new ConfigError("OGEVIA_ENV=prd requires exactly one COGNITO_APP_CLIENT_ID");
  }
  const dbPort = Number(required(env, "DB_PORT"));
  if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) throw new ConfigError("DB_PORT is malformed");
  const dbSecretArn = required(env, "DB_SECRET_ARN");
  if (!dbSecretArn.startsWith("arn:aws:secretsmanager:")) throw new ConfigError("DB_SECRET_ARN is malformed");
  const dbName = env.DB_NAME?.trim() || undefined;
  if (dbName && !/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) throw new ConfigError("DB_NAME is malformed");
  const environment = env.OGEVIA_ENV?.trim() || undefined;
  // Production never guesses its database: DB_NAME must be exactly ogevia_prd, so
  // a missing or test-slice value stops cold start instead of serving real data
  // from (or writing it to) the wrong database.
  if (environment === "prd" && dbName !== "ogevia_prd") {
    throw new ConfigError("OGEVIA_ENV=prd requires DB_NAME=ogevia_prd");
  }
  const dbSetRole = env.DB_SET_ROLE?.trim() || undefined;
  if (dbSetRole && !/^[a-z_][a-z0-9_]*$/.test(dbSetRole)) throw new ConfigError("DB_SET_ROLE is malformed");
  const evidenceKeyArn = required(env, "EVIDENCE_KEY_ARN");
  if (!evidenceKeyArn.startsWith("arn:aws:kms:")) throw new ConfigError("EVIDENCE_KEY_ARN is malformed");
  const identityFunctionName = env.IDENTITY_FUNCTION_NAME?.trim() || undefined;
  if (identityFunctionName && !/^[A-Za-z0-9-_]{1,64}$/.test(identityFunctionName)) throw new ConfigError("IDENTITY_FUNCTION_NAME is malformed");
  return {
    environment,
    region,
    identityFunctionName,
    userPoolId,
    appClientIds,
    forbiddenUserPoolIds,
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    dbHost: required(env, "DB_HOST"),
    dbPort,
    dbSecretArn,
    dbName,
    dbSetRole,
    evidenceBucket: required(env, "EVIDENCE_BUCKET"),
    evidenceKeyArn,
  };
}
