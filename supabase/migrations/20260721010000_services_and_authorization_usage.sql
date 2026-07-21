begin;

-- Services: the agency's own catalog of billable service types
-- ("Personal care", "Companionship", "Skilled nursing"...). Added so a
-- client can hold more than one authorization at once (e.g. Medicaid
-- personal-care hours and a separate private-pay companionship
-- authorization) without the two getting confused for utilization
-- purposes. org-scoped, soft-deletable, same shape as every other
-- lookup table in this schema.
create table public.services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index services_org_name_unique
  on public.services (organization_id, lower(name))
  where deleted_at is null;

create index services_org_idx on public.services (organization_id) where deleted_at is null;

create trigger services_set_updated_at
before update on public.services
for each row execute function public.set_updated_at();

create trigger services_audit
after insert or update or delete on public.services
for each row execute function public.write_audit_log();

alter table public.services enable row level security;

create policy "members_read_services"
on public.services for select
to authenticated
using (deleted_at is null and public.has_permission(organization_id, 'services.read'));

create policy "authorized_manage_services"
on public.services for all
to authenticated
using (public.has_permission(organization_id, 'services.update'))
with check (public.has_permission(organization_id, 'services.update'));

insert into public.permissions (key, description) values
  ('services.read', 'View the organization''s configured services'),
  ('services.update', 'Add, edit, and remove configured services');

insert into public.role_permissions (role, permission_key)
select role_value, new_permissions.key
from (
  values
    ('organization_owner'::public.system_role),
    ('organization_admin'::public.system_role),
    ('manager'::public.system_role),
    ('coordinator'::public.system_role)
) roles(role_value)
cross join (
  select key from public.permissions
  where key in ('services.read', 'services.update')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('read_only', 'services.read');

-- client_authorizations: add the service dimension and switch the hours
-- cap to a monthly one. authorized_hours -> max_monthly_hours is a
-- rename, not a new parallel column - the table has 0 rows in
-- production (confirmed before writing this migration), so there is no
-- data to lose or migrate, and the old name never actually conveyed
-- that the cap resets each month, which is the behavior being built
-- here. period_start/period_end remain the authorization's overall
-- validity window; the monthly cap applies within that window.
alter table public.client_authorizations
  rename column authorized_hours to max_monthly_hours;

alter table public.client_authorizations
  add column service_id uuid references public.services(id),
  add column authorization_number text;

-- Safe to require immediately - zero existing rows means nothing to
-- backfill, and every new authorization needs a service to be usable
-- for the monthly-usage math below.
alter table public.client_authorizations
  alter column service_id set not null;

create index client_authorizations_service_idx on public.client_authorizations (service_id);

-- shifts: nullable service reference so hours can be attributed to the
-- right authorization when a client has more than one. Nullable, not
-- required - existing shifts (3 rows today) predate this column, and a
-- shift with no service_id honestly won't count toward any specific
-- authorization's monthly usage rather than guessing which one it was
-- for. (Wiring service selection into shift creation on the Schedule
-- page is tracked as separate follow-up work, not part of this
-- increment.)
alter table public.shifts
  add column service_id uuid references public.services(id);

create index shifts_service_idx on public.shifts (service_id);

-- Rewritten list_client_authorizations: joins the service name, and
-- replaces the old whole-period "scheduled_hours" with two numbers
-- scoped to the current calendar month - hours_used_this_month (from
-- completed shifts) and hours_scheduled_this_month (from scheduled
-- shifts) - clamped to the overlap of "this month" and the
-- authorization's own period_start/period_end, so an authorization
-- whose period has already ended doesn't show phantom current-month
-- activity. Status (normal/approaching/at limit/over limit, and
-- separately expiring/expired) is derived from these raw numbers at
-- read time in the client, not stored here - same "derive, don't
-- store" precedent as caregiver_credentials.
-- The previous version of this function returned a different set of
-- OUT columns (scheduled_hours instead of hours_used_this_month /
-- hours_scheduled_this_month), and Postgres won't let create or
-- replace change a function's return row shape, so it must be dropped
-- first.
drop function if exists public.list_client_authorizations(uuid);

create function public.list_client_authorizations(target_organization_id uuid)
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
  hours_scheduled_this_month numeric
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
    usage.hours_scheduled_this_month
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
    and public.has_permission(target_organization_id, 'authorizations.read')
  order by a.period_start desc;
$$;

revoke all on function public.list_client_authorizations(uuid) from public;
grant execute on function public.list_client_authorizations(uuid) to authenticated;
revoke execute on function public.list_client_authorizations(uuid) from anon;

-- get_agency_dashboard (20260719300000) computed its fill_rate_pct by
-- spreading each authorization's *period-total* authorized_hours evenly
-- across the period to get a weekly equivalent. Now that the column is
-- a monthly cap (max_monthly_hours) instead of a period total, that
-- same "spread evenly, not real daily granularity" simplification needs
-- to spread a month instead of a period: weekly equivalent = monthly
-- cap * 7 / 30.4375 (average days/month). Everything else in the
-- function (active client/caregiver counts, compliance score,
-- available capacity) is unchanged.
create or replace function public.get_agency_dashboard(
  target_organization_id uuid
)
returns table (
  active_clients integer,
  active_caregivers integer,
  fill_rate_pct integer,
  compliance_score_pct integer,
  available_capacity_hours numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  week_start timestamptz := date_trunc('week', now());
  week_end timestamptz := date_trunc('week', now()) + interval '7 days';
  today date := current_date;
  v_active_clients integer;
  v_active_caregivers integer;
  v_scheduled_hours numeric;
  v_authorized_weekly_hours numeric;
  v_fill_rate integer;
  v_compliant_count integer;
  v_credentialed_count integer;
  v_compliance_score integer;
  v_capacity numeric;
begin
  if not public.has_permission(target_organization_id, 'membership.read') then
    raise exception 'You do not have permission to view the agency dashboard for this organization';
  end if;

  select count(*) into v_active_clients
  from public.clients
  where organization_id = target_organization_id and status = 'active' and deleted_at is null;

  select count(*) into v_active_caregivers
  from public.organization_memberships
  where organization_id = target_organization_id and status = 'active';

  select coalesce(sum(
    extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
  ), 0)
  into v_scheduled_hours
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < week_end
    and s.ends_at > week_start;

  select sum(a.max_monthly_hours * 7 / 30.4375)
  into v_authorized_weekly_hours
  from public.client_authorizations a
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and a.period_start <= today
    and a.period_end >= today;

  if v_authorized_weekly_hours is null or v_authorized_weekly_hours <= 0 then
    v_fill_rate := null;
  else
    v_fill_rate := least(100, greatest(0, round(100.0 * v_scheduled_hours / v_authorized_weekly_hours)));
  end if;

  select
    count(*) filter (
      where not exists (
        select 1 from public.caregiver_credentials cc
        where cc.caregiver_user_id = m.user_id
          and cc.organization_id = target_organization_id
          and cc.deleted_at is null
          and cc.expires_at is not null
          and cc.expires_at < today
      )
    ),
    count(*)
  into v_compliant_count, v_credentialed_count
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and exists (
      select 1 from public.caregiver_credentials cc
      where cc.caregiver_user_id = m.user_id
        and cc.organization_id = target_organization_id
        and cc.deleted_at is null
    );

  if v_credentialed_count = 0 then
    v_compliance_score := null;
  else
    v_compliance_score := round(100.0 * v_compliant_count / v_credentialed_count);
  end if;

  select sum(greatest(0, m.target_hours_per_week - coalesce(hrs.scheduled, 0)))
  into v_capacity
  from public.organization_memberships m
  left join lateral (
    select sum(
      extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
    ) as scheduled
    from public.shifts s
    where s.caregiver_user_id = m.user_id
      and s.organization_id = target_organization_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < week_end
      and s.ends_at > week_start
  ) hrs on true
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and m.target_hours_per_week is not null;

  return query select
    v_active_clients,
    v_active_caregivers,
    v_fill_rate,
    v_compliance_score,
    v_capacity;
end;
$$;

revoke all on function public.get_agency_dashboard(uuid) from public;
grant execute on function public.get_agency_dashboard(uuid) to authenticated;
revoke execute on function public.get_agency_dashboard(uuid) from anon;

commit;
