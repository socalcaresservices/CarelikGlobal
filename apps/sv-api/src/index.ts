import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { loadConfig } from "./config";
import { secretsManagerPool } from "./db";
import { s3EvidenceStore } from "./evidence";
import { createHandler } from "./handler";
import { lambdaIdentityAdmin, unavailableIdentityAdmin, type IdentityRequest, type IdentityResponse } from "./identity";
import type { HttpApiEvent } from "./http";

export { createHandler } from "./handler";
export { ROUTE_KEYS, ROUTES } from "./routes";
export { MemoryEvidenceStore } from "./evidence";
export { MemoryIdentityAdmin } from "./identity";

let handlerInstance: ReturnType<typeof createHandler> | null = null;

/** Lambda entry point. Configuration is validated on first invocation (fail closed). */
export async function handler(event: HttpApiEvent) {
  if (!handlerInstance) {
    const config = loadConfig();
    handlerInstance = createHandler({
      config,
      db: secretsManagerPool(config, new SecretsManagerClient({ region: config.region })),
      evidence: s3EvidenceStore(new S3Client({ region: config.region }), config.evidenceBucket, config.evidenceKeyArn),
      identity: config.identityFunctionName ? lambdaIdentityAdmin(invokeIdentity(new LambdaClient({ region: config.region }), config.identityFunctionName)) : unavailableIdentityAdmin,
    });
  }
  return handlerInstance(event);
}

/** Synchronous invoke of the identity function; its payload never contains a password. */
function invokeIdentity(lambda: LambdaClient, functionName: string) {
  return async (request: IdentityRequest): Promise<IdentityResponse> => {
    const out = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(request)),
    }));
    if (out.FunctionError || !out.Payload) return { ok: false, error: "failed" };
    return JSON.parse(new TextDecoder().decode(out.Payload)) as IdentityResponse;
  };
}
