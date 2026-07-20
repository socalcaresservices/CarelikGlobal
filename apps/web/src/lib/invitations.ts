import type { SystemRole } from "@carelik/shared";
import { supabase } from "@/lib/supabase";

export type InvitableRole = Exclude<SystemRole, "platform_owner">;

export interface InviteMemberInput {
  email: string;
  organizationId: string;
  role: InvitableRole;
  /**
   * When firstName/lastName are given, the edge function creates the
   * caregiver as a roster record right away (no email sent, membership
   * status "active") instead of emailing a sign-in invite. See
   * supabase/functions/invite-member/index.ts for the branch logic.
   */
  firstName?: string | undefined;
  lastName?: string | undefined;
  phone?: string | undefined;
}

export interface InviteMemberResult {
  userId: string;
  email: string;
  organizationId: string;
  role: InvitableRole;
  status: "invited" | "active";
}

/**
 * supabase-js's `functions.invoke` throws a generic FunctionsHttpError
 * ("Edge Function returned a non-2xx status code") whenever the edge
 * function responds with a non-2xx status - it does NOT read the JSON
 * body of the response into the error message. Our edge function always
 * responds with `{ error: "<specific reason>" }` on failure (see
 * supabase/functions/invite-member/index.ts), so this pulls that real
 * message back out of `error.context`, the raw Response object the
 * client library hands back. Without this, every failure - wrong
 * permission, duplicate email, bad input - looks identical to the user.
 */
async function extractErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        return body.error;
      }
    } catch {
      // Response body wasn't JSON - fall through to the generic message.
    }
  }
  return error instanceof Error ? error.message : "Could not add caregiver. Try again.";
}

/**
 * Adds someone to an organization. Backed by the `invite-member` edge
 * function, which is the only place the Supabase service-role key is
 * used — see supabase/functions/invite-member/index.ts.
 *
 * Requires the caller to hold `membership.invite` for the target
 * organization; the edge function re-checks this server-side, so this
 * client helper does not attempt its own permission gate.
 */
export async function inviteMember(input: InviteMemberInput): Promise<InviteMemberResult> {
  const { data, error } = await supabase.functions.invoke<InviteMemberResult>("invite-member", {
    body: input
  });

  if (error) {
    throw new Error(await extractErrorMessage(error));
  }
  if (!data) {
    throw new Error("Invite failed: no response from server.");
  }

  return data;
}
