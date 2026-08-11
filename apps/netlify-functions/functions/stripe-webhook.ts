// Netlify Function: stripe-webhook
//
// Public endpoint - Stripe calls this directly, no Supabase session.
// Trust comes entirely from verifying the Stripe-Signature header against
// STRIPE_WEBHOOK_SECRET (raw body, before touching anything the payload
// claims).
//
// Idempotent: every event's id is inserted into stripe_webhook_events
// before any processing; a primary-key conflict means Stripe redelivered
// an event already handled, and the handler returns 200 without
// reapplying anything. Safe for out-of-order delivery: the actual
// ordering guard lives in record_stripe_subscription_event() itself
// (stripe_synced_event_created_at), which silently no-ops a late-arriving
// older event rather than overwriting newer state.
//
// The only writer of organizations' Stripe columns is
// record_stripe_subscription_event() - EXECUTE granted only to the
// service role, which is exactly the role this function authenticates as
// (SUPABASE_SERVICE_ROLE_KEY). No other code path can make this write.

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
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!signature || !stripeSecretKey || !webhookSecret || !supabaseUrl || !serviceRoleKey) {
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

  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Idempotency: insert before processing. A primary-key conflict means
  // this exact event was already handled - ack and stop, don't reapply.
  const { error: ledgerError } = await adminClient
    .from("stripe_webhook_events")
    .insert({ event_id: event.id, event_type: event.type });
  if (ledgerError) {
    if (ledgerError.code === "23505") {
      return jsonResponse({ received: true, duplicate: true }, 200);
    }
    return jsonResponse({ error: ledgerError.message }, 500);
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
      const subscription = event.data.object as Stripe.Subscription;
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
    return jsonResponse({ error: (error as Error).message }, 500);
  }

  return jsonResponse({ received: true }, 200);
};
