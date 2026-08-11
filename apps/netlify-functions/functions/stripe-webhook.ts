// Netlify Function: stripe-webhook
//
// Public endpoint - Stripe calls this directly, no Supabase session.
// Trust comes entirely from verifying the Stripe-Signature header against
// STRIPE_WEBHOOK_SECRET (raw body, before touching anything the payload
// claims).
//
// Idempotent, with real failure recovery: claim_stripe_webhook_event()
// atomically distinguishes "never seen this event" and "previously
// failed/never finished, safe to retry" (processed_at still null) from
// "already fully processed" (processed_at set) - only the latter is
// acknowledged without reprocessing. A naive "insert the id before
// processing" ledger (this function's first version) would have marked
// an event as handled the moment it was first *attempted*, so a
// genuinely failed attempt could never be retried - Stripe's redelivery
// would just see the row already exists and back off. Every processing
// path below ends by marking the event processed_at (success) or
// failed_at (error, so the next Stripe retry reclaims it).
//
// Safe for out-of-order delivery: the actual ordering guard lives in
// record_stripe_subscription_event() itself (stripe_synced_event_created_at),
// which silently no-ops a late-arriving older event rather than
// overwriting newer state.
//
// The only writer of organizations' Stripe columns is
// record_stripe_subscription_event() - EXECUTE granted only to the
// service_role Postgres role, which is exactly what this function
// authenticates as via SUPABASE_SECRET_KEY (Supabase's current sb_secret_...
// key type - same service_role privileges as the legacy service_role key
// it replaces, opaque token instead of a JWT; legacy keys are deprecated
// by end of 2026, see
// https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys).
// No other code path can make this write.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const STRIPE_API_VERSION = "2025-08-27.basil" as const;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toIso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;
}

// Stripe's Basil API version (2025-03-31) removed current_period_start/
// current_period_end from the Subscription object - they live on each
// Subscription Item now. Verified against Stripe's own changelog before
// writing this.
function periodFromSubscription(subscription: Stripe.Subscription) {
  const item = subscription.items.data[0] as (Stripe.SubscriptionItem & {
    current_period_start?: number;
    current_period_end?: number;
  }) | undefined;
  return {
    priceId: item?.price.id ?? null,
    periodStart: toIso(item?.current_period_start),
    periodEnd: toIso(item?.current_period_end)
  };
}

async function resolveOrganizationId(
  adminClient: SupabaseClient,
  subscription: Stripe.Subscription
): Promise<string | null> {
  const fromMetadata = subscription.metadata?.organization_id;
  if (fromMetadata) return fromMetadata;

  const { data } = await adminClient
    .from("organizations")
    .select("id")
    .eq("stripe_subscription_id", subscription.id)
    .maybeSingle();
  return data?.id ?? null;
}

async function applyEvent(
  adminClient: SupabaseClient,
  params: {
    organizationId: string;
    customerId: string;
    subscriptionId: string;
    priceId: string | null;
    planKey: string;
    status: Stripe.Subscription.Status;
    periodStart: string | null;
    periodEnd: string | null;
    eventId: string;
    eventCreatedAt: string;
  }
) {
  const { error } = await adminClient.rpc("record_stripe_subscription_event", {
    target_organization_id: params.organizationId,
    new_stripe_customer_id: params.customerId,
    new_stripe_subscription_id: params.subscriptionId,
    new_stripe_price_id: params.priceId,
    new_plan_key: params.planKey,
    new_subscription_status: mapStripeStatus(params.status),
    new_current_period_start: params.periodStart,
    new_current_period_end: params.periodEnd,
    new_event_id: params.eventId,
    new_event_created_at: params.eventCreatedAt
  });
  if (error) throw error;
}

// Stripe's subscription.status values mapped onto public.subscription_status
// ('trialing' | 'active' | 'past_due' | 'canceled' | 'suspended' |
// 'trial_expired'). Stripe's 'incomplete'/'incomplete_expired'/'unpaid'/
// 'paused' all indicate the subscription isn't in good standing without
// matching any single enum value 1:1 - they map to 'suspended', the same
// read-only-access state platform staff already use for a manually
// suspended org.
function mapStripeStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
    default:
      return "suspended";
  }
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const signature = req.headers.get("Stripe-Signature");
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!signature || !stripeSecretKey || !webhookSecret || !supabaseUrl || !supabaseSecretKey) {
    return jsonResponse({ error: "Function is not configured" }, 500);
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: STRIPE_API_VERSION });
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    return jsonResponse({ error: `Invalid signature: ${(error as Error).message}` }, 400);
  }

  const adminClient = createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false } });

  // Atomically claims this event (organization_id isn't known yet for
  // every event type at this point - it's resolved per event type below;
  // the ledger row's organization_id is bookkeeping, not what makes this
  // idempotent). already_processed=true means a prior attempt already
  // succeeded - ack without reapplying. false covers both "never seen"
  // and "previously failed" - both are safe, expected to (re)run.
  const { data: claimData, error: claimError } = (await adminClient
    .rpc("claim_stripe_webhook_event", {
      new_event_id: event.id,
      new_event_type: event.type,
      new_organization_id: null
    })
    .single()) as { data: { already_processed: boolean } | null; error: { message: string } | null };
  if (claimError) {
    return jsonResponse({ error: claimError.message }, 500);
  }
  if (claimData?.already_processed) {
    return jsonResponse({ received: true, duplicate: true }, 200);
  }

  const eventCreatedAt = new Date(event.created * 1000).toISOString();

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const organizationId = session.metadata?.organization_id;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

      if (!organizationId || !subscriptionId || !customerId) {
        // Not a subscription checkout we recognize - ack and move on
        // rather than erroring Stripe's retry loop over something we can
        // never correlate.
        return jsonResponse({ received: true }, 200);
      }

      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const { priceId, periodStart, periodEnd } = periodFromSubscription(subscription);
      await applyEvent(adminClient, {
        organizationId,
        customerId,
        subscriptionId,
        priceId,
        planKey: session.metadata?.plan_key ?? "start",
        status: subscription.status,
        periodStart,
        periodEnd,
        eventId: event.id,
        eventCreatedAt
      });
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      // The raw webhook payload's shape is governed by the Stripe
      // Dashboard webhook endpoint's own configured API version, which
      // may not match this function's pinned STRIPE_API_VERSION - so
      // period dates read directly off event.data.object could be on the
      // pre-Basil root shape instead of the subscription item, silently
      // coming back undefined. Re-fetching via our own pinned-version
      // client (same pattern already used for checkout/invoice events
      // below) makes every field this function reads version-safe,
      // regardless of what version the endpoint was created with. Still
      // retrievable even for .deleted - a canceled subscription doesn't
      // disappear from the API.
      const rawSubscription = event.data.object as Stripe.Subscription;
      const subscription = await stripe.subscriptions.retrieve(rawSubscription.id);
      const organizationId = await resolveOrganizationId(adminClient, subscription);
      if (!organizationId) {
        return jsonResponse({ received: true }, 200);
      }
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const { priceId, periodStart, periodEnd } = periodFromSubscription(subscription);
      await applyEvent(adminClient, {
        organizationId,
        customerId,
        subscriptionId: subscription.id,
        priceId,
        planKey: subscription.metadata?.plan_key ?? "start",
        status: subscription.status,
        periodStart,
        periodEnd,
        eventId: event.id,
        eventCreatedAt
      });
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      // As of Stripe's Basil API, an invoice's subscription reference
      // moved under parent.subscription_details.subscription - confirmed
      // against the installed SDK's own type definitions before writing
      // this (invoice.subscription no longer exists on the type at all).
      const subscriptionRef = invoice.parent?.subscription_details?.subscription;
      const subscriptionId = typeof subscriptionRef === "string" ? subscriptionRef : subscriptionRef?.id;
      if (!subscriptionId) {
        return jsonResponse({ received: true }, 200);
      }

      // Authoritative status comes from the Subscription itself, not
      // inferred from which invoice event fired.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const organizationId = await resolveOrganizationId(adminClient, subscription);
      if (!organizationId) {
        return jsonResponse({ received: true }, 200);
      }
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const { priceId, periodStart, periodEnd } = periodFromSubscription(subscription);
      await applyEvent(adminClient, {
        organizationId,
        customerId,
        subscriptionId: subscription.id,
        priceId,
        planKey: subscription.metadata?.plan_key ?? "start",
        status: subscription.status,
        periodStart,
        periodEnd,
        eventId: event.id,
        eventCreatedAt
      });
    }
  } catch (error) {
    // Leaves processed_at null so the next Stripe retry of this same
    // event.id reclaims it (claim_stripe_webhook_event's WHERE clause) -
    // this is the whole point of tracking failure separately from mere
    // receipt.
    await adminClient
      .from("stripe_webhook_events")
      .update({ failed_at: new Date().toISOString(), last_error: (error as Error).message })
      .eq("event_id", event.id);
    return jsonResponse({ error: (error as Error).message }, 500);
  }

  await adminClient
    .from("stripe_webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("event_id", event.id);

  return jsonResponse({ received: true }, 200);
};
