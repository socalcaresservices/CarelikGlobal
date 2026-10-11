import { ApiError } from "./errors";

/**
 * Caregiver sign-in creation (0025). The API Lambda runs in private subnets
 * and cannot reach Cognito (the pool has a managed-login domain, so Cognito
 * PrivateLink cannot be used). It invokes a small identity Lambda outside the
 * VPC whose role holds ONLY cognito-idp:AdminCreateUser and AdminGetUser on
 * the one user pool. That function can create a user and resend the invitation
 * email; it cannot assign roles, read the database or set passwords. Every
 * permission, agency and role check happens in the database first.
 *
 * Passwords: Cognito generates the temporary password and emails it. No
 * password ever passes through, is returned by, or is logged by either Lambda.
 *
 * 0048 adds switching a sign-in off or on (AdminDisableUser / AdminEnableUser), addressed by the
 * person's Cognito `sub` (never an email). The function still cannot set a password, change an
 * email, assign a group, or delete anyone.
 */
export interface IdentityAdmin {
  /** Creates the sign-in (Cognito emails the invitation) or finds the existing one. */
  invite(email: string): Promise<{ sub: string; existingAccount: boolean }>;
  /** Re-sends the invitation email to a person who has not set their password yet. */
  resend(email: string): Promise<void>;
  /** Switches a sign-in off or on in Cognito. `sub` is the person's Cognito identifier. Disabled people cannot sign in; nothing is deleted. */
  setEnabled(sub: string, enabled: boolean): Promise<void>;
}

export type IdentityRequest =
  | { action: "invite" | "resend"; email: string }
  | { action: "disable" | "enable"; sub: string };
export type IdentityResponse =
  | { ok: true; sub?: string; existingAccount?: boolean }
  | { ok: false; error: "already_set_up" | "invalid_email" | "invalid_request" | "rate_limited" | "not_found" | "failed" };

const MESSAGES: Record<Exclude<IdentityResponse, { ok: true }>["error"], [number, string, string]> = {
  already_set_up: [409, "conflict", "This person has already set up their sign-in; they can use \"Forgot password\" on the sign-in page."],
  invalid_email: [422, "validation_failed", "Enter a valid email address."],
  invalid_request: [422, "validation_failed", "The request was not valid."],
  rate_limited: [429, "rate_limited", "Too many invitations were sent just now; try again in a few minutes."],
  not_found: [404, "not_found", "No sign-in was found for that person."],
  failed: [502, "identity_unavailable", "The sign-in service did not respond; nothing was changed. Try again."],
};

/** Maps the identity Lambda's answer to the API's error shape. */
export function identityError(error: Exclude<IdentityResponse, { ok: true }>["error"]): ApiError {
  const [status, code, message] = MESSAGES[error] ?? MESSAGES.failed;
  return new ApiError(status, code, message);
}

/** Used when no identity function is configured (local tools, older stacks). */
export const unavailableIdentityAdmin: IdentityAdmin = {
  invite: async () => { throw new ApiError(503, "identity_unavailable", "Invitations are not switched on for this environment."); },
  resend: async () => { throw new ApiError(503, "identity_unavailable", "Invitations are not switched on for this environment."); },
  setEnabled: async () => { throw new ApiError(503, "identity_unavailable", "Account changes are not switched on for this environment."); },
};

/** Calls the identity Lambda through an injected invoker (the AWS SDK in production). */
export function lambdaIdentityAdmin(invoke: (request: IdentityRequest) => Promise<IdentityResponse>): IdentityAdmin {
  const call = async (request: IdentityRequest) => {
    let response: IdentityResponse;
    try {
      response = await invoke(request);
    } catch {
      throw identityError("failed");
    }
    if (!response || response.ok !== true) throw identityError(response?.ok === false ? response.error : "failed");
    return response;
  };
  return {
    async invite(email) {
      const r = await call({ action: "invite", email });
      if (typeof r.sub !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.sub)) throw identityError("failed");
      return { sub: r.sub, existingAccount: r.existingAccount === true };
    },
    async resend(email) {
      await call({ action: "resend", email });
    },
    async setEnabled(sub, enabled) {
      await call({ action: enabled ? "enable" : "disable", sub });
    },
  };
}

/** In-memory stand-in for tests. Records calls; never stores passwords. */
export class MemoryIdentityAdmin implements IdentityAdmin {
  readonly users = new Map<string, { sub: string; confirmed: boolean }>();
  readonly calls: IdentityRequest[] = [];
  async invite(email: string) {
    this.calls.push({ action: "invite", email });
    const existing = this.users.get(email);
    if (existing) return { sub: existing.sub, existingAccount: existing.confirmed };
    const sub = crypto.randomUUID();
    this.users.set(email, { sub, confirmed: false });
    return { sub, existingAccount: false };
  }
  readonly disabled = new Set<string>();
  async setEnabled(sub: string, enabled: boolean) {
    this.calls.push({ action: enabled ? "enable" : "disable", sub });
    if (enabled) this.disabled.delete(sub); else this.disabled.add(sub);
  }
  async resend(email: string) {
    this.calls.push({ action: "resend", email });
    const u = this.users.get(email);
    if (!u) throw identityError("not_found");
    if (u.confirmed) throw identityError("already_set_up");
  }
}
