// Supabase Edge Function: invite-member
//
// Invites a user by email into an organization. This must run server-side
// because it needs the Supabase service-role key to call
// `auth.admin.inviteUserByEmail` — the browser application is only ever
// given the anonymous key (see README "Authentication").
//
// Request: POST { email: string, organizationId: string, role: string }
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
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function isValidRequestBody(
  body: InviteRequestBody
): body is { email: string; organizationId: string; role: string } {
  return (
    typeof body.email === "string" &&
    body.email.includes("@") &&
    typeof body.organizationId === "string" &&
    body.organizationId.length > 0 &&
    typeof body.role === "string" &&
    body.role.length > 0
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

  const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:5173";
  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    { redirectTo: siteUrl }
  );
  if (inviteError || !invited?.user) {
    return jsonResponse({ error: inviteError?.message ?? "Invite failed" }, 400);
  }

  const { error: membershipError } = await adminClient
    .from("organization_memberships")
    .upsert(
      {
        organization_id: organizationId,
        user_id: invited.user.id,
        role,
        status: "invited",
        invited_by: callerData.user.id
      },
      { onConflict: "organization_id,user_id" }
    );
  if (membershipError) {
    return jsonResponse({ error: membershipError.message }, 500);
  }

  return jsonResponse(
    { userId: invited.user.id, email, organizationId, role, status: "invited" },
    200
  );
});
