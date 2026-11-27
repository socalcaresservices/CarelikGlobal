import { createSmsSender } from "./sms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { loadConfig } from "./config";
import { secretsManagerPool } from "./db";
import { s3EvidenceStore } from "./evidence";
import { createHandler } from "./handler";
import { lambdaIdentityAdmin, unavailableIdentityAdmin, type IdentityRequest, type IdentityResponse } from "./identity";
import type { HttpApiEvent } from "./http";
import { isComplianceSweepEvent, runComplianceSweep } from "./scheduled";
import { isNotifySweepEvent, runNotifySweep, type EmailResult, type SendEmail } from "./notify";

export { createHandler } from "./handler";
export { ROUTE_KEYS, ROUTES } from "./routes";
export { clientDocumentObjectKey, documentObjectKey, lateFormObjectKey, logoObjectKey } from "./documents";
export { signatureObjectKey } from "./evidence";
export { MemoryEvidenceStore } from "./evidence";
export { MemoryIdentityAdmin } from "./identity";
export { COMPLIANCE_SWEEP_TASK, isComplianceSweepEvent, runComplianceSweep } from "./scheduled";
export { NOTIFY_SWEEP_TASK, isNotifySweepEvent, runNotifySweep, composeEmail } from "./notify";

let handlerInstance: ReturnType<typeof createHandler> | null = null;

let dbInstance: ReturnType<typeof secretsManagerPool> | null = null;

/**
 * Lambda entry point. Configuration is validated on first invocation (fail closed). Two kinds of event arrive here: an API Gateway
 * request (everything above), and the scheduled compliance run (0055), which carries no request or identity and only calls the
 * database functions that re-evaluate caregiver compliance. API Gateway wraps every HTTP request in routeKey/requestContext, so an
 * HTTP caller can never produce the scheduled shape.
 */
export async function handler(event: HttpApiEvent | Record<string, unknown>) {
  if (isComplianceSweepEvent(event)) {
    const config = loadConfig();
    dbInstance ??= secretsManagerPool(config, new SecretsManagerClient({ region: config.region }));
    return runComplianceSweep({ db: dbInstance, dbSetRole: config.dbSetRole });
  }
  if (isNotifySweepEvent(event)) {
    const config = loadConfig();
    dbInstance ??= secretsManagerPool(config, new SecretsManagerClient({ region: config.region }));
    const sendEmail = config.emailFunctionName ? invokeEmail(new LambdaClient({ region: config.region }), config.emailFunctionName) : undefined;
    return runNotifySweep({ db: dbInstance, dbSetRole: config.dbSetRole, sendEmail, appOrigin: config.appOrigin, sms: createSmsSender(config.smsMode) });
  }
  if (!handlerInstance) {
    const config = loadConfig();
    dbInstance ??= secretsManagerPool(config, new SecretsManagerClient({ region: config.region }));
    handlerInstance = createHandler({
      config,
      db: dbInstance,
      evidence: s3EvidenceStore(new S3Client({ region: config.region }), config.evidenceBucket, config.evidenceKeyArn),
      ...(config.emailFunctionName && config.appOrigin ? { email: { send: invokeEmail(new LambdaClient({ region: config.region }), config.emailFunctionName), appOrigin: config.appOrigin } } : {}),
      identity: config.identityFunctionName ? lambdaIdentityAdmin(invokeIdentity(new LambdaClient({ region: config.region }), config.identityFunctionName)) : unavailableIdentityAdmin,
    });
  }
  return handlerInstance(event as HttpApiEvent);
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

/** Synchronous invoke of the email function; the payload is the one message (address, subject, text); nothing is logged. */
function invokeEmail(lambda: LambdaClient, functionName: string): SendEmail {
  return async (message): Promise<EmailResult> => {
    const out = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify({ to: message.to, subject: message.subject, text: message.text, html: message.html })),
    }));
    if (out.FunctionError || !out.Payload) return { ok: false, error: "invoke_failed", transient: true };
    return JSON.parse(new TextDecoder().decode(out.Payload)) as EmailResult;
  };
}
