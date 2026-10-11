import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { IdentityRequest, IdentityResponse } from "./identity";

/**
 * Identity Lambda (0025): outside the VPC, invoked only by the API Lambda
 * (resource policy + the API role's single lambda:InvokeFunction grant). Its
 * role allows AdminCreateUser, AdminGetUser, AdminDisableUser and AdminEnableUser on the one user pool, nothing
 * else. It never sets or returns a password and never logs the email address:
 * one line per call with the action and the outcome code only.
 */
const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

type Cognito = Pick<CognitoIdentityProviderClient, "send">;

export function createIdentityHandler(cognito: Cognito, userPoolId: string, log: (line: string) => void = console.log) {
  const subOf = (attributes: { Name?: string | undefined; Value?: string | undefined }[] | undefined) => attributes?.find((a) => a.Name === "sub")?.Value;
  const outcome = (action: string, result: IdentityResponse) => {
    log(JSON.stringify({ action, outcome: result.ok ? "ok" : result.error }));
    return result;
  };
  const failure = (name: string | undefined): IdentityResponse => ({
    ok: false,
    error: name === "UnsupportedUserStateException" ? "already_set_up"
      : name === "UserNotFoundException" ? "not_found"
      : name === "LimitExceededException" || name === "TooManyRequestsException" ? "rate_limited"
      : name === "InvalidParameterException" ? "invalid_email"
      : "failed",
  });

  return async function handler(event: IdentityRequest): Promise<IdentityResponse> {
    const action = event?.action;
    if (action === "disable" || action === "enable") {
      // Addressed by the Cognito sub (a UUID), never by email. Nothing is deleted and no password is touched.
      const sub = typeof (event as { sub?: unknown }).sub === "string" ? (event as { sub: string }).sub.trim().toLowerCase() : "";
      if (!SUB.test(sub)) return outcome(action, { ok: false, error: "invalid_request" });
      try {
        await cognito.send(action === "disable"
          ? new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: sub })
          : new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: sub }));
        return outcome(action, { ok: true });
      } catch (error) {
        return outcome(action, failure((error as { name?: string }).name));
      }
    }
    const email = typeof (event as { email?: unknown })?.email === "string" ? (event as { email: string }).email.trim().toLowerCase() : "";
    if ((action !== "invite" && action !== "resend") || email.length > 254 || !EMAIL.test(email)) {
      return outcome(String(action), { ok: false, error: "invalid_email" });
    }
    try {
      if (action === "resend") {
        await cognito.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId, Username: email, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"],
        }));
        return outcome(action, { ok: true });
      }
      try {
        const created = await cognito.send(new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          DesiredDeliveryMediums: ["EMAIL"],
          UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }],
        }));
        const sub = subOf(created.User?.Attributes);
        return outcome(action, sub ? { ok: true, sub, existingAccount: false } : { ok: false, error: "failed" });
      } catch (error) {
        if ((error as { name?: string }).name !== "UsernameExistsException") throw error;
        const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
        const sub = subOf(user.UserAttributes);
        if (!sub) return outcome(action, { ok: false, error: "failed" });
        // A sign-in still waiting for its first password change was created by an
        // earlier invitation that did not finish: send that person a fresh email.
        if (user.UserStatus === "FORCE_CHANGE_PASSWORD") {
          await cognito.send(new AdminCreateUserCommand({
            UserPoolId: userPoolId, Username: email, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"],
          }));
          return outcome(action, { ok: true, sub, existingAccount: false });
        }
        return outcome(action, { ok: true, sub, existingAccount: true });
      }
    } catch (error) {
      return outcome(action, failure((error as { name?: string }).name));
    }
  };
}

let instance: ReturnType<typeof createIdentityHandler> | null = null;

/** Lambda entry point. Fails closed when the pool id is missing or malformed. */
export async function handler(event: IdentityRequest): Promise<IdentityResponse> {
  if (!instance) {
    const region = process.env.AWS_REGION ?? "";
    const pool = process.env.COGNITO_USER_POOL_ID ?? "";
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region) || !new RegExp(`^${region}_[A-Za-z0-9]+$`).test(pool)) {
      throw new Error("Identity function is not configured");
    }
    instance = createIdentityHandler(new CognitoIdentityProviderClient({ region }), pool);
  }
  return instance(event);
}
