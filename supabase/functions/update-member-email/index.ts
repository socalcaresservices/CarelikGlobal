// Supabase Edge Function: update-member-email
//
// Corrects an existing member's login email (e.g. a typo made at invite
// time, or an agency's contact changing addresses). Has to run
// server-side for the same reason invite-member does: changing a user's
// email requires the service-role key, which the browser never has.
//
// Request: POST { userId, organizationId, email }
// Auth:    Authorization: Bearer <caller's access token>
//
// The caller's permission is checked with an RLS-scoped client (their
// own JWT, not the service role) via has_permission(organizationId,
// 'membership.update') - the same permission access-page.tsx already
// requires to change a member's role or revoke them, so this reuses that
// gate rather than inventing a new one.
//
// email_confirm is set to true: this is an admin correcting someone
// else's account, not the member changing their own email through a
// self-service flow, so there's no "confirm via link sent to the new
// address" step - the change takes effect immediately, matching how
// invite-member's createUser path already skips confirmation for
// roster-added caregivers.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

interface UpdateEmailRequestBody {
  userId?: unknown;
  organizationId?: unknown;
  email?: unknown;
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function isValidRequestBody(
  body: UpdateEmailRequestBody
): body is { userId: string; organizationId: string; email: string } {
  return (
    typeof body.userId === "string" &&
    body.userId.length > 0 &&
    typeof body.organizationId === "string" &&
    body.organizationId.length > 0 &&
    typeof body.email === "string" &&
    body.email.includes("@")
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

  let body: UpdateEmailRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be JSON" }, 400);
  }

  if (!isValidRequestBody(body)) {
    return jsonResponse({ error: "userId, organizationId, and email are required" }, 400);
  }

  const { userId, organizationId, email } = body;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse({ error: "Function is not configured" }, 500);
  }

  // Scoped to the caller's own JWT - every call goes through RLS exactly
  // as it would from the browser. Never used to bypass a policy.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "Invalid session" }, 401);
  }

  const { data: canManage, error: permissionError } = await callerClient.rpc("has_permission", {
    target_organization_id: organizationId,
    requested_permission: "membership.update"
  });
  if (permissionError) {
    return jsonResponse({ error: permissionError.message }, 500);
  }
  if (!canManage) {
    return jsonResponse(
      { error: "You do not have permission to update members in this organization" },
      403
    );
  }

  // Confirm the target user is actually a member of this organization -
  // has_permission only proves the *caller* belongs here, not that
  // userId does. Without this, anyone with membership.update in one org
  // could change the email of an arbitrary user id from a different org.
  const { data: membership, error: membershipError } = await callerClient
    .from("organization_memberships")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipError) {
    return jsonResponse({ error: membershipError.message }, 500);
  }
  if (!membership) {
    return jsonResponse({ error: "That member does not belong to this organization" }, 404);
  }

  // Service-role client - only ever created here, server-side, and only
  // after the permission and membership checks above have passed.
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });

  const { data: updated, error: updateError } = await adminClient.auth.admin.updateUserById(userId, {
    email,
    email_confirm: true
  });
  if (updateError || !updated?.user) {
    const message = updateError?.message ?? "";
    if (/already.*registered|already.*exists/i.test(message)) {
      return jsonResponse({ error: "That email is already in use by another account." }, 409);
    }
    return jsonResponse({ error: message || "Could not update email" }, 400);
  }

  return jsonResponse({ userId, email }, 200);
});
