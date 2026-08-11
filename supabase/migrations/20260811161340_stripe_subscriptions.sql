begin;

-- Real Stripe subscriptions, attached to an organization and driving its
-- plan (organizations.plan_definition_id already exists and already
-- controls limits/feature access via get_organization_effective_limits() -
-- see 20260809162000_billing_usage_enforcement.sql - this just gives it a
-- real, Stripe-driven writer instead of only the platform owner's manual
-- migrate_organization_plan()).

-- ---------------------------------------------------------------------
-- 1. plan_definitions gets the Stripe Price IDs the platform owner
-- creates directly in the Stripe Dashboard (Products/Prices are not
-- created via API here - a human deciding what a real, chargeable price
-- actually is belongs in Stripe's own UI, not automated). Nullable - a
-- plan with no price ids attached simply can't be checked out yet.
-- ---------------------------------------------------------------------
alter table public.plan_definitions
  add column stripe_monthly_price_id text,
  add column stripe_annual_price_id text;

-- Extending upsert_plan_definition() with the two new fields as trailing,
-- defaulted params - existing callers omitting them are unaffected.
create or replace function public.upsert_plan_definition(
  target_plan_key text,
  new_name text,
  new_description text,
  new_monthly_price_cents integer,
  new_annual_price_cents integer,
  new_max_active_clients integer,
  new_max_active_caregivers integer,
  new_max_administrators integer,
  new_max_completed_visits integer,
  new_report_retention_days integer,
  new_bulk_export_limit integer,
  new_support_level text,
  new_sms_allowance integer,
  new_features text[],
  new_is_trial boolean,
  new_trial_duration_days integer,
  new_is_public boolean,
  new_is_introductory boolean,
  change_reason text,
  new_stripe_monthly_price_id text default null,
  new_stripe_annual_price_id text default null
)
returns public.plan_definitions
language plpgsql
security definer
set search_path = public
as $$
declare
  previous public.plan_definitions;
  next_version integer;
  created public.plan_definitions;
begin
  if not public.is_platform_owner() then
    raise exception 'Only the platform owner can edit plans';
  end if;
  if length(btrim(coalesce(change_reason, ''))) = 0 then
    raise exception 'A reason is required to change a plan';
  end if;

  select * into previous from public.plan_definitions
  where plan_key = target_plan_key and is_current = true;

  next_version := coalesce(previous.version, 0) + 1;

  if previous.id is not null then
    update public.plan_definitions set is_current = false where id = previous.id;
  end if;

  insert into public.plan_definitions (
    plan_key, version, name, description, monthly_price_cents, annual_price_cents,
    max_active_clients, max_active_caregivers, max_administrators, max_completed_visits,
    report_retention_days, bulk_export_limit, support_level, sms_allowance, features,
    is_trial, trial_duration_days, is_public, is_active, is_current, is_introductory, created_by,
    stripe_monthly_price_id, stripe_annual_price_id
  ) values (
    target_plan_key, next_version, new_name, new_description, new_monthly_price_cents, new_annual_price_cents,
    new_max_active_clients, new_max_active_caregivers, new_max_administrators, new_max_completed_visits,
    new_report_retention_days, new_bulk_export_limit, coalesce(new_support_level, 'standard'), coalesce(new_sms_allowance, 0),
    coalesce(new_features, '{}'), coalesce(new_is_trial, false), new_trial_duration_days,
    coalesce(new_is_public, true), true, true, coalesce(new_is_introductory, false), auth.uid(),
    new_stripe_monthly_price_id, new_stripe_annual_price_id
  ) returning * into created;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, old_values, new_values
  ) values (
    null, auth.uid(), 'billing.plan_versioned', 'plan_definitions', created.id::text, 'application', change_reason,
    to_jsonb(previous), to_jsonb(created)
  );

  return created;
end;
$$;

revoke all on function public.upsert_plan_definition(
  text, text, text, integer, integer, integer, integer, integer, integer, integer, integer, text, integer,
  text[], boolean, integer, boolean, boolean, text, text, text
) from public, anon;
grant execute on function public.upsert_plan_definition(
  text, text, text, integer, integer, integer, integer, integer, integer, integer, integer, text, integer,
  text[], boolean, integer, boolean, boolean, text, text, text
) to authenticated;

-- ---------------------------------------------------------------------
-- 2. prevent_tenant_subscription_edit() (20260807133158) fires on every
-- update to organizations regardless of role or SECURITY DEFINER context
-- - triggers aren't bypassed by privilege escalation the way RLS is. The
-- Stripe webhook handler below runs as the service role (auth.uid() is
-- null there), so is_platform_owner() would always be false and this
-- trigger would block it. Add a narrow, session-scoped escape hatch that
-- only record_stripe_subscription_event() below sets - not a general
-- weakening of the guard.
-- ---------------------------------------------------------------------
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
  ) then
    raise exception 'Only platform staff can change subscription or billing fields';
  end if;
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. record_stripe_subscription_event: the only writer of organizations'
-- Stripe columns + plan_definition_id + subscription_status from a
-- Stripe event. Callable only by the service role - no grant to
-- `authenticated` at all, so no browser session (however privileged) can
-- call this directly; only the stripe-webhook edge function's
-- service-role Supabase client can.
-- ---------------------------------------------------------------------
create or replace function public.record_stripe_subscription_event(
  target_organization_id uuid,
  new_stripe_customer_id text,
  new_stripe_subscription_id text,
  new_stripe_price_id text,
  new_subscription_status public.subscription_status
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_plan public.plan_definitions;
  updated public.organizations;
begin
  select * into matched_plan from public.plan_definitions
  where (stripe_monthly_price_id = new_stripe_price_id or stripe_annual_price_id = new_stripe_price_id)
    and is_current = true
  limit 1;

  perform set_config('app.bypass_subscription_guard', 'on', true);

  update public.organizations
  set stripe_customer_id = new_stripe_customer_id,
      stripe_subscription_id = new_stripe_subscription_id,
      stripe_price_id = new_stripe_price_id,
      plan_definition_id = coalesce(matched_plan.id, plan_definition_id),
      subscription_status = new_subscription_status
  where id = target_organization_id
  returning * into updated;

  perform set_config('app.bypass_subscription_guard', 'off', true);

  if updated.id is null then
    raise exception 'Organization not found';
  end if;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, new_values
  ) values (
    target_organization_id, null, 'billing.stripe_event_applied', 'organizations', target_organization_id::text, 'stripe',
    'Stripe subscription event',
    jsonb_build_object(
      'stripe_customer_id', new_stripe_customer_id,
      'stripe_subscription_id', new_stripe_subscription_id,
      'stripe_price_id', new_stripe_price_id,
      'subscription_status', new_subscription_status
    )
  );

  return updated;
end;
$$;

revoke all on function public.record_stripe_subscription_event(
  uuid, text, text, text, public.subscription_status
) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. get_organization_billing_summary's stripe_configured was always
-- hardcoded false (no Stripe integration existed yet). Now real.
-- ---------------------------------------------------------------------
create or replace function public.get_organization_billing_summary(target_organization_id uuid)
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
  stripe_configured boolean
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
    o.stripe_customer_id is not null
  from public.organizations o
  left join public.plan_definitions p on p.id = o.plan_definition_id
  cross join lateral public.get_organization_usage(o.id) usage
  where o.id = target_organization_id
    and public.has_permission(target_organization_id, 'settings.read');
$$;

revoke all on function public.get_organization_billing_summary(uuid) from public, anon;
grant execute on function public.get_organization_billing_summary(uuid) to authenticated;

commit;
