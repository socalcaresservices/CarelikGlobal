// Supabase Edge Function: process-events
//
// Processes the domain_events outbox (docs/phase-1-foundation.md,
// "Domain event outbox"). Meant to be invoked on a schedule (see README,
// "Event processing"), not called from the browser - there is no path
// for the anon/authenticated roles to reach claim_domain_events /
// complete_domain_event / fail_domain_event at all (see
// supabase/migrations/20260719160000_domain_event_outbox_processing.sql),
// so this function's own request auth is a minimal shared-secret check
// rather than a per-user permission check like invite-member has.
//
// claim_domain_events uses FOR UPDATE SKIP LOCKED, so it's safe for this
// function to run on overlapping schedules without double-processing an
// event.
//
// dispatchEvent() is currently a stub: no downstream integration
// (webhook target, email provider, etc.) exists yet in this codebase.
// It logs and reports success so the outbox doesn't just pile up
// unprocessed forever; replace the switch with real handlers per
// event_type as those integrations are built.

import { createClient } from "npm:@supabase/supabase-js@2";

interface DomainEvent {
  id: string;
  organization_id: string | null;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  metadata: unknown;
  attempts: number;
}

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

async function dispatchEvent(event: DomainEvent): Promise<void> {
  // Extension point. Example once a real integration exists:
  //
  // switch (event.event_type) {
  //   case "membership.invited":
  //     await sendWebhook(event);
  //     break;
  //   default:
  //     break;
  // }
  console.log(`[process-events] dispatching ${event.event_type} (${event.id})`);
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const cronSecret = Deno.env.get("PROCESS_EVENTS_SECRET");
  if (cronSecret) {
    const provided = req.headers.get("x-cron-secret");
    if (provided !== cronSecret) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Function is not configured" }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });

  const { data: claimed, error: claimError } = await adminClient.rpc("claim_domain_events", {
    batch_size: BATCH_SIZE
  });
  if (claimError) {
    return jsonResponse({ error: claimError.message }, 500);
  }

  const events = (claimed ?? []) as DomainEvent[];
  let published = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await dispatchEvent(event);
      const { error } = await adminClient.rpc("complete_domain_event", {
        target_event_id: event.id
      });
      if (error) throw error;
      published += 1;
    } catch (cause) {
      failed += 1;
      const message = cause instanceof Error ? cause.message : "Unknown dispatch error";
      await adminClient.rpc("fail_domain_event", {
        target_event_id: event.id,
        error_message: message,
        max_attempts: MAX_ATTEMPTS
      });
    }
  }

  return jsonResponse({ claimed: events.length, published, failed }, 200);
});
