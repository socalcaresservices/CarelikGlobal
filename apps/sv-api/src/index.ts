import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { loadConfig } from "./config";
import { secretsManagerPool } from "./db";
import { s3EvidenceStore } from "./evidence";
import { createHandler } from "./handler";
import type { HttpApiEvent } from "./http";

export { createHandler } from "./handler";
export { ROUTE_KEYS, ROUTES } from "./routes";
export { MemoryEvidenceStore } from "./evidence";

let handlerInstance: ReturnType<typeof createHandler> | null = null;

/** Lambda entry point. Configuration is validated on first invocation (fail closed). */
export async function handler(event: HttpApiEvent) {
  if (!handlerInstance) {
    const config = loadConfig();
    handlerInstance = createHandler({
      config,
      db: secretsManagerPool(config, new SecretsManagerClient({ region: config.region })),
      evidence: s3EvidenceStore(new S3Client({ region: config.region }), config.evidenceBucket, config.evidenceKeyArn),
    });
  }
  return handlerInstance(event);
}
