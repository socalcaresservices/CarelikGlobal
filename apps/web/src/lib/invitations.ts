import type { SystemRole } from "@carelik/shared";
import { supabase } from "@/lib/supabase";

export type InvitableRole = Exclude<SystemRole, "platform_owner">;

export interface InviteMemberInput {
  email: string;
  organizationId: string;
  role: InvitableRole;
}

export interface InviteMemberResult {
  userId: string;
  email: string;
  organizationId: string;
  role: InvitableRole;
  status: "invited";
}

/**
 * Invites a user into an organization by email. Backed by the
 * `invite-member` edge function, which is the only place the
 * Supabase service-role key is used — see
 * supabase/functions/invite-member/index.ts.
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
    throw error;
  }
  if (!data) {
    throw new Error("Invite failed: no response from server.");
  }

  return data;
}
