begin;

-- Billing v2: a real versioned plan catalog plus subscriber-level fields
-- on organizations. The pre-existing subscription_plan enum
-- (trial/starter/professional/enterprise) and set_organization_subscription()
-- RPC are left untouched (still valid, still used by the platform
-- registry's Plan/Status columns) - they simply become the legacy
-- coarse label, superseded for anything price/limit/feature-related by
-- plan_definitions + organizations.plan_definition_id below. Nothing
-- here duplicates clients/caregivers/authorizations/visits - it only
-- adds the subscription layer those already-working features didn't
-- have.

-- ---------------------------------------------------------------------
-- 1. plan_definitions: versioned catalog. Editing a plan never mutates
-- a row in place - see upsert_plan_definition() below - it inserts a
-- new version and flips is_current, so an organization already pinned
-- to a specific plan_definition_id is never silently changed underneath
-- it (Phase 6).
-- ---------------------------------------------------------------------
create table public.plan_definitions (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null,
  version integer not null,
  name text not null,
  description text,
  monthly_price_cents integer not null,
  annual_price_cents integer not null,
  max_active_clients integer,
  max_active_caregivers integer,
  max_administrators integer,
  max_completed_visits integer,
  report_retention_days integer,
  bulk_export_limit integer,
  support_level text not null default 'standard',
  sms_allowance integer not null default 0,
  features text[] not null default '{}',
  is_trial boolean not null default false,
  trial_duration_days integer,
  is_public boolean not null default true,
  is_active boolean not null default true,
  is_current boolean not null default true,
  is_introductory boolean not null default false,
  effective_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint plan_definitions_prices_check check (monthly_price_cents >= 0 and annual_price_cents >= 0),
  constraint plan_definitions_version_check check (version >= 1),
  constraint plan_definitions_support_level_check check (support_level in ('standard', 'priority', 'dedicated')),
  unique (plan_key, version)
);

-- At most one "current" version per plan_key - the version new
-- subscribers get and the one upsert_plan_definition() builds the next
-- version from.
create unique index plan_definitions_one_current_per_key
  on public.plan_definitions (plan_key)
  where is_current = true;

create index plan_definitions_key_idx on public.plan_definitions (plan_key, version desc);

alter table public.plan_definitions enable row level security;

-- Read-only via RLS; every write goes through upsert_plan_definition()/
-- retire_plan_definition() below (security definer, no direct
-- insert/update/delete policy) - same "mutation only through a
-- validated function" shape as service_visits.
create policy "read_plan_definitions"
on public.plan_definitions for select
to authenticated
using (public.is_platform_owner() or (is_public = true and is_active = true));

-- ---------------------------------------------------------------------
-- 2. organizations: subscriber-level fields. plan_definition_id is the
-- authoritative plan+version an org is pinned to; the legacy
-- subscription_plan enum is left alone. trial_started_at is set exactly
-- once (see create_organization() below and set_organization_trial()) -
-- "one trial per organization" is enforced by refusing to overwrite a
-- non-null trial_started_at rather than a separate boolean flag.
-- ---------------------------------------------------------------------
alter table public.organizations
  add column plan_definition_id uuid references public.plan_definitions(id),
  add column trial_started_at timestamptz,
  add column billing_cycle text,
  add column billing_cycle_anchor date,
  add column custom_monthly_price_cents integer,
  add column custom_annual_price_cents integer,
  add column override_max_active_clients integer,
  add column override_max_active_caregivers integer,
  add column override_max_administrators integer,
  add column is_complimentary boolean not null default false,
  add column override_reason text,
  add column override_expires_at timestamptz,
  add column stripe_customer_id text,
  add column stripe_subscription_id text,
  add column stripe_price_id text,
  add constraint organizations_billing_cycle_check check (billing_cycle is null or billing_cycle in ('monthly', 'annual'));

create unique index organizations_stripe_customer_id_unique
  on public.organizations (stripe_customer_id) where stripe_customer_id is not null;
create unique index organizations_stripe_subscription_id_unique
  on public.organizations (stripe_subscription_id) where stripe_subscription_id is not null;

-- Extend the existing tenant-edit guard (20260807133158) to cover every
-- new billing/subscriber column - without this, a tenant admin's plain
-- supabase.from('organizations').update(...) (already allowed for their
-- own row via authorized_update_organizations, which is column-agnostic)
-- could self-grant a custom price or a complimentary subscription.
create or replace function public.prevent_tenant_subscription_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_owner() and (
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
-- 3. audit_logs gains a reason column. Every billing/plan/override
-- mutation below writes an explicit row here (in addition to whatever
-- the generic write_audit_log() trigger already captures for the
-- organizations table's own before/after), specifically so "why" is
-- always on record next to "what changed" - the generic trigger only
-- ever captured a raw row diff, never a reason.
-- ---------------------------------------------------------------------
alter table public.audit_logs add column reason text;

-- ---------------------------------------------------------------------
-- 4. Seed data: Start/Grow/Pro/Scale (version 1, current) and the trial
-- "plan". All five share the same core feature set - higher paid plans
-- add support level, report history, and bulk-export capacity, never
-- remove signatures/corrections/audit history/reports.
-- ---------------------------------------------------------------------
insert into public.plan_definitions (
  plan_key, version, name, description, monthly_price_cents, annual_price_cents,
  max_active_clients, max_active_caregivers, max_administrators, max_completed_visits,
  report_retention_days, bulk_export_limit, support_level, sms_allowance, features,
  is_trial, trial_duration_days, is_public, is_active, is_current
) values
  (
    'trial', 1, 'Trial', 'Full-featured 6-week trial to evaluate CareLik.', 0, 0,
    10, 10, 2, 100,
    180, 100, 'standard', 0,
    array['client_caregiver_management','assignments','scheduling','service_codes','routing_sheets',
      'signatures','authorization_hours','hour_calculations','corrections_audit_history','branded_pdfs',
      'hours_by_client','hours_by_caregiver','pay_period_reports','dashboards'],
    true, 42, false, true, true
  ),
  (
    'start', 1, 'Start', 'For small agencies just getting started.', 2900, 29000,
    20, 15, 2, null,
    180, 500, 'standard', 0,
    array['client_caregiver_management','assignments','scheduling','service_codes','routing_sheets',
      'signatures','authorization_hours','hour_calculations','corrections_audit_history','branded_pdfs',
      'hours_by_client','hours_by_caregiver','pay_period_reports','dashboards'],
    false, null, true, true, true
  ),
  (
    'grow', 1, 'Grow', 'For growing agencies that need more seats.', 5900, 59000,
    50, 40, 5, null,
    365, 2000, 'standard', 0,
    array['client_caregiver_management','assignments','scheduling','service_codes','routing_sheets',
      'signatures','authorization_hours','hour_calculations','corrections_audit_history','branded_pdfs',
      'hours_by_client','hours_by_caregiver','pay_period_reports','dashboards','priority_support'],
    false, null, true, true, true
  ),
  (
    'pro', 1, 'Pro', 'For established agencies with higher volume.', 9900, 99000,
    100, 80, 10, null,
    730, 10000, 'priority', 50,
    array['client_caregiver_management','assignments','scheduling','service_codes','routing_sheets',
      'signatures','authorization_hours','hour_calculations','corrections_audit_history','branded_pdfs',
      'hours_by_client','hours_by_caregiver','pay_period_reports','dashboards','priority_support',
      'extended_report_history','bulk_export'],
    false, null, true, true, true
  ),
  (
    'scale', 1, 'Scale', 'For large multi-site agencies.', 17900, 179000,
    200, 160, 20, null,
    null, null, 'dedicated', 200,
    array['client_caregiver_management','assignments','scheduling','service_codes','routing_sheets',
      'signatures','authorization_hours','hour_calculations','corrections_audit_history','branded_pdfs',
      'hours_by_client','hours_by_caregiver','pay_period_reports','dashboards','priority_support',
      'extended_report_history','bulk_export','dedicated_support','sms_notifications'],
    false, null, true, true, true
  );

-- ---------------------------------------------------------------------
-- 5. Read helpers.
-- ---------------------------------------------------------------------

-- Effective status, computed rather than relying on a scheduled job to
-- flip subscription_status - a trial with no trial_ends_at (every
-- organization created before this migration) never trips this, so
-- existing organizations are entirely unaffected until a plan is
-- deliberately assigned to them.
create or replace function public.get_effective_subscription_status(target_organization_id uuid)
returns public.subscription_status
language sql
stable
security definer
set search_path = public
as $$
  select case
    when o.subscription_status = 'trialing' and o.trial_ends_at is not null and o.trial_ends_at < now()
      then 'trial_expired'::public.subscription_status
    else o.subscription_status
  end
  from public.organizations o
  where o.id = target_organization_id;
$$;

revoke all on function public.get_effective_subscription_status(uuid) from public, anon;
grant execute on function public.get_effective_subscription_status(uuid) to authenticated;

-- Current active-usage counts an organization's limits are measured
-- against. Archived/inactive/discharged clients and non-active
-- memberships are deliberately excluded - they stay searchable/
-- reportable/printable elsewhere, they just don't count here.
create or replace function public.get_organization_usage(target_organization_id uuid)
returns table (
  active_clients integer,
  active_caregivers integer,
  administrators integer,
  completed_visits integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::integer from public.clients
      where organization_id = target_organization_id and status = 'active' and deleted_at is null),
    (select count(*)::integer from public.organization_memberships
      where organization_id = target_organization_id and status = 'active'
        and role not in ('organization_owner', 'organization_admin')),
    (select count(*)::integer from public.organization_memberships
      where organization_id = target_organization_id and status = 'active'
        and role in ('organization_owner', 'organization_admin')),
    (select count(*)::integer from public.service_visits
      where organization_id = target_organization_id and status in ('signed', 'administrator_review'));
$$;

revoke all on function public.get_organization_usage(uuid) from public, anon;
grant execute on function public.get_organization_usage(uuid) to authenticated;

-- Everything the agency-facing Settings -> Billing page needs in one
-- call. Gated on settings.read (same permission that page already
-- lives behind) - platform-owner bypass comes free from has_permission().
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
    false
  from public.organizations o
  left join public.plan_definitions p on p.id = o.plan_definition_id
  cross join lateral public.get_organization_usage(o.id) usage
  where o.id = target_organization_id
    and public.has_permission(target_organization_id, 'settings.read');
$$;

revoke all on function public.get_organization_billing_summary(uuid) from public, anon;
grant execute on function public.get_organization_billing_summary(uuid) to authenticated;

-- All versions of every plan, for the platform-owner editor - the RLS
-- policy alone only ever shows the current+public+active row per key.
create or replace function public.list_all_plan_versions()
returns setof public.plan_definitions
language sql
stable
security definer
set search_path = public
as $$
  select p.* from public.plan_definitions p
  where public.is_platform_owner()
  order by p.plan_key, p.version desc;
$$;

revoke all on function public.list_all_plan_versions() from public, anon;
grant execute on function public.list_all_plan_versions() to authenticated;

-- ---------------------------------------------------------------------
-- 6. Platform-owner writes. Every one of these ends with an explicit
-- audit_logs insert carrying a reason, per Phase 5's "actor / org /
-- previous value / new value / reason / timestamp" requirement -
-- the generic write_audit_log() trigger on organizations still fires
-- too (full row diff), this is the human-readable "why" alongside it.
-- ---------------------------------------------------------------------

-- Editing a plan always creates a new version rather than mutating the
-- current row - pass every field each time (the frontend reads the
-- current version first, edits it, and resubmits the whole thing).
-- new_plan_key lets a brand-new plan be created the same way.
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
  change_reason text
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
    is_trial, trial_duration_days, is_public, is_active, is_current, is_introductory, created_by
  ) values (
    target_plan_key, next_version, new_name, new_description, new_monthly_price_cents, new_annual_price_cents,
    new_max_active_clients, new_max_active_caregivers, new_max_administrators, new_max_completed_visits,
    new_report_retention_days, new_bulk_export_limit, coalesce(new_support_level, 'standard'), coalesce(new_sms_allowance, 0),
    coalesce(new_features, '{}'), coalesce(new_is_trial, false), new_trial_duration_days,
    coalesce(new_is_public, true), true, true, coalesce(new_is_introductory, false), auth.uid()
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
  text[], boolean, integer, boolean, boolean, text
) from public, anon;
grant execute on function public.upsert_plan_definition(
  text, text, text, integer, integer, integer, integer, integer, integer, integer, integer, text, integer,
  text[], boolean, integer, boolean, boolean, text
) to authenticated;

-- Retires a plan (is_active = false) without deleting it - existing
-- subscribers already pinned to that plan_definition_id (or any earlier
-- version) keep their historical row intact for reporting; it just
-- stops being offered. A retired plan can still be its own is_current
-- version (deliberately not touched here) so a grandfathered
-- organization's summary keeps resolving correctly.
create or replace function public.retire_plan_definition(
  target_plan_key text,
  change_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_row public.plan_definitions;
begin
  if not public.is_platform_owner() then
    raise exception 'Only the platform owner can retire plans';
  end if;
  if length(btrim(coalesce(change_reason, ''))) = 0 then
    raise exception 'A reason is required to retire a plan';
  end if;

  select * into current_row from public.plan_definitions where plan_key = target_plan_key and is_current = true;
  if current_row.id is null then
    raise exception 'Plan not found';
  end if;

  update public.plan_definitions set is_active = false, is_public = false where id = current_row.id;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, old_values, new_values
  ) values (
    null, auth.uid(), 'billing.plan_retired', 'plan_definitions', current_row.id::text, 'application', change_reason,
    to_jsonb(current_row), jsonb_build_object('is_active', false, 'is_public', false)
  );
end;
$$;

revoke all on function public.retire_plan_definition(text, text) from public, anon;
grant execute on function public.retire_plan_definition(text, text) to authenticated;

-- Deliberately migrates one organization to a specific plan version -
-- never automatic, always a named version id and a reason. Moving to a
-- different version of the SAME plan_key (e.g. picking up a price
-- change) or to a different plan_key entirely both go through here.
create or replace function public.migrate_organization_plan(
  target_organization_id uuid,
  new_plan_definition_id uuid,
  change_reason text
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  previous public.organizations;
  updated public.organizations;
  target_plan public.plan_definitions;
begin
  if not public.is_platform_owner() then
    raise exception 'Only the platform owner can migrate an organization''s plan';
  end if;
  if length(btrim(coalesce(change_reason, ''))) = 0 then
    raise exception 'A reason is required to migrate an organization to a new plan';
  end if;

  select * into target_plan from public.plan_definitions where id = new_plan_definition_id;
  if target_plan.id is null then
    raise exception 'Plan version not found';
  end if;

  select * into previous from public.organizations where id = target_organization_id;
  if previous.id is null then
    raise exception 'Organization not found';
  end if;

  update public.organizations
  set plan_definition_id = new_plan_definition_id,
      subscription_status = case when subscription_status = 'trial_expired' then 'active' else subscription_status end
  where id = target_organization_id
  returning * into updated;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, old_values, new_values
  ) values (
    target_organization_id, auth.uid(), 'billing.plan_migrated', 'organizations', target_organization_id::text, 'application',
    change_reason,
    jsonb_build_object('plan_definition_id', previous.plan_definition_id, 'subscription_status', previous.subscription_status),
    jsonb_build_object('plan_definition_id', updated.plan_definition_id, 'subscription_status', updated.subscription_status)
  );

  return updated;
end;
$$;

revoke all on function public.migrate_organization_plan(uuid, uuid, text) from public, anon;
grant execute on function public.migrate_organization_plan(uuid, uuid, text) to authenticated;

-- Subscriber overrides: custom pricing, complimentary status, and
-- temporary client/staff/admin cap bumps - all optional, all nullable
-- (pass null to clear an override). override_expires_at is advisory
-- display only for now (nothing auto-clears it); the platform owner
-- clears an expired override manually by calling this again with nulls.
create or replace function public.set_organization_billing_override(
  target_organization_id uuid,
  new_custom_monthly_price_cents integer,
  new_custom_annual_price_cents integer,
  new_override_max_active_clients integer,
  new_override_max_active_caregivers integer,
  new_override_max_administrators integer,
  new_is_complimentary boolean,
  new_override_reason text,
  new_override_expires_at timestamptz,
  change_reason text
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  previous public.organizations;
  updated public.organizations;
begin
  if not public.is_platform_owner() then
    raise exception 'Only the platform owner can set a subscriber override';
  end if;
  if length(btrim(coalesce(change_reason, ''))) = 0 then
    raise exception 'A reason is required to change a subscriber override';
  end if;

  select * into previous from public.organizations where id = target_organization_id;
  if previous.id is null then
    raise exception 'Organization not found';
  end if;

  update public.organizations
  set custom_monthly_price_cents = new_custom_monthly_price_cents,
      custom_annual_price_cents = new_custom_annual_price_cents,
      override_max_active_clients = new_override_max_active_clients,
      override_max_active_caregivers = new_override_max_active_caregivers,
      override_max_administrators = new_override_max_administrators,
      is_complimentary = coalesce(new_is_complimentary, false),
      override_reason = new_override_reason,
      override_expires_at = new_override_expires_at
  where id = target_organization_id
  returning * into updated;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, old_values, new_values
  ) values (
    target_organization_id, auth.uid(), 'billing.override_set', 'organizations', target_organization_id::text, 'application',
    change_reason,
    jsonb_build_object(
      'custom_monthly_price_cents', previous.custom_monthly_price_cents,
      'custom_annual_price_cents', previous.custom_annual_price_cents,
      'override_max_active_clients', previous.override_max_active_clients,
      'override_max_active_caregivers', previous.override_max_active_caregivers,
      'override_max_administrators', previous.override_max_administrators,
      'is_complimentary', previous.is_complimentary
    ),
    jsonb_build_object(
      'custom_monthly_price_cents', updated.custom_monthly_price_cents,
      'custom_annual_price_cents', updated.custom_annual_price_cents,
      'override_max_active_clients', updated.override_max_active_clients,
      'override_max_active_caregivers', updated.override_max_active_caregivers,
      'override_max_administrators', updated.override_max_administrators,
      'is_complimentary', updated.is_complimentary
    )
  );

  return updated;
end;
$$;

revoke all on function public.set_organization_billing_override(
  uuid, integer, integer, integer, integer, integer, boolean, text, timestamptz, text
) from public, anon;
grant execute on function public.set_organization_billing_override(
  uuid, integer, integer, integer, integer, integer, boolean, text, timestamptz, text
) to authenticated;

-- Sets billing cycle (monthly/annual) and its anchor date - platform-
-- owner-only, same audit shape as the others.
create or replace function public.set_organization_billing_cycle(
  target_organization_id uuid,
  new_billing_cycle text,
  new_billing_cycle_anchor date,
  change_reason text
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  previous public.organizations;
  updated public.organizations;
begin
  if not public.is_platform_owner() then
    raise exception 'Only the platform owner can set a subscriber''s billing cycle';
  end if;
  if new_billing_cycle is not null and new_billing_cycle not in ('monthly', 'annual') then
    raise exception 'Billing cycle must be monthly or annual';
  end if;
  if length(btrim(coalesce(change_reason, ''))) = 0 then
    raise exception 'A reason is required to change a billing cycle';
  end if;

  select * into previous from public.organizations where id = target_organization_id;
  if previous.id is null then
    raise exception 'Organization not found';
  end if;

  update public.organizations
  set billing_cycle = new_billing_cycle, billing_cycle_anchor = new_billing_cycle_anchor
  where id = target_organization_id
  returning * into updated;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, old_values, new_values
  ) values (
    target_organization_id, auth.uid(), 'billing.cycle_changed', 'organizations', target_organization_id::text, 'application',
    change_reason,
    jsonb_build_object('billing_cycle', previous.billing_cycle, 'billing_cycle_anchor', previous.billing_cycle_anchor),
    jsonb_build_object('billing_cycle', updated.billing_cycle, 'billing_cycle_anchor', updated.billing_cycle_anchor)
  );

  return updated;
end;
$$;

revoke all on function public.set_organization_billing_cycle(uuid, text, date, text) from public, anon;
grant execute on function public.set_organization_billing_cycle(uuid, text, date, text) to authenticated;

-- Starts (or, with allow_restart, deliberately restarts) an
-- organization's trial. "One trial per organization" is enforced by
-- refusing a second start unless allow_restart is explicitly true -
-- every call is audited either way.
create or replace function public.set_organization_trial(
  target_organization_id uuid,
  trial_duration_days integer,
  allow_restart boolean,
  change_reason text
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  previous public.organizations;
  updated public.organizations;
  trial_plan public.plan_definitions;
begin
  if not public.is_platform_owner() then
    raise exception 'Only the platform owner can start or change a trial';
  end if;
  if length(btrim(coalesce(change_reason, ''))) = 0 then
    raise exception 'A reason is required to start or change a trial';
  end if;

  select * into previous from public.organizations where id = target_organization_id;
  if previous.id is null then
    raise exception 'Organization not found';
  end if;
  if previous.trial_started_at is not null and not coalesce(allow_restart, false) then
    raise exception 'This organization has already used its trial - pass allow_restart to override';
  end if;

  select * into trial_plan from public.plan_definitions where plan_key = 'trial' and is_current = true;

  update public.organizations
  set plan_definition_id = coalesce(trial_plan.id, plan_definition_id),
      trial_started_at = now(),
      trial_ends_at = now() + make_interval(days => coalesce(trial_duration_days, trial_plan.trial_duration_days, 42)),
      subscription_status = 'trialing'
  where id = target_organization_id
  returning * into updated;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, entity_type, entity_id, source, reason, old_values, new_values
  ) values (
    target_organization_id, auth.uid(), 'billing.trial_set', 'organizations', target_organization_id::text, 'application',
    change_reason,
    jsonb_build_object('trial_started_at', previous.trial_started_at, 'trial_ends_at', previous.trial_ends_at),
    jsonb_build_object('trial_started_at', updated.trial_started_at, 'trial_ends_at', updated.trial_ends_at)
  );

  return updated;
end;
$$;

revoke all on function public.set_organization_trial(uuid, integer, boolean, text) from public, anon;
grant execute on function public.set_organization_trial(uuid, integer, boolean, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. New organizations start on the current trial plan automatically -
-- "one trial per organization", set once, here, at creation.
-- ---------------------------------------------------------------------
create or replace function public.create_organization(
  slug text,
  legal_name text,
  display_name text,
  timezone text default 'America/Los_Angeles',
  country_code text default 'US',
  dba text default null,
  tax_id text default null,
  business_license text default null,
  org_type text default null,
  website text default null,
  currency text default 'USD',
  agency_code text default null,
  address_street text default null,
  address_suite text default null,
  address_city text default null,
  address_state text default null,
  address_zip text default null,
  address_country text default null,
  primary_contact_name text default null,
  contact_email text default null,
  contact_phone text default null,
  emergency_phone text default null,
  logo_url text default null,
  primary_color text default null,
  secondary_color text default null,
  accent_color text default null,
  theme_mode text default 'light',
  default_services text[] default '{}'
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  new_organization public.organizations;
  service_name text;
  trial_plan public.plan_definitions;
begin
  if not public.is_platform_owner() then
    raise exception 'Only a platform owner can create organizations';
  end if;

  select * into trial_plan from public.plan_definitions where plan_key = 'trial' and is_current = true;

  insert into public.organizations (
    slug, legal_name, display_name, timezone, country_code,
    dba, tax_id, business_license, org_type, website, currency, agency_code,
    address_street, address_suite, address_city, address_state, address_zip, address_country,
    primary_contact_name, contact_email, contact_phone, emergency_phone,
    logo_url, primary_color, secondary_color, accent_color, theme_mode,
    plan_definition_id, trial_started_at, trial_ends_at,
    created_by, updated_by
  )
  values (
    slug, legal_name, display_name, timezone, country_code,
    dba, tax_id, business_license, org_type, website, coalesce(currency, 'USD'), agency_code,
    address_street, address_suite, address_city, address_state, address_zip, address_country,
    primary_contact_name, contact_email, contact_phone, emergency_phone,
    logo_url, primary_color, secondary_color, accent_color, coalesce(theme_mode, 'light'),
    trial_plan.id, now(), now() + make_interval(days => coalesce(trial_plan.trial_duration_days, 42)),
    auth.uid(), auth.uid()
  )
  returning * into new_organization;

  insert into public.organization_memberships (
    organization_id, user_id, role, status, joined_at
  )
  values (
    new_organization.id, auth.uid(), 'organization_owner', 'active', now()
  );

  foreach service_name in array coalesce(default_services, '{}') loop
    if trim(service_name) <> '' then
      insert into public.services (organization_id, name, code, created_by, updated_by)
      values (
        new_organization.id, trim(service_name),
        upper(left(regexp_replace(trim(service_name), '[^a-zA-Z0-9]', '', 'g'), 12)),
        auth.uid(), auth.uid()
      )
      on conflict do nothing;
    end if;
  end loop;

  return new_organization;
end;
$$;

commit;
