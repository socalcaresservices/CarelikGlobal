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
// dispatchEvent() sends SMS for the two shift-coverage event types
// (20260821150000_shift_notification_events.sql) via Twilio - the first
// real downstream integration this stub has had. Every other event_type
// still falls through to the original log-and-succeed no-op, same as
// before, so the outbox never piles up unprocessed just because a given
// event type has no handler yet.
//
// Twilio is optional at the infra level: TWILIO_ACCOUNT_SID/
// TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER are read from env (set them as
// Supabase Edge Function secrets - see README "Event processing"). If
// they're not set, shift.* events are logged and marked complete rather
// than dead-lettered, so turning Twilio on later doesn't require
// replaying a backlog - only newly-emitted events get texted.

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

interface ShiftAssignedPayload {
  shift_id: string;
  client_id: string;
  caregiver_user_id: string | null;
  caregiver_record_id: string | null;
  starts_at: string;
  ends_at: string;
}

interface ShiftNeedsCoveragePayload {
  shift_id: string;
  client_id: string;
  starts_at: string;
  ends_at: string;
  reason: string;
}

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

// Light US-only normalization: Twilio requires E.164 (+1XXXXXXXXXX).
// Numbers are typically stored as free-text ("(555) 010-0100" etc.), not
// validated on entry anywhere in this app today - strip everything but
// digits and assume a bare 10-digit number is a US number, which covers
// every phone number in this codebase's current data model without
// guessing at international formats it has no other signal for.
function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+")) return raw;
  return null;
}

function formatShiftWhen(startsAt: string): string {
  return new Date(startsAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

async function sendSms(to: string, body: string): Promise<void> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!accountSid || !authToken || !fromNumber) {
    console.log(`[process-events] Twilio not configured - skipping SMS to ${to}: ${body}`);
    return;
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ To: to, From: fromNumber, Body: body })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Twilio SMS to ${to} failed (${response.status}): ${detail}`);
  }
}

async function dispatchShiftAssigned(adminClient: ReturnType<typeof createClient>, event: DomainEvent): Promise<void> {
  const payload = event.payload as ShiftAssignedPayload;

  const { data: client } = await adminClient
    .from("clients")
    .select("first_name, last_name")
    .eq("id", payload.client_id)
    .maybeSingle();
  const clientName = client ? `${client.first_name} ${client.last_name}` : "a client";
  const when = formatShiftWhen(payload.starts_at);

  let phone: string | null = null;
  if (payload.caregiver_user_id) {
    const { data } = await adminClient
      .from("user_profiles")
      .select("phone")
      .eq("id", payload.caregiver_user_id)
      .maybeSingle();
    phone = data?.phone ?? null;
  } else if (payload.caregiver_record_id) {
    const { data } = await adminClient
      .from("caregiver_records")
      .select("phone")
      .eq("id", payload.caregiver_record_id)
      .maybeSingle();
    phone = data?.phone ?? null;
  }

  const to = toE164(phone);
  if (!to) {
    console.log(`[process-events] shift.assigned (${event.id}): no usable phone number on file, skipping SMS`);
    return;
  }
  await sendSms(to, `You've been scheduled for a shift with ${clientName} on ${when}.`);
}

async function dispatchShiftNeedsCoverage(adminClient: ReturnType<typeof createClient>, event: DomainEvent): Promise<void> {
  const payload = event.payload as ShiftNeedsCoveragePayload;
  if (!event.organization_id) return;

  const { data: client } = await adminClient
    .from("clients")
    .select("first_name, last_name")
    .eq("id", payload.client_id)
    .maybeSingle();
  const clientName = client ? `${client.first_name} ${client.last_name}` : "a client";
  const when = formatShiftWhen(payload.starts_at);

  // Every active member of the org who holds shifts.update - the people
  // who'd otherwise only find out by opening the Schedule page. Two
  // separate queries rather than a PostgREST embed: organization_memberships
  // .user_id references auth.users, not public.user_profiles, so there's
  // no FK for an automatic user_profiles(...) embed to follow.
  const { data: rolePermissions } = await adminClient
    .from("role_permissions")
    .select("role")
    .eq("permission_key", "shifts.update");
  const eligibleRoles = (rolePermissions ?? []).map((row: { role: string }) => row.role);

  const { data: members } = await adminClient
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", event.organization_id)
    .eq("status", "active")
    .in("role", eligibleRoles.length > 0 ? eligibleRoles : ["__none__"]);
  const memberIds = (members ?? []).map((row: { user_id: string }) => row.user_id);

  const { data: profiles } = memberIds.length > 0
    ? await adminClient.from("user_profiles").select("phone").in("id", memberIds)
    : { data: [] as Array<{ phone: string | null }> };

  const phones = (profiles ?? [])
    .map((row: { phone: string | null }) => toE164(row.phone))
    .filter((phone): phone is string => phone !== null);

  if (phones.length === 0) {
    console.log(`[process-events] shift.needs_coverage (${event.id}): no staff phone numbers on file, skipping SMS`);
    return;
  }

  const message = `Shift needs coverage: ${clientName} on ${when} (call-out reason: ${payload.reason}). Open the app to reassign.`;
  await Promise.all(phones.map((to) => sendSms(to, message)));
}

async function dispatchEvent(adminClient: ReturnType<typeof createClient>, event: DomainEvent): Promise<void> {
  switch (event.event_type) {
    case "shift.assigned":
      await dispatchShiftAssigned(adminClient, event);
      break;
    case "shift.needs_coverage":
      await dispatchShiftNeedsCoverage(adminClient, event);
      break;
    default:
      console.log(`[process-events] dispatching ${event.event_type} (${event.id})`);
      break;
  }
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
      await dispatchEvent(adminClient, event);
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
