import type { SystemRole } from "@carelik/shared";
import { supabase } from "@/lib/supabase";
import { extractEdgeFunctionErrorMessage } from "@/lib/edge-function-errors";

export type InvitableRole = Extract<SystemRole, "organization_owner" | "manager" | "scheduler" | "caregiver">;

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
    throw new Error(await extractEdgeFunctionErrorMessage(error, "Could not add caregiver. Try again."));
  }
  if (!data) {
    throw new Error("Invite failed: no response from server.");
  }

  return data;
}

export interface UpdateMemberEmailInput {
  userId: string;
  organizationId: string;
  email: string;
}

export interface UpdateMemberEmailResult {
  userId: string;
  email: string;
}

/**
 * Corrects an existing member's login email. Backed by the
 * `update-member-email` edge function (the only place
 * auth.admin.updateUserById is called from) - requires membership.update
 * on `organizationId`, re-checked server-side the same way invite-member
 * re-checks membership.invite.
 */
export async function updateMemberEmail(input: UpdateMemberEmailInput): Promise<UpdateMemberEmailResult> {
  const { data, error } = await supabase.functions.invoke<UpdateMemberEmailResult>("update-member-email", {
    body: input
  });

  if (error) {
    throw new Error(await extractEdgeFunctionErrorMessage(error, "Could not update email. Try again."));
  }
  if (!data) {
    throw new Error("Email update failed: no response from server.");
  }

  return data;
}

export async function revokeMemberAccess(input: { organizationId: string; membershipId: string }) {
  const { data, error } = await supabase.functions.invoke("revoke-member-access", { body: input });
  if (error) throw new Error(await extractEdgeFunctionErrorMessage(error, "Could not revoke account access."));
  if (!data) throw new Error("Access revocation failed: no response from server.");
  return data;
}
