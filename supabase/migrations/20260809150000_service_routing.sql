begin;

-- Service Routing: closes the gap between "services exist" and "a
-- caregiver can schedule their own visit for one." Everything here
-- extends tables that already exist (services, client_authorizations,
-- shifts, service_visits) rather than introducing parallel concepts -
-- see the session notes for the phase-zero inspection that confirmed
-- clients, caregivers, authorizations, and visit sign-off already had a
-- working implementation before this migration.

-- ---------------------------------------------------------------------
-- 1. Service codes: services gets a code + color, same shape as every
-- other org-scoped lookup table's "value" field. Existing rows are
-- admin-curated and few, so a name-derived backfill is safe.
-- ---------------------------------------------------------------------
alter table public.services
  add column code text,
  add column description text,
  add column color text;

update public.services
set code = upper(left(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 12))
where code is null or trim(code) = '';

-- A name that was all punctuation (unlikely, but not impossible) would
-- backfill to an empty string - fall back to a short id fragment so the
-- not-null constraint below never fails.
update public.services
set code = 'SVC' || upper(substr(replace(id::text, '-', ''), 1, 5))
where code is null or trim(code) = '';

alter table public.services alter column code set not null;

create unique index services_org_active_code_unique
  on public.services (organization_id, upper(code))
  where deleted_at is null and is_active = true;

-- ---------------------------------------------------------------------
-- 2. Caregiver assignments: the actual missing gate. Today any member
-- with shifts.update can schedule any caregiver for any client: this is
-- what lets a specific caregiver schedule *themselves*, and only for
-- clients/services an administrator explicitly assigned. No
-- authorization_id column - the covering authorization is resolved by
-- client+service+date at scheduling time (same lookup start_service_visit
-- already does), so an assignment never goes stale when an authorization
-- is renewed for a new period.
-- ---------------------------------------------------------------------
create table public.caregiver_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_user_id uuid not null references auth.users(id),
  client_id uuid not null references public.clients(id) on delete cascade,
  service_id uuid not null references public.services(id),
  effective_start date not null default current_date,
  effective_end date,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caregiver_assignments_period_check check (effective_end is null or effective_start <= effective_end)
);

create unique index caregiver_assignments_unique_active
  on public.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id)
  where is_active = true;
create index caregiver_assignments_caregiver_idx on public.caregiver_assignments (caregiver_user_id) where is_active = true;
create index caregiver_assignments_client_idx on public.caregiver_assignments (client_id) where is_active = true;

create trigger caregiver_assignments_set_updated_at
before update on public.caregiver_assignments
for each row execute function public.set_updated_at();

create trigger caregiver_assignments_audit
after insert or update or delete on public.caregiver_assignments
for each row execute function public.write_audit_log();

alter table public.caregiver_assignments enable row level security;

create policy "caregivers_read_own_assignments"
on public.caregiver_assignments for select to authenticated
using (caregiver_user_id = auth.uid() or public.has_permission(organization_id, 'assignments.read'));

create policy "authorized_manage_assignments"
on public.caregiver_assignments for all to authenticated
using (public.has_permission(organization_id, 'assignments.update'))
with check (public.has_permission(organization_id, 'assignments.update'));

insert into public.permissions (key, description) values
  ('assignments.read', 'View caregiver-client-service assignments'),
  ('assignments.update', 'Create and manage caregiver-client-service assignments');

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
  select key from public.permissions where key in ('assignments.read', 'assignments.update')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('read_only', 'assignments.read');

create or replace function public.list_caregiver_assignments(target_organization_id uuid)
returns table (
  id uuid,
  caregiver_user_id uuid,
  caregiver_name text,
  client_id uuid,
  client_name text,
  client_code text,
  service_id uuid,
  service_name text,
  service_code text,
  effective_start date,
  effective_end date,
  is_active boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    ca.id, ca.caregiver_user_id, coalesce(p.display_name, 'Caregiver'),
    ca.client_id, c.first_name || ' ' || c.last_name, c.client_code,
    ca.service_id, sv.name, sv.code,
    ca.effective_start, ca.effective_end, ca.is_active
  from public.caregiver_assignments ca
  join public.clients c on c.id = ca.client_id
  join public.services sv on sv.id = ca.service_id
  left join public.user_profiles p on p.id = ca.caregiver_user_id
  where ca.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'assignments.read')
  order by c.first_name, c.last_name, sv.name;
$$;

revoke all on function public.list_caregiver_assignments(uuid) from public, anon;
grant execute on function public.list_caregiver_assignments(uuid) to authenticated;

-- What the *calling caregiver* may schedule: their active assignments,
-- joined to whichever authorization currently covers that client+service
-- (if any), with this-month usage computed the same way
-- list_client_authorizations already does it. authorization_id/period
-- come back null when no authorization currently covers the pairing -
-- the scheduling RPC below treats that as "cannot schedule yet", the
-- page surfaces it as "contact your administrator" rather than hiding
-- the assignment entirely.
create or replace function public.list_my_schedulable_assignments(target_organization_id uuid)
returns table (
  assignment_id uuid,
  client_id uuid,
  client_code text,
  client_name text,
  service_id uuid,
  service_code text,
  service_name text,
  service_color text,
  authorization_id uuid,
  authorization_period_start date,
  authorization_period_end date,
  max_monthly_hours numeric,
  hours_used_this_month numeric,
  hours_scheduled_this_month numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    ca.id, c.id, c.client_code, c.first_name || ' ' || c.last_name,
    sv.id, sv.code, sv.name, sv.color,
    a.id, a.period_start, a.period_end, a.max_monthly_hours,
    coalesce(usage.hours_used_this_month, 0),
    coalesce(usage.hours_scheduled_this_month, 0)
  from public.caregiver_assignments ca
  join public.clients c on c.id = ca.client_id and c.deleted_at is null
  join public.services sv on sv.id = ca.service_id and sv.deleted_at is null
  left join public.client_authorizations a
    on a.organization_id = ca.organization_id
   and a.client_id = ca.client_id
   and a.service_id = ca.service_id
   and a.deleted_at is null
   and current_date between a.period_start and a.period_end
  left join lateral (
    select
      coalesce(sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
        filter (where s.status = 'completed'), 0) as hours_used_this_month,
      coalesce(sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
        filter (where s.status = 'scheduled'), 0) as hours_scheduled_this_month
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
  ) usage on a.id is not null
  where ca.organization_id = target_organization_id
    and ca.caregiver_user_id = auth.uid()
    and ca.is_active = true
    and current_date >= ca.effective_start
    and (ca.effective_end is null or current_date <= ca.effective_end)
  order by c.first_name, c.last_name, sv.name;
$$;

revoke all on function public.list_my_schedulable_assignments(uuid) from public, anon;
grant execute on function public.list_my_schedulable_assignments(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Human-readable visit numbers on shifts (the "scheduled visit"
-- record) - generated server-side, never sequential/guessable IDs
-- exposed in a URL. service_visits gets a snapshot column, same pattern
-- as client_code_snapshot/caregiver_name_snapshot, so a visit's number
-- never changes even if the underlying shift record is later edited.
-- ---------------------------------------------------------------------
alter table public.shifts add column visit_number text;

create or replace function public.set_shift_visit_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  org_prefix text;
begin
  if new.visit_number is null or trim(new.visit_number) = '' then
    select upper(left(regexp_replace(slug, '[^a-zA-Z0-9]', '', 'g'), 4)) into org_prefix
    from public.organizations where id = new.organization_id;
    new.visit_number := coalesce(nullif(org_prefix, ''), 'CLK') || '-V-'
      || to_char(new.starts_at, 'YYYYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4));
  end if;
  return new;
end;
$$;

create trigger shifts_set_visit_number
before insert on public.shifts
for each row execute function public.set_shift_visit_number();

update public.shifts set visit_number =
  coalesce(nullif((select upper(left(regexp_replace(o.slug, '[^a-zA-Z0-9]', '', 'g'), 4)) from public.organizations o where o.id = shifts.organization_id), ''), 'CLK')
  || '-V-' || to_char(starts_at, 'YYYYMMDD') || '-' || upper(substr(md5(id::text), 1, 4))
where visit_number is null;

alter table public.shifts alter column visit_number set not null;
create unique index shifts_org_visit_number_unique on public.shifts (organization_id, visit_number);

alter table public.service_visits add column visit_number_snapshot text;

update public.service_visits sv
set visit_number_snapshot = s.visit_number
from public.shifts s
where s.id = sv.scheduled_shift_id and sv.visit_number_snapshot is null;

-- ---------------------------------------------------------------------
-- 4. schedule_caregiver_visit: the self-service scheduling RPC. Frontend
-- validation is never trusted alone - this is where the assignment gate,
-- the authorization cap, and the overlap check all actually happen,
-- inside one transaction with the authorization row locked so two
-- concurrent scheduling attempts against the same cap can't both win.
-- ---------------------------------------------------------------------
create or replace function public.schedule_caregiver_visit(
  target_organization_id uuid,
  target_client_id uuid,
  target_service_id uuid,
  visit_starts_at timestamptz,
  visit_ends_at timestamptz,
  visit_notes text default null
)
returns table (shift_id uuid, visit_number text)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_assignment public.caregiver_assignments%rowtype;
  target_auth public.client_authorizations%rowtype;
  cap_minutes integer;
  committed_minutes bigint;
  requested_minutes integer;
  new_shift_id uuid;
  new_visit_number text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if visit_ends_at <= visit_starts_at then
    raise exception 'End time must be after start time';
  end if;

  select * into target_assignment from public.caregiver_assignments
  where organization_id = target_organization_id
    and caregiver_user_id = auth.uid()
    and client_id = target_client_id
    and service_id = target_service_id
    and is_active = true
    and current_date >= effective_start
    and (effective_end is null or current_date <= effective_end)
  limit 1;

  if target_assignment.id is null then
    raise exception 'You are not assigned to this client for this service';
  end if;

  select * into target_auth from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_client_id
    and service_id = target_service_id
    and deleted_at is null
    and visit_starts_at::date between period_start and period_end
  order by period_start desc
  limit 1
  for update;

  if target_auth.id is null then
    raise exception 'Maximum authorized hours reached. Contact your agency administrator.';
  end if;

  requested_minutes := ceil(extract(epoch from (visit_ends_at - visit_starts_at)) / 60)::integer;
  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;

  select coalesce(sum(
    extract(epoch from (
      least(s.ends_at, date_trunc('month', visit_starts_at) + interval '1 month')
      - greatest(s.starts_at, date_trunc('month', visit_starts_at))
    )) / 60.0
  ), 0)::bigint
  into committed_minutes
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.client_id = target_client_id
    and s.service_id = target_service_id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < date_trunc('month', visit_starts_at) + interval '1 month'
    and s.ends_at > date_trunc('month', visit_starts_at);

  if committed_minutes + requested_minutes > cap_minutes then
    raise exception 'Maximum authorized hours reached. Contact your agency administrator.';
  end if;

  if exists (
    select 1 from public.shifts s
    where s.organization_id = target_organization_id
      and s.client_id = target_client_id
      and s.service_id = target_service_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < visit_ends_at
      and s.ends_at > visit_starts_at
  ) then
    raise exception 'This overlaps a visit already scheduled for this client and service';
  end if;

  insert into public.shifts (
    organization_id, client_id, caregiver_user_id, service_id, starts_at, ends_at, notes, status, created_by
  ) values (
    target_organization_id, target_client_id, auth.uid(), target_service_id, visit_starts_at, visit_ends_at,
    nullif(trim(visit_notes), ''), 'scheduled', auth.uid()
  ) returning id, shifts.visit_number into new_shift_id, new_visit_number;

  return query select new_shift_id, new_visit_number;
end;
$$;

revoke all on function public.schedule_caregiver_visit(uuid, uuid, uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.schedule_caregiver_visit(uuid, uuid, uuid, timestamptz, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Correction audit-history read + surfacing visit numbers and
-- authorization before/after balances (already computed into
-- visit_signatures.signed_visit_snapshot at sign time - just needs to be
-- returned to the frontend that will now display it).
-- ---------------------------------------------------------------------
create or replace function public.list_visit_corrections(target_visit_id uuid)
returns table (
  id uuid,
  corrected_by_name text,
  reason text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    vc.id,
    coalesce(p.display_name, 'Administrator'),
    vc.reason,
    vc.before_snapshot,
    vc.after_snapshot,
    vc.created_at
  from public.visit_corrections vc
  join public.service_visits v on v.id = vc.original_visit_id
  left join public.user_profiles p on p.id = vc.corrected_by
  where (vc.original_visit_id = target_visit_id or vc.corrected_visit_id = target_visit_id)
    and public.has_permission(v.organization_id, 'visits.read')
  order by vc.created_at desc;
$$;

revoke all on function public.list_visit_corrections(uuid) from public, anon;
grant execute on function public.list_visit_corrections(uuid) to authenticated;

-- list_service_verification_options: add visit_number so the caregiver
-- flow and its success screen can show it.
drop function if exists public.list_service_verification_options(uuid);

create function public.list_service_verification_options(target_organization_id uuid)
returns table (
  shift_id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
  caregiver_user_id uuid,
  caregiver_name text,
  service_id uuid,
  service_name text,
  authorization_id uuid,
  max_monthly_hours numeric,
  starts_at timestamptz,
  ends_at timestamptz,
  signed_minutes_this_month bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.visit_number,
    s.client_id,
    c.client_code,
    s.caregiver_user_id,
    coalesce(p.display_name, 'Caregiver'),
    s.service_id,
    sv.name,
    a.id,
    a.max_monthly_hours,
    s.starts_at,
    s.ends_at,
    coalesce(usage.signed_minutes, 0)
  from public.shifts s
  join public.clients c on c.id = s.client_id and c.deleted_at is null
  join public.services sv on sv.id = s.service_id and sv.deleted_at is null
  join public.client_authorizations a
    on a.organization_id = s.organization_id
   and a.client_id = s.client_id
   and a.service_id = s.service_id
   and a.deleted_at is null
   and s.starts_at::date between a.period_start and a.period_end
  left join public.user_profiles p on p.id = s.caregiver_user_id
  left join lateral (
    select sum(v.billable_minutes)::bigint as signed_minutes
    from public.service_visits v
    where v.service_authorization_id = a.id
      and v.service_date >= date_trunc('month', s.starts_at)::date
      and v.service_date < (date_trunc('month', s.starts_at) + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
  ) usage on true
  where s.organization_id = target_organization_id
    and auth.uid() is not null
    and s.status in ('scheduled', 'completed')
    and (
      s.caregiver_user_id = auth.uid()
      or public.has_permission(target_organization_id, 'visits.manage')
    )
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  order by s.starts_at desc;
$$;

revoke all on function public.list_service_verification_options(uuid) from public, anon;
grant execute on function public.list_service_verification_options(uuid) to authenticated;

-- start_service_visit: unchanged behavior, just also copies the shift's
-- visit_number into the new visit's snapshot column.
create or replace function public.start_service_visit(
  target_organization_id uuid,
  target_shift_id uuid,
  visit_task_categories text[] default '{}',
  visit_service_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_shift public.shifts%rowtype;
  target_client public.clients%rowtype;
  target_auth public.client_authorizations%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into target_shift from public.shifts
  where id = target_shift_id and organization_id = target_organization_id;

  if target_shift.id is null then raise exception 'Scheduled shift not found'; end if;
  if target_shift.caregiver_user_id <> auth.uid()
     and not public.has_permission(target_organization_id, 'visits.manage') then
    raise exception 'You cannot verify another caregiver''s shift';
  end if;
  if target_shift.service_id is null then
    raise exception 'The shift needs a service before it can be verified';
  end if;

  select * into target_client from public.clients where id = target_shift.client_id and deleted_at is null;
  if target_client.id is null then raise exception 'Client not found'; end if;

  select * into target_auth from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_shift.client_id
    and service_id = target_shift.service_id
    and started_at::date between period_start and period_end
    and deleted_at is null
  order by period_start desc limit 1;

  if target_auth.id is null then
    raise exception 'No active authorization covers this visit - an administrator needs to add one first';
  end if;

  select coalesce(display_name, 'Caregiver') into caregiver_name
  from public.user_profiles where id = target_shift.caregiver_user_id;

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by, visit_number_snapshot
  ) values (
    target_organization_id, target_shift.client_id, target_client.client_code,
    target_shift.caregiver_user_id, coalesce(caregiver_name, 'Caregiver'),
    target_shift.id, target_auth.id, target_shift.service_id, started_at::date,
    started_at, coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid(), target_shift.visit_number
  ) returning id into visit_id;

  return visit_id;
end;
$$;

-- list_service_visits: add visit number and the authorization before/
-- after balance already captured in visit_signatures.signed_visit_snapshot
-- at sign time (billing detail the printable sheet needs but never had a
-- way to display).
drop function if exists public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status);

create function public.list_service_visits(
  target_organization_id uuid,
  filter_client_id uuid default null,
  filter_caregiver_user_id uuid default null,
  filter_service_id uuid default null,
  filter_date_from date default null,
  filter_date_to date default null,
  filter_status public.service_visit_status default null
)
returns table (
  id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
  client_legal_name text,
  caregiver_user_id uuid,
  caregiver_name text,
  service_id uuid,
  service_name text,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  status public.service_visit_status,
  authorization_status public.visit_authorization_status,
  signed_at timestamptz,
  original_visit_id uuid,
  is_corrected boolean,
  month_to_date_before_minutes bigint,
  month_to_date_after_minutes bigint,
  remaining_minutes bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.visit_number_snapshot,
    v.client_id,
    v.client_code_snapshot,
    case when public.has_permission(target_organization_id, 'visits.read')
      then c.first_name || ' ' || c.last_name
      else null
    end,
    v.caregiver_user_id,
    v.caregiver_name_snapshot,
    v.service_id,
    sv.name,
    v.service_date,
    v.time_in,
    v.time_out,
    v.worked_minutes,
    v.verified_minutes,
    v.billable_minutes,
    v.status,
    v.authorization_status,
    v.signed_at,
    v.original_visit_id,
    (v.status = 'corrected' or v.original_visit_id is not null),
    (vs.signed_visit_snapshot->>'monthToDateBeforeMinutes')::bigint,
    (vs.signed_visit_snapshot->>'monthToDateAfterMinutes')::bigint,
    (vs.signed_visit_snapshot->>'remainingMinutes')::bigint
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  left join public.clients c on c.id = v.client_id
  left join public.visit_signatures vs on vs.visit_id = v.id
  where v.organization_id = target_organization_id
    and auth.uid() is not null
    and (public.has_permission(target_organization_id, 'visits.read') or v.caregiver_user_id = auth.uid())
    and (filter_client_id is null or v.client_id = filter_client_id)
    and (filter_caregiver_user_id is null or v.caregiver_user_id = filter_caregiver_user_id)
    and (filter_service_id is null or v.service_id = filter_service_id)
    and (filter_date_from is null or v.service_date >= filter_date_from)
    and (filter_date_to is null or v.service_date <= filter_date_to)
    and (filter_status is null or v.status = filter_status)
  order by v.service_date desc, v.time_in desc;
$$;

revoke all on function public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status) from public, anon;
grant execute on function public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status) to authenticated;

commit;
