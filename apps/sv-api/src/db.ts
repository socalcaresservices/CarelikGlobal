import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import type { ApiConfig } from "./config";

// DATE stays a 'YYYY-MM-DD' string (no local-timezone shift); BIGINT minutes
// are small enough for a JS number.
pg.types.setTypeParser(1082, (value: string) => value);
pg.types.setTypeParser(20, (value: string) => Number(value));

export interface ConnectionSource {
  connect(): Promise<pg.PoolClient>;
}

interface DbSecret {
  username: string;
  password: string;
  dbname: string;
}

function parseSecret(raw: string | undefined): DbSecret {
  let value: Partial<DbSecret> = {};
  try {
    value = JSON.parse(raw ?? "") as Partial<DbSecret>;
  } catch {
    // fall through: reported without echoing the secret
  }
  if (typeof value.username !== "string" || typeof value.password !== "string" || typeof value.dbname !== "string" || !value.dbname) {
    throw new Error("Database secret is missing username, password or dbname");
  }
  return value as DbSecret;
}

/**
 * One small pool per Lambda container (one request at a time per container).
 * TLS is required and verified. On Lambda Node.js 20+, NODE_EXTRA_CA_CERTS=
 * /var/runtime/ca-cert.pem (set by CDK) adds the Amazon RDS CA bundle.
 * The secret value is held in memory only and never logged.
 */
export function secretsManagerPool(config: ApiConfig, secrets: SecretsManagerClient): ConnectionSource {
  let pool: Promise<pg.Pool> | null = null;
  const create = async () => {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: config.dbSecretArn }));
    const secret = parseSecret(result.SecretString);
    const p = new pg.Pool({
      host: config.dbHost,
      port: config.dbPort,
      database: secret.dbname,
      user: secret.username,
      password: secret.password,
      ssl: { rejectUnauthorized: true },
      max: 2,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      application_name: "ogevia-sv-api",
    });
    p.on("error", () => {
      // An idle client died (e.g. RDS failover); drop the pool so the next
      // request reconnects. Nothing about the error is logged here.
      pool = null;
    });
    return p;
  };
  return {
    async connect() {
      pool ??= create().catch((error: unknown) => {
        pool = null;
        throw error;
      });
      return (await pool).connect();
    },
  };
}
