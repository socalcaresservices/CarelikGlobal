// Netlify Function: create-billing-portal-session
//
// Starts a real Stripe-hosted Billing Portal session for an organization
// that already has a Stripe customer (stripe_customer_id set by
// create-checkout-session.ts + stripe-webhook.ts once they've completed
// Checkout at least once). Lets the org update its payment method, view/
// download invoices, and cancel - all inside Stripe's own hosted UI, none
// of it re-implemented here.
//
// Same auth/permission shape as create-checkout-session.ts: runs
// server-side for STRIPE_SECRET_KEY, re-checks organization.update against
// the caller's own JWT rather than trusting the client, and never accepts
// a customer id from the request body.

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
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const appUrl = process.env.APP_URL ?? "https://app.ogevia.com";

  if (!supabaseUrl || !supabasePublishableKey || !stripeSecretKey) {
    return jsonResponse({ error: "Function is not configured" }, 500);
  }

  const callerClient = createClient(supabaseUrl, supabasePublishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false }
  });

  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: "Invalid session" }, 401);
  }

  // Same gate as create-checkout-session.ts - organization.update is the
  // correct agency-side permission for managing billing.
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
    .select("stripe_customer_id")
    .eq("id", organizationId)
    .single();
  if (orgError || !org) {
    return jsonResponse({ error: orgError?.message ?? "Organization not found" }, 404);
  }
  if (!org.stripe_customer_id) {
    return jsonResponse({ error: "This organization has not subscribed through Stripe yet." }, 409);
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: STRIPE_API_VERSION });

  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    // Server-resolved app host, same as create-checkout-session.ts -
    // never built from a client-supplied Origin/Referer.
    return_url: `${appUrl}/settings`
  });

  return jsonResponse({ url: session.url }, 200);
};
