begin;

-- Billing needs a $/hour rate to turn signed-visit minutes into a dollar
-- amount, and no rate exists anywhere in the schema today (services is a
-- name catalog only, client_authorizations only tracks hour caps). Rate
-- lives on the authorization, not the service, because different payers
-- (private pay, county programs, regional centers) pay different rates
-- for the same service - exactly the payer diversity this org already
-- has. Nullable: an authorization predating this column, or one nobody's
-- gotten around to pricing yet, just can't be billed for a dollar amount
-- until someone sets it (worked/billable minutes still track fine either
-- way, same as today).
alter table public.client_authorizations
  add column hourly_rate_cents integer,
  add constraint client_authorizations_hourly_rate_check check (hourly_rate_cents is null or hourly_rate_cents >= 0);

-- The direct-edit guard added by 20260812185651 didn't know about this
-- column yet - without this, a hurried caller could change the rate with
-- a plain UPDATE, bypassing the same amend-and-version trail every other
-- authorization term already requires.
create or replace function public.prevent_direct_authorization_edit()
returns trigger
language plpgsql
as $$
begin
  if NEW.max_monthly_hours is distinct from OLD.max_monthly_hours
     or NEW.period_start is distinct from OLD.period_start
     or NEW.period_end is distinct from OLD.period_end
     or NEW.payer is distinct from OLD.payer
     or NEW.authorization_number is distinct from OLD.authorization_number
     or NEW.notes is distinct from OLD.notes
     or NEW.client_id is distinct from OLD.client_id
     or NEW.service_id is distinct from OLD.service_id
     or NEW.hourly_rate_cents is distinct from OLD.hourly_rate_cents
  then
    raise exception 'Authorization terms cannot be edited directly - use amend_client_authorization() to record a new version';
  end if;
  return NEW;
end;
$$;

-- Appending an optional trailing parameter - CREATE OR REPLACE allows this
-- without a signature change (no drop needed, unlike list_client_authorizations
-- below whose *output* column list changes).
create or replace function public.amend_client_authorization(
  target_authorization_id uuid,
  new_max_monthly_hours numeric,
  new_period_start date,
  new_period_end date,
  new_payer text,
  new_authorization_number text default null,
  new_notes text default null,
  reason text default null,
  received_date date default null,
  source_reference text default null,
  new_hourly_rate_cents integer default null
)
returns table (
  new_authorization_id uuid,
  new_version_number integer,
  affected_visit_id uuid,
  affected_visit_status public.service_visit_status,
  affected_service_date date,
  affected_worked_minutes integer,
  affected_billable_minutes integer,
  affected_old_cap_minutes integer,
  affected_new_cap_minutes integer,
  impact_kind text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  old_auth public.client_authorizations%rowtype;
  new_id uuid;
  new_version integer;
  old_cap_minutes integer;
  new_cap_minutes integer;
  moved_up boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if new_period_end <= new_period_start then
    raise exception 'Period end must be after period start';
  end if;
  if new_max_monthly_hours < 0 then
    raise exception 'Max monthly hours cannot be negative';
  end if;
  if new_hourly_rate_cents is not null and new_hourly_rate_cents < 0 then
    raise exception 'Hourly rate cannot be negative';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to amend an authorization';
  end if;

  select * into old_auth from public.client_authorizations
  where id = target_authorization_id for update;

  if old_auth.id is null then
    raise exception 'Authorization not found';
  end if;
  if not public.has_permission(old_auth.organization_id, 'authorizations.update') then
    raise exception 'You do not have permission to amend authorizations for this organization';
  end if;
  if not old_auth.is_current then
    raise exception 'This authorization has already been superseded by a later amendment';
  end if;
  if old_auth.deleted_at is not null then
    raise exception 'This authorization has been removed';
  end if;

  new_version := old_auth.version_number + 1;
  old_cap_minutes := round(old_auth.max_monthly_hours * 60)::integer;
  new_cap_minutes := round(new_max_monthly_hours * 60)::integer;
  moved_up := new_cap_minutes > old_cap_minutes;

  -- Mark the old row non-current *before* inserting the new one - the
  -- unique index on (organization_id, client_id, service_id, period_start,
  -- period_end) WHERE is_current is only ever violated by the insert-then-
  -- update ordering the original version of this function used, whenever
  -- an amendment doesn't change the period (e.g. only the rate). Fixed
  -- upstream by 20260812185756_fix_amend_client_authorization_current_flag_ordering.sql;
  -- restoring that order here since this rewrite (for hourly_rate_cents)
  -- was based on an earlier version of the function.
  update public.client_authorizations set
    is_current = false,
    updated_by = auth.uid()
  where id = old_auth.id;

  insert into public.client_authorizations (
    organization_id, client_id, service_id, payer, authorization_number,
    max_monthly_hours, period_start, period_end, notes, hourly_rate_cents,
    version_number, is_current, supersedes_id,
    received_date, source_reference, change_reason,
    created_by, updated_by
  ) values (
    old_auth.organization_id, old_auth.client_id, old_auth.service_id, new_payer, new_authorization_number,
    new_max_monthly_hours, new_period_start, new_period_end, new_notes, new_hourly_rate_cents,
    new_version, true, old_auth.id,
    received_date, source_reference, btrim(reason),
    auth.uid(), auth.uid()
  ) returning id into new_id;

  update public.client_authorizations set
    superseded_by_id = new_id
  where id = old_auth.id;

  return query
  select
    new_id,
    new_version,
    v.id,
    v.status,
    v.service_date,
    v.worked_minutes,
    v.billable_minutes,
    old_cap_minutes,
    new_cap_minutes,
    case
      when moved_up and v.authorization_status in ('exceeds_authorization', 'limit_reached')
        then 'increase_may_allow_more'
      when not moved_up and v.status in ('signed', 'administrator_review')
        then 'decrease_now_exceeds'
      else null
    end
  from public.service_visits v
  where v.service_authorization_id = old_auth.id
    and v.status not in ('voided', 'corrected')
    and (
      (moved_up and v.authorization_status in ('exceeds_authorization', 'limit_reached'))
      or (not moved_up and v.status in ('signed', 'administrator_review'))
    )
  order by v.service_date desc;
end;
$$;

revoke all on function public.amend_client_authorization(uuid, numeric, date, date, text, text, text, text, date, text, integer) from public, anon;
grant execute on function public.amend_client_authorization(uuid, numeric, date, date, text, text, text, text, date, text, integer) to authenticated;

drop function if exists public.list_client_authorizations(uuid, integer);

create function public.list_client_authorizations(
  target_organization_id uuid,
  result_limit integer default 200
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  service_id uuid,
  service_name text,
  payer text,
  authorization_number text,
  max_monthly_hours numeric,
  period_start date,
  period_end date,
  notes text,
  hours_used_this_month numeric,
  hours_scheduled_this_month numeric,
  version_number integer,
  received_date date,
  source_reference text,
  hourly_rate_cents integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.client_id,
    c.first_name || ' ' || c.last_name,
    a.service_id,
    sv.name,
    a.payer,
    a.authorization_number,
    a.max_monthly_hours,
    a.period_start,
    a.period_end,
    a.notes,
    usage.hours_used_this_month,
    usage.hours_scheduled_this_month,
    a.version_number,
    a.received_date,
    a.source_reference,
    a.hourly_rate_cents
  from public.client_authorizations a
  join public.clients c on c.id = a.client_id
  join public.services sv on sv.id = a.service_id
  cross join lateral (
    select
      coalesce(
        sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
          filter (where s.status = 'completed'),
        0
      ) as hours_used_this_month,
      coalesce(
        sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
          filter (where s.status = 'scheduled'),
        0
      ) as hours_scheduled_this_month
    from (
      select
        greatest(date_trunc('month', now()), a.period_start::timestamptz) as window_start,
        least(date_trunc('month', now()) + interval '1 month', a.period_end::timestamptz + interval '1 day') as window_end
    ) w
    left join public.shifts s
      on s.client_id = a.client_id
     and s.service_id = a.service_id
     and s.organization_id = a.organization_id
     and s.status in ('completed', 'scheduled')
     and s.starts_at < w.window_end
     and s.ends_at > w.window_start
  ) usage
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and a.is_current = true
    and public.has_permission(target_organization_id, 'authorizations.read')
  order by a.period_start desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_client_authorizations(uuid, integer) from public;
grant execute on function public.list_client_authorizations(uuid, integer) to authenticated;
revoke execute on function public.list_client_authorizations(uuid, integer) from anon;

commit;
