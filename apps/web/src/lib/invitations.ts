import type { SystemRole } from "@carelik/shared";
import { supabase } from "@/lib/supabase";
import { extractEdgeFunctionErrorMessage } from "@/lib/edge-function-errors";

export type InvitableRole = Exclude<SystemRole, "platform_owner">;

export interface InviteMemberInput {
  email: string;
  organizationId: string;
  role: InvitableRole;
  /**
   * Links this invite back to an existing caregiver_records row (a
   * workforce roster record added without login access - see
   * team-page.tsx's "Add a caregiver" form) instead of leaving that
   * person as two disconnected records. Only ever set from the "Invite
   * to Ogevia" action on an unlinked caregiver row.
   */
  caregiverRecordId?: string | undefined;
}

export interface InviteMemberResult {
  userId: string;
  email: string;
  organizationId: string;
  role: InvitableRole;
  status: "invited";
}

/**
 * Sends someone a real sign-in invitation and adds them to an
 * organization's membership. Backed by the `invite-member` edge
 * function, which is the only place the Supabase service-role key is
 * used — see supabase/functions/invite-member/index.ts.
 *
 * This always emails an invite - there is no "create a roster record
 * with no login" mode here anymore. That's a plain insert into
 * caregiver_records instead (team-page.tsx's "Add a caregiver" form),
 * which never calls this function at all.
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
    throw new Error(await extractEdgeFunctionErrorMessage(error, "Could not send the invite. Try again."));
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
