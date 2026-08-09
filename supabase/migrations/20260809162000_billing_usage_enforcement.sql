begin;

-- Usage-limit and trial/subscription-status enforcement, all
-- server-side - the React UI's own checks (Phase 4/10) are a courtesy
-- for a fast error message, never the actual gate. Nothing here trusts
-- an organization_id, role, or usage count supplied by the browser -
-- every function below re-derives it from the database.

-- ---------------------------------------------------------------------
-- 1. Effective-limit helper: an override always wins over the plan's
-- own limit when present and not expired; a null limit (plan or
-- override) means unlimited.
-- ---------------------------------------------------------------------
create or replace function public.get_organization_effective_limits(target_organization_id uuid)
returns table (
  max_active_clients integer,
  max_active_caregivers integer,
  max_administrators integer,
  max_completed_visits integer,
  effective_status public.subscription_status,
  is_trial boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    case when o.override_expires_at is not null and o.override_expires_at < now() then p.max_active_clients
         else coalesce(o.override_max_active_clients, p.max_active_clients) end,
    case when o.override_expires_at is not null and o.override_expires_at < now() then p.max_active_caregivers
         else coalesce(o.override_max_active_caregivers, p.max_active_caregivers) end,
    case when o.override_expires_at is not null and o.override_expires_at < now() then p.max_administrators
         else coalesce(o.override_max_administrators, p.max_administrators) end,
    p.max_completed_visits,
    public.get_effective_subscription_status(o.id),
    coalesce(p.is_trial, false)
  from public.organizations o
  left join public.plan_definitions p on p.id = o.plan_definition_id
  where o.id = target_organization_id;
$$;

revoke all on function public.get_organization_effective_limits(uuid) from public, anon;
grant execute on function public.get_organization_effective_limits(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Write gate: blocks new clients/assignments/schedules/visits/
-- signatures once an organization's effective status is trial_expired,
-- suspended, or canceled - reads (existing records, print, export)
-- are never touched, since this only ever fires on INSERT. A trial's
-- separate completed-visit cap is checked here too, specifically for
-- new service_visits rows, since that cap can be hit before the trial's
-- calendar end date.
-- ---------------------------------------------------------------------
create or replace function public.assert_organization_billing_write_allowed(
  target_organization_id uuid,
  resource text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  limits record;
  completed_visits integer;
begin
  select * into limits from public.get_organization_effective_limits(target_organization_id);
  if limits.effective_status is null then
    raise exception 'Organization not found';
  end if;

  if limits.effective_status = 'trial_expired' then
    raise exception 'TRIAL_EXPIRED: Your trial has ended. Existing records remain available to view, print, and export - contact your administrator to upgrade and keep adding new %.', resource;
  end if;

  if limits.effective_status in ('suspended', 'canceled') then
    raise exception 'SUBSCRIPTION_INACTIVE: This organization''s subscription is % - contact your administrator to reactivate before adding new %.', limits.effective_status, resource;
  end if;

  if resource = 'service_visits' and limits.is_trial and limits.max_completed_visits is not null then
    select count(*) into completed_visits
    from public.service_visits
    where organization_id = target_organization_id
      and status in ('signed', 'administrator_review');
    if completed_visits >= limits.max_completed_visits then
      raise exception 'LIMIT_REACHED: Maximum trial visits reached (%). Upgrade your plan to record more visits.', limits.max_completed_visits;
    end if;
  end if;
end;
$$;

revoke all on function public.assert_organization_billing_write_allowed(uuid, text) from public, anon, authenticated;

-- Thin trigger wrapper - TG_ARGV carries which resource is being
-- written so one function serves every gated table.
create or replace function public.trg_assert_billing_write_allowed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_organization_billing_write_allowed(NEW.organization_id, TG_ARGV[0]);
  return NEW;
end;
$$;

revoke all on function public.trg_assert_billing_write_allowed() from public, anon, authenticated;

create trigger clients_billing_gate
before insert on public.clients
for each row execute function public.trg_assert_billing_write_allowed('clients');

create trigger caregiver_assignments_billing_gate
before insert on public.caregiver_assignments
for each row execute function public.trg_assert_billing_write_allowed('caregiver_assignments');

create trigger shifts_billing_gate
before insert on public.shifts
for each row execute function public.trg_assert_billing_write_allowed('shifts');

create trigger service_visits_billing_gate
before insert on public.service_visits
for each row execute function public.trg_assert_billing_write_allowed('service_visits');

create trigger visit_signatures_billing_gate
before insert on public.visit_signatures
for each row execute function public.trg_assert_billing_write_allowed('visit_signatures');

-- ---------------------------------------------------------------------
-- 3. Active-client limit: fires only when a row is becoming active
-- (a fresh active insert, or a reactivation from inactive/discharged).
-- An advisory lock keyed on the organization serializes concurrent
-- attempts against the same cap - two simultaneous "add client"
-- requests can't both slip through count-then-insert.
-- ---------------------------------------------------------------------
create or replace function public.enforce_client_active_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  becoming_active boolean;
  limits record;
  current_count integer;
begin
  becoming_active := (NEW.status = 'active') and (TG_OP = 'INSERT' or OLD.status is distinct from 'active');
  if not becoming_active then
    return NEW;
  end if;

  perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text || ':clients'));

  select * into limits from public.get_organization_effective_limits(NEW.organization_id);

  if limits.max_active_clients is not null then
    select count(*) into current_count
    from public.clients
    where organization_id = NEW.organization_id
      and status = 'active'
      and deleted_at is null
      and id is distinct from NEW.id;

    if current_count >= limits.max_active_clients then
      raise exception 'LIMIT_REACHED: Maximum active clients reached (%). Upgrade your plan or archive an existing client to add another.', limits.max_active_clients;
    end if;
  end if;

  return NEW;
end;
$$;

revoke all on function public.enforce_client_active_limit() from public, anon, authenticated;

create trigger clients_enforce_active_limit
before insert or update on public.clients
for each row execute function public.enforce_client_active_limit();

-- ---------------------------------------------------------------------
-- 4. Administrator / caregiver seat limits, same locking pattern,
-- bucketed by role. platform_owner rows are never part of any
-- organization's seat count.
-- ---------------------------------------------------------------------
create or replace function public.enforce_membership_active_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  becoming_active boolean;
  is_admin_role boolean;
  limits record;
  current_count integer;
begin
  if NEW.role = 'platform_owner' then
    return NEW;
  end if;

  becoming_active := (NEW.status = 'active')
    and (TG_OP = 'INSERT' or OLD.status is distinct from 'active' or OLD.role is distinct from NEW.role);
  if not becoming_active then
    return NEW;
  end if;

  perform pg_advisory_xact_lock(hashtext(NEW.organization_id::text || ':memberships'));

  select * into limits from public.get_organization_effective_limits(NEW.organization_id);
  is_admin_role := NEW.role in ('organization_owner', 'organization_admin');

  if is_admin_role and limits.max_administrators is not null then
    select count(*) into current_count
    from public.organization_memberships
    where organization_id = NEW.organization_id
      and status = 'active'
      and role in ('organization_owner', 'organization_admin')
      and id is distinct from NEW.id;

    if current_count >= limits.max_administrators then
      raise exception 'LIMIT_REACHED: Maximum administrators reached (%). Upgrade your plan to add more.', limits.max_administrators;
    end if;
  elsif not is_admin_role and limits.max_active_caregivers is not null then
    select count(*) into current_count
    from public.organization_memberships
    where organization_id = NEW.organization_id
      and status = 'active'
      and role not in ('organization_owner', 'organization_admin')
      and id is distinct from NEW.id;

    if current_count >= limits.max_active_caregivers then
      raise exception 'LIMIT_REACHED: Maximum caregivers/staff reached (%). Upgrade your plan to add more.', limits.max_active_caregivers;
    end if;
  end if;

  return NEW;
end;
$$;

revoke all on function public.enforce_membership_active_limit() from public, anon, authenticated;

create trigger organization_memberships_enforce_active_limit
before insert or update on public.organization_memberships
for each row execute function public.enforce_membership_active_limit();

-- ---------------------------------------------------------------------
-- 5. Trial reminders at 14/7/3/1 days before expiration. Queued as
-- domain_events, same outbox/idempotency-key pattern as
-- queue_document_reminders() (20260728060000) - no email/SMS provider
-- is configured anywhere in this codebase, so like that function this
-- stops at "correctly computed and queued", and is NOT wired to
-- cron.schedule here (pg_cron/pg_net are already enabled for the
-- existing document-reminder job; scheduling this one too is a
-- deliberate go/no-go left to the platform owner, same reasoning as
-- that migration's own note).
-- ---------------------------------------------------------------------
create or replace function public.queue_trial_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_queued integer := 0;
  v_org record;
  v_days_out integer;
begin
  for v_org in
    select o.id, o.trial_ends_at, o.display_name
    from public.organizations o
    where o.subscription_status = 'trialing'
      and o.trial_ends_at is not null
      and o.trial_ends_at > now()
      and o.deleted_at is null
  loop
    v_days_out := ceil(extract(epoch from (v_org.trial_ends_at - now())) / 86400.0)::integer;
    if v_days_out in (14, 7, 3, 1) then
      insert into public.domain_events (
        organization_id, event_type, aggregate_type, aggregate_id, payload, metadata, idempotency_key
      ) values (
        v_org.id,
        'billing.trial_reminder_due',
        'organization',
        v_org.id::text,
        jsonb_build_object('days_remaining', v_days_out, 'trial_ends_at', v_org.trial_ends_at),
        '{}'::jsonb,
        'trial_reminder:' || v_org.id || ':' || v_days_out
      )
      on conflict (organization_id, idempotency_key) do nothing;
      v_queued := v_queued + 1;
    end if;
  end loop;

  return v_queued;
end;
$$;

revoke all on function public.queue_trial_reminders() from public, anon, authenticated;

commit;
