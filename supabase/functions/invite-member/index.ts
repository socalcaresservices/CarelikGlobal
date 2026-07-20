// Supabase Edge Function: invite-member
//
// Adds someone to an organization. This must run server-side because it
// needs the Supabase service-role key to create/invite auth users — the
// browser application is only ever given the anonymous key (see README
// "Authentication").
//
// Two modes, chosen by whether firstName/lastName are included:
//
//   - Profile details given (Team page "Add a caregiver" form): creates
//     the auth user directly via `auth.admin.createUser`, no email sent,
//     membership status is set to "active" immediately. This is for
//     caregivers who are a roster record first — they don't need to sign
//     in to be scheduled. Their name/phone are written straight into
//     user_profiles via the metadata the `handle_new_user` trigger reads.
//
//   - No profile details (Access page "Invite" form, for office/admin
//     roles who need to actually log in and use the app): falls back to
//     the original `auth.admin.inviteUserByEmail` flow, which emails a
//     sign-in link and leaves membership status as "invited" until they
//     accept.
//
// Request: POST { email, organizationId, role, firstName?, lastName?, phone? }
// Auth:    Authorization: Bearer <caller's access token>
//          (supabase-js `functions.invoke` attaches this automatically
//          for an authenticated session)
//
// The caller's own permissions are checked with an RLS-scoped client
// (using their JWT, not the service role) via the existing `has_permission`
// database function, so this endpoint can only be used by someone who
// already holds `membership.invite` for the target organization.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

interface InviteRequestBody {
  email?: unknown;
  organizationId?: unknown;
  role?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  phone?: unknown;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function isValidRequestBody(
  body: InviteRequestBody
): body is {
  email: string;
  organizationId: string;
  role: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
} {
  const optionalStringOk = (value: unknown) => value === undefined || typeof value === "string";
  return (
    typeof body.email === "string" &&
    body.email.includes("@") &&
    typeof body.organizationId === "string" &&
    body.organizationId.length > 0 &&
    typeof body.role === "string" &&
    body.role.length > 0 &&
    optionalStringOk(body.firstName) &&
    optionalStringOk(body.lastName) &&
    optionalStringOk(body.phone)
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing authorization header" }, 401);
  }

  let body: InviteRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be JSON" }, 400);
  }

  if (!isValidRequestBody(body)) {
    return jsonResponse(
      { error: "email, organizationId, and role are required" },
      400
    );
  }

  const { email, organizationId, role } = body;
  const firstName = body.firstName?.trim();
  const lastName = body.lastName?.trim();
  const phone = body.phone?.trim();
  const hasProfileDetails = Boolean(firstName) && Boolean(lastName);

  if (role === "platform_owner") {
    return jsonResponse(
      { error: "platform_owner cannot be granted through invitations" },
      400
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Function is not configured" }, 500);
  }

  // Scoped to the caller's own JWT — every call goes through RLS exactly
  // as it would from the browser. Never used to bypass a policy.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "Invalid session" }, 401);
  }

  const { data: canInvite, error: permissionError } = await callerClient.rpc(
    "has_permission",
    {
      target_organization_id: organizationId,
      requested_permission: "membership.invite"
    }
  );
  if (permissionError) {
    return jsonResponse({ error: permissionError.message }, 500);
  }
  if (!canInvite) {
    return jsonResponse(
      { error: "You do not have permission to invite members to this organization" },
      403
    );
  }

  // Service-role client — only ever created here, server-side, and only
  // after the permission check above has passed.
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });

  let userId: string;
  let membershipStatus: "active" | "invited";

  if (hasProfileDetails) {
    const displayName = `${firstName} ${lastName}`.trim();
    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { display_name: displayName, first_name: firstName, last_name: lastName }
    });
    if (createError || !created?.user) {
      const message = createError?.message ?? "";
      if (/already.*registered|already.*exists/i.test(message)) {
        return jsonResponse({ error: "That email is already on your team." }, 409);
      }
      return jsonResponse({ error: message || "Could not add caregiver" }, 400);
    }
    userId = created.user.id;
    membershipStatus = "active";

    if (phone) {
      const { error: phoneError } = await adminClient
        .from("user_profiles")
        .update({ phone })
        .eq("id", userId);
      if (phoneError) {
        return jsonResponse({ error: phoneError.message }, 500);
      }
    }
  } else {
    const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:5173";
    const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      { redirectTo: siteUrl }
    );
    if (inviteError || !invited?.user) {
      return jsonResponse({ error: inviteError?.message ?? "Invite failed" }, 400);
    }
    userId = invited.user.id;
    membershipStatus = "invited";
  }

  const { error: membershipError } = await adminClient
    .from("organization_memberships")
    .upsert(
      {
        organization_id: organizationId,
        user_id: userId,
        role,
        status: membershipStatus,
        invited_by: callerData.user.id,
        ...(membershipStatus === "active" ? { joined_at: new Date().toISOString() } : {})
      },
      { onConflict: "organization_id,user_id" }
    );
  if (membershipError) {
    return jsonResponse({ error: membershipError.message }, 500);
  }

  return jsonResponse(
    { userId, email, organizationId, role, status: membershipStatus },
    200
  );
});
