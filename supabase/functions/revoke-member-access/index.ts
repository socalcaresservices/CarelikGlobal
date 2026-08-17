import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization header" }, 401);

  let body: { organizationId?: unknown; membershipId?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Request body must be JSON" }, 400); }
  if (typeof body.organizationId !== "string" || typeof body.membershipId !== "string") {
    return json({ error: "organizationId and membershipId are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Function is not configured" }, 500);

  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false }
  });
  const { data: callerData, error: callerError } = await caller.auth.getUser();
  if (callerError || !callerData.user) return json({ error: "Invalid session" }, 401);
  const { data: allowed } = await caller.rpc("has_permission", {
    target_organization_id: body.organizationId, requested_permission: "membership.update"
  });
  if (!allowed) return json({ error: "Only the organization owner can revoke account access" }, 403);

  const { data: target, error: targetError } = await caller.from("organization_memberships")
    .select("id,user_id,role,status").eq("id", body.membershipId)
    .eq("organization_id", body.organizationId).maybeSingle();
  if (targetError) return json({ error: targetError.message }, 500);
  if (!target) return json({ error: "Member not found in this organization" }, 404);
  if (target.user_id === callerData.user.id) return json({ error: "You cannot revoke your own access" }, 400);
  if (target.role === "organization_owner") return json({ error: "Transfer ownership before revoking an owner" }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { error: revokeError } = await admin.from("organization_memberships")
    .update({ status: "revoked" }).eq("id", target.id).eq("organization_id", body.organizationId);
  if (revokeError) return json({ error: revokeError.message }, 500);

  await admin.from("caregiver_records").update({ status: "inactive" })
    .eq("organization_id", body.organizationId).eq("linked_user_id", target.user_id).is("deleted_at", null);

  const { count, error: countError } = await admin.from("organization_memberships")
    .select("id", { count: "exact", head: true }).eq("user_id", target.user_id).eq("status", "active");
  if (countError) return json({ error: countError.message }, 500);
  if ((count ?? 0) === 0) {
    const { error: banError } = await admin.auth.admin.updateUserById(target.user_id, { ban_duration: "876000h" });
    if (banError) return json({ error: `Membership revoked, but account ban failed: ${banError.message}` }, 500);
  }

  return json({ membershipId: target.id, userId: target.user_id, status: "revoked", accountBanned: (count ?? 0) === 0 });
});
