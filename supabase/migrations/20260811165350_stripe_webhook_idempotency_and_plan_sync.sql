begin;

-- Follow-up to 20260811161340_stripe_subscriptions.sql (unchanged, still
-- live as applied) - adds what the Netlify-Functions-based
-- integration needs that the original design didn't: webhook
-- idempotency, out-of-order-delivery safety, plan_key-based resolution
-- (instead of matching a Stripe price id against plan_definitions), and
-- syncing the legacy subscription_plan label so a paying agency never
-- keeps showing "Trial" in the platform registry.

-- ---------------------------------------------------------------------
-- 1. Billing-period + ordering columns on organizations.
-- ---------------------------------------------------------------------
alter table public.organizations
  add column stripe_current_period_start timestamptz,
  add column stripe_current_period_end timestamptz,
  add column stripe_synced_event_created_at timestamptz;

-- Extend the existing tenant-edit guard to cover the three new columns -
-- same pattern as every other Stripe column already guarded there.
create or replace function public.prevent_tenant_subscription_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_owner()
     and coalesce(current_setting('app.bypass_subscription_guard', true), 'off') <> 'on'
     and (
    NEW.subscription_plan is distinct from OLD.subscription_plan
    or NEW.subscription_status is distinct from OLD.subscription_status
    or NEW.billing_email is distinct from OLD.billing_email
    or NEW.trial_ends_at is distinct from OLD.trial_ends_at
    or NEW.storage_limit_gb is distinct from OLD.storage_limit_gb
    or NEW.plan_definition_id is distinct from OLD.plan_definition_id
    or NEW.trial_started_at is distinct from OLD.trial_started_at
    or NEW.billing_cycle is distinct from OLD.billing_cycle
    or NEW.billing_cycle_anchor is distinct from OLD.billing_cycle_anchor
    or NEW.custom_monthly_price_cents is distinct from OLD.custom_monthly_price_cents
    or NEW.custom_annual_price_cents is distinct from OLD.custom_annual_price_cents
    or NEW.override_max_active_clients is distinct from OLD.override_max_active_clients
    or NEW.override_max_active_caregivers is distinct from OLD.override_max_active_caregivers
    or NEW.override_max_administrators is distinct from OLD.override_max_administrators
    or NEW.is_complimentary is distinct from OLD.is_complimentary
    or NEW.override_reason is distinct from OLD.override_reason
    or NEW.override_expires_at is distinct from OLD.override_expires_at
    or NEW.stripe_customer_id is distinct from OLD.stripe_customer_id
    or NEW.stripe_subscription_id is distinct from OLD.stripe_subscription_id
    or NEW.stripe_price_id is distinct from OLD.stripe_price_id
    or NEW.stripe_current_period_start is distinct from OLD.stripe_current_period_start
    or NEW.stripe_current_period_end is distinct from OLD.stripe_current_period_end
    or NEW.stripe_synced_event_created_at is distinct from OLD.stripe_synced_event_created_at
  ) then
    raise exception 'Only platform staff can change subscription or billing fields';
  end if;
  return NEW;
end;
$$;
-- Note: this function's own EXECUTE grants were already locked down to
-- postgres/service_role only in 20260811161807/20260811161846 - a bare
-- CREATE OR REPLACE re-triggers Supabase's default-privilege auto-grant
-- (confirmed live this session), so re-apply the same revoke here rather
-- than relying on the earlier migration's grants surviving this replace.
revoke execute on function public.prevent_tenant_subscription_edit() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Webhook idempotency ledger. Stripe redelivers events on any
-- non-2xx response (including if our own processing throws after
-- partially applying something) - inserting the event id here BEFORE
-- processing, and treating a unique-violation as "already handled,"
-- makes the whole webhook handler safe to receive the same event twice.
-- No RLS policies - only the service role (which bypasses RLS entirely)
-- ever touches this table, same as how every other service-role-only
-- write in this app already works (see invite-member edge function).
-- ---------------------------------------------------------------------
create table public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  organization_id uuid references public.organizations(id) on delete set null,
  received_at timestamptz not null default now()
);
alter table public.stripe_webhook_events enable row level security;

-- ---------------------------------------------------------------------
-- 3. record_stripe_subscription_event, redesigned. Same service-role-only
-- function name and purpose as the original, different signature -
-- explicitly dropped and recreated rather than left as a dead overload.
--
-- Resolves the plan by plan_key (passed straight through from Stripe
-- event/subscription metadata - see create-checkout-session, which sets
-- metadata.plan_key = 'start' on both the Checkout Session and
-- subscription_data.metadata) instead of matching a Stripe price id
-- against plan_definitions - simpler, and doesn't depend on
-- plan_definitions.stripe_*_price_id being populated at all.
--
-- Also writes the legacy organizations.subscription_plan enum
-- ('starter') alongside plan_definition_id when the resolved plan is
-- 'start' and the status is active/trialing - list_platform_organizations()
-- (the platform registry's Plan column) still reads this older column,
-- and a paying agency must never keep showing "Trial" there.
--
-- Out-of-order safety: Stripe does not guarantee webhook delivery order.
-- If this organization already has a newer event's timestamp recorded
-- (stripe_synced_event_created_at), a late-arriving older event is a
-- silent no-op - the row is returned unchanged, not an error.
-- ---------------------------------------------------------------------
drop function if exists public.record_stripe_subscription_event(
  uuid, text, text, text, public.subscription_status
);

create function public.record_stripe_subscription_event(
  target_organization_id uuid,
  new_stripe_customer_id text,
  new_stripe_subscription_id text,
  new_stripe_price_id text,
  new_plan_key text,
  new_subscription_status public.subscription_status,
  new_current_period_start timestamptz,
  new_current_period_end timestamptz,
  new_event_id text,
  new_event_created_at timestamptz
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org public.organizations;
  matched_plan public.plan_definitions;
  updated public.organizations;
begin
  select * into target_org from public.organizations where id = target_organization_id;
  if target_org.id is null then
    raise exception 'Organization not found';
  end if;

  if target_org.stripe_synced_event_created_at is not null
     and new_event_created_at < target_org.stripe_synced_event_created_at then
    return target_org;
  end if;

  select * into matched_plan from public.plan_definitions
  where plan_key = new_plan_key and is_current = true;

  perform set_config('app.bypass_subscription_guard', 'on', true);

  update public.organizations
  set stripe_customer_id = new_stripe_customer_id,
      stripe_subscription_id = new_stripe_subscription_id,
      stripe_price_id = new_stripe_price_id,
      stripe_current_period_start = new_current_period_start,
      stripe_current_period_end = new_current_period_end,
      stripe_synced_event_created_at = new_event_created_at,
      plan_definition_id = coalesce(matched_plan.id, plan_definition_id),
      subscription_status = new_subscription_status,
      subscription_plan = case
        when new_plan_key = 'start' and new_subscription_status in ('active', 'trialing')
          then 'starter'::public.subscription_plan
        else subscription_plan
      end
  where id = target_organization_id
  returning * into updated;

  perform set_config('app.bypass_subscription_guard', 'off', true);

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, new_values
  ) values (
    target_organization_id, null, 'billing.stripe_event_applied', 'organizations', target_organization_id::text, 'stripe',
    'Stripe event ' || new_event_id,
    jsonb_build_object(
      'stripe_customer_id', new_stripe_customer_id,
      'stripe_subscription_id', new_stripe_subscription_id,
      'stripe_price_id', new_stripe_price_id,
      'plan_key', new_plan_key,
      'subscription_status', new_subscription_status,
      'current_period_start', new_current_period_start,
      'current_period_end', new_current_period_end,
      'stripe_event_id', new_event_id
    )
  );

  return updated;
end;
$$;

revoke all on function public.record_stripe_subscription_event(
  uuid, text, text, text, text, public.subscription_status, timestamptz, timestamptz, text, timestamptz
) from public, anon, authenticated;

commit;
