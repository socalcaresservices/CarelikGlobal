begin;

-- process-events (20260821150000_shift_notification_events.sql) reads
-- Twilio credentials from Deno.env by design - the standard "supabase
-- secrets set" path. This session's tooling has no way to call that
-- (no CLI, no Management API reachable from this sandbox), so this table
-- is the bridge: a service-role-only credentials store the function
-- checks as a fallback when the env vars aren't set. Locked down the
-- same way every other sensitive table in this codebase is - RLS on, no
-- policies at all for anon/authenticated (default deny), only
-- service_role (which bypasses RLS) can ever read or write it. If
-- TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER are ever set as
-- real Edge Function secrets later, those take precedence and this table
-- becomes unused, not conflicting.
create table public.integration_secrets (
  provider text primary key,
  config jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.integration_secrets enable row level security;

revoke all on public.integration_secrets from public, anon, authenticated;

commit;
