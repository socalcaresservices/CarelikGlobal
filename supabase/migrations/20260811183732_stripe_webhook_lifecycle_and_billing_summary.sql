begin;

-- Fixes two real gaps found in an independent review of the just-shipped
-- Stripe integration, both confirmed against the actual code before
-- writing this:
--
-- 1. stripe-webhook.ts inserted an event's id into stripe_webhook_events
-- BEFORE processing it, with no way to tell "already succeeded" apart
-- from "failed partway through." A failed event that then got retried by
-- Stripe would hit the same event_id, look like a duplicate, and get
-- acknowledged (200) without ever actually being reprocessed - silently
-- swallowing the failure. Fixed by tracking the full lifecycle
-- (processing_started_at/processed_at/failed_at/last_error) and only
-- treating an event as "already handled" when processed_at is set.
--
-- 2. get_organization_billing_summary() never returned
-- stripe_current_period_end (added in 20260811165350, after this
-- function was last defined) - the billing card had nothing correct to
-- show for a real Stripe subscription's renewal date and was falling
-- back to the older, manually-set billing_cycle_anchor.

-- ---------------------------------------------------------------------
-- 1. Webhook event lifecycle columns.
-- ---------------------------------------------------------------------
alter table public.stripe_webhook_events
  add column processing_started_at timestamptz,
  add column processed_at timestamptz,
  add column failed_at timestamptz,
  add column last_error text;

-- Atomically claims an event for processing: a fresh event_id inserts
-- normally; a conflicting event_id that was already fully processed
-- (processed_at is not null) is left untouched and reported back as
-- already-processed; a conflicting event_id that previously failed or
-- never finished (processed_at is null) is reclaimed for another attempt.
-- The WHERE clause on the ON CONFLICT DO UPDATE is what makes this safe -
-- Postgres only performs (and returns) the update when it matches, so
-- "no row returned" and "already processed" are the same case by
-- construction, not two branches that could drift apart.
create or replace function public.claim_stripe_webhook_event(
  new_event_id text,
  new_event_type text,
  new_organization_id uuid
)
returns table (already_processed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id text;
begin
  insert into public.stripe_webhook_events (event_id, event_type, organization_id, processing_started_at)
  values (new_event_id, new_event_type, new_organization_id, now())
  on conflict (event_id) do update
    set processing_started_at = now(),
        event_type = excluded.event_type,
        organization_id = coalesce(excluded.organization_id, stripe_webhook_events.organization_id)
    where stripe_webhook_events.processed_at is null
  returning event_id into claimed_id;

  return query select claimed_id is null;
end;
$$;

revoke all on function public.claim_stripe_webhook_event(text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. get_organization_billing_summary(): add stripe_current_period_end
-- (and _start, for symmetry) so the billing card can show the real
-- Stripe-driven renewal date instead of the older manual
-- billing_cycle_anchor.
-- ---------------------------------------------------------------------
drop function if exists public.get_organization_billing_summary(uuid);

create function public.get_organization_billing_summary(target_organization_id uuid)
returns table (
  organization_id uuid,
  effective_status public.subscription_status,
  plan_id uuid,
  plan_key text,
  plan_name text,
  plan_version integer,
  monthly_price_cents integer,
  annual_price_cents integer,
  custom_monthly_price_cents integer,
  custom_annual_price_cents integer,
  is_complimentary boolean,
  billing_cycle text,
  billing_cycle_anchor date,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  max_active_clients integer,
  max_active_caregivers integer,
  max_administrators integer,
  max_completed_visits integer,
  override_max_active_clients integer,
  override_max_active_caregivers integer,
  override_max_administrators integer,
  override_reason text,
  override_expires_at timestamptz,
  report_retention_days integer,
  bulk_export_limit integer,
  support_level text,
  sms_allowance integer,
  features text[],
  active_clients integer,
  active_caregivers integer,
  administrators integer,
  completed_visits integer,
  stripe_configured boolean,
  stripe_current_period_start timestamptz,
  stripe_current_period_end timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    public.get_effective_subscription_status(o.id),
    p.id, p.plan_key, p.name, p.version,
    p.monthly_price_cents, p.annual_price_cents,
    o.custom_monthly_price_cents, o.custom_annual_price_cents, o.is_complimentary,
    o.billing_cycle, o.billing_cycle_anchor,
    o.trial_started_at, o.trial_ends_at,
    p.max_active_clients, p.max_active_caregivers, p.max_administrators, p.max_completed_visits,
    o.override_max_active_clients, o.override_max_active_caregivers, o.override_max_administrators,
    o.override_reason, o.override_expires_at,
    p.report_retention_days, p.bulk_export_limit, p.support_level, p.sms_allowance, p.features,
    usage.active_clients, usage.active_caregivers, usage.administrators, usage.completed_visits,
    o.stripe_customer_id is not null,
    o.stripe_current_period_start,
    o.stripe_current_period_end
  from public.organizations o
  left join public.plan_definitions p on p.id = o.plan_definition_id
  cross join lateral public.get_organization_usage(o.id) usage
  where o.id = target_organization_id
    and public.has_permission(target_organization_id, 'settings.read');
$$;

revoke all on function public.get_organization_billing_summary(uuid) from public, anon;
grant execute on function public.get_organization_billing_summary(uuid) to authenticated;

commit;
