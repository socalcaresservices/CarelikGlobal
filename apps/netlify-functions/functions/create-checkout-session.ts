// Netlify Function: create-checkout-session
//
// Starts a real Stripe-hosted Checkout session for an organization to
// subscribe to Ogevia Starter - the only plan this integration sells.
// Runs server-side because it needs STRIPE_SECRET_KEY (Netlify
// Functions-only secret, never exposed to the browser) and, after the
// permission check, a service-role-free read of the organization's
// current Stripe state via the caller's own JWT (RLS-scoped, same as the
// browser would see).
//
// No price id or plan key is ever accepted from the client - the only
// thing sold here is STRIPE_STARTER_PRICE_ID, read straight from the
// environment. Never marks anything as paid itself - only
// stripe-webhook.ts, once Stripe confirms via a signed event, does that.

import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const STRIPE_API_VERSION = "2025-08-27.basil" as const;

const jsonHeaders = { "Content-Type": "application/json" };

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

interface RequestBody {
  organizationId?: unknown;
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing authorization header" }, 401);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be JSON" }, 400);
  }
  if (typeof body.organizationId !== "string" || body.organizationId.length === 0) {
    return jsonResponse({ error: "organizationId is required" }, 400);
  }
  const { organizationId } = body as { organizationId: string };

  const supabaseUrl = process.env.SUPABASE_URL;
  // sb_publishable_... - Supabase's current low-privilege key type,
  // replacing the legacy anon key (same RLS behavior, opaque token
  // instead of a JWT). Legacy anon keys are deprecated by end of 2026 -
  // see https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys.
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const starterPriceId = process.env.STRIPE_STARTER_PRICE_ID;
  const appUrl = process.env.APP_URL ?? "https://app.ogevia.com";

  if (!supabaseUrl || !supabasePublishableKey || !stripeSecretKey) {
    return jsonResponse({ error: "Function is not configured" }, 500);
  }
  if (!starterPriceId) {
    return jsonResponse({ error: "Starter plan checkout is not configured yet - contact support." }, 500);
  }

  // Scoped to the caller's own JWT. Reused for both auth.getUser() and the
  // has_permission RPC below - auth.uid() only resolves correctly inside
  // has_permission() if the same authenticated client (same Authorization
  // header) makes both calls.
  const callerClient = createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "Invalid session" }, 401);
  }

  // organization.update is held only by organization_owner and
  // organization_admin (confirmed live against role_permissions before
  // writing this) - the correct agency-side gate for initiating billing.
  const { data: canManageBilling, error: permissionError } = await callerClient.rpc("has_permission", {
    target_organization_id: organizationId,
    requested_permission: "organization.update"
  });
  if (permissionError) {
    return jsonResponse({ error: permissionError.message }, 500);
  }
  if (!canManageBilling) {
    return jsonResponse({ error: "You do not have permission to manage this organization's billing" }, 403);
  }

  const { data: org, error: orgError } = await callerClient
    .from("organizations")
    .select("stripe_customer_id, stripe_subscription_id, subscription_status, billing_email")
    .eq("id", organizationId)
    .single();
  if (orgError || !org) {
    return jsonResponse({ error: orgError?.message ?? "Organization not found" }, 404);
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: STRIPE_API_VERSION });

  // Duplicate prevention, layer 1: our own last-synced state.
  if (org.stripe_subscription_id && (org.subscription_status === "active" || org.subscription_status === "trialing")) {
    return jsonResponse({ error: "This organization already has an active Ogevia subscription." }, 409);
  }

  // Duplicate prevention, layer 2: ask Stripe directly, in case the local
  // row hasn't been synced yet (webhook lag) or a concurrent request is
  // already in flight for the same customer.
  if (org.stripe_customer_id) {
    const [activeSubs, trialingSubs] = await Promise.all([
      stripe.subscriptions.list({ customer: org.stripe_customer_id, status: "active", limit: 1 }),
      stripe.subscriptions.list({ customer: org.stripe_customer_id, status: "trialing", limit: 1 })
    ]);
    if (activeSubs.data.length > 0 || trialingSubs.data.length > 0) {
      return jsonResponse({ error: "This organization already has an active Ogevia subscription in Stripe." }, 409);
    }
  }

  const metadata = { organization_id: organizationId, plan_key: "start" };

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: starterPriceId, quantity: 1 }],
    ...(org.stripe_customer_id
      ? { customer: org.stripe_customer_id }
      : { customer_email: org.billing_email ?? undefined }),
    client_reference_id: organizationId,
    metadata,
    subscription_data: { metadata },
    // Server-resolved app host (Part A's real tenant-app domain) - never
    // built from a client-supplied Origin/Referer, never the marketing
    // root.
    success_url: `${appUrl}/settings?checkout=success`,
    cancel_url: `${appUrl}/settings?checkout=cancelled`
  });

  if (!session.url) {
    return jsonResponse({ error: "Could not start checkout" }, 500);
  }

  return jsonResponse({ url: session.url }, 200);
};
