import { supabase } from "@/lib/supabase";

/**
 * Starts a real Stripe-hosted Checkout session for an organization to
 * subscribe to Ogevia Starter - the only plan this integration sells.
 * Backed by the `create-checkout-session` Netlify Function
 * (apps/netlify-functions/functions/create-checkout-session.ts), not a
 * Supabase edge function - it needs STRIPE_SECRET_KEY, which lives in
 * Netlify's Functions-only environment. Requires `organization.update` on
 * `organizationId`; the function re-checks this server-side against the
 * caller's own JWT, same as every other privileged action in this app.
 */
export async function createCheckoutSession(organizationId: string): Promise<{ url: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    throw new Error("You must be signed in to start checkout.");
  }

  const response = await fetch("/.netlify/functions/create-checkout-session", {
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
    throw new Error(body?.error ?? "Could not start checkout. Try again.");
  }

  return { url: body.url };
}
