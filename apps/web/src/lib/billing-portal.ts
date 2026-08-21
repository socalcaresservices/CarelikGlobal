import { supabase } from "@/lib/supabase";

/**
 * Opens a real Stripe-hosted Billing Portal session for an organization
 * that already has a Stripe customer, so it can update its payment
 * method, view/download invoices, and cancel. Backed by the
 * `create-billing-portal-session` Netlify Function
 * (apps/netlify-functions/functions/create-billing-portal-session.ts),
 * same reasoning as `createCheckoutSession` in ./billing-checkout.ts.
 * Requires `organization.update` on `organizationId`, re-checked
 * server-side against the caller's own JWT.
 */
export async function createBillingPortalSession(organizationId: string): Promise<{ url: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new Error("You must be signed in to manage billing.");
  }

  const response = await fetch("/.netlify/functions/create-billing-portal-session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ organizationId })
  });

  let body: { url?: string; error?: string } | null = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error response - fall through to the generic message below.
  }

  if (!response.ok || !body?.url) {
    throw new Error(body?.error ?? "Could not open billing management. Try again.");
  }

  return { url: body.url };
}
