create or replace function public.check_shift_authorization_and_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_auth public.client_authorizations%rowtype;
  cap_minutes integer;
  committed_minutes bigint;
  requested_minutes integer;
begin
  if NEW.service_id is null then
    return NEW;
  end if;

  select * into target_auth from public.client_authorizations
  where organization_id = NEW.organization_id
    and client_id = NEW.client_id
    and service_id = NEW.service_id
    and deleted_at is null
    and is_current = true
    and NEW.starts_at::date between period_start and period_end
  order by period_start desc
  limit 1
  for update;

  if target_auth.id is null then
    raise exception 'No active authorization covers this client and service for this date - an administrator needs to add one first';
  end if;

  requested_minutes := ceil(extract(epoch from (NEW.ends_at - NEW.starts_at)) / 60)::integer;
  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;

  select coalesce(sum(
    extract(epoch from (
      least(s.ends_at, date_trunc('month', NEW.starts_at) + interval '1 month')
      - greatest(s.starts_at, date_trunc('month', NEW.starts_at))
    )) / 60.0
  ), 0)::bigint
  into committed_minutes
  from public.shifts s
  where s.organization_id = NEW.organization_id
    and s.client_id = NEW.client_id
    and s.service_id = NEW.service_id
    and s.id is distinct from NEW.id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < date_trunc('month', NEW.starts_at) + interval '1 month'
    and s.ends_at > date_trunc('month', NEW.starts_at);

  if committed_minutes + requested_minutes > cap_minutes then
    raise exception 'Maximum authorized hours reached for this client and service this month.';
  end if;

  if exists (
    select 1 from public.shifts s
    where s.organization_id = NEW.organization_id
      and s.client_id = NEW.client_id
      and s.service_id = NEW.service_id
      and s.id is distinct from NEW.id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < NEW.ends_at
      and s.ends_at > NEW.starts_at
  ) then
    raise exception 'This overlaps a shift already scheduled for this client and service.';
  end if;

  return NEW;
end;
$$;

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
    and is_current = true
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
    and is_current = true
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

create or replace function public.start_service_visit_by_client_code(
  target_organization_id uuid,
  target_client_code text,
  target_service_id uuid,
  visit_task_categories text[] default '{}',
  visit_service_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_client public.clients%rowtype;
  target_auth public.client_authorizations%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
  recent_failures integer;
  org_slug text;
  new_visit_number text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;

  select count(*) into recent_failures
  from public.audit_logs
  where actor_user_id = auth.uid()
    and organization_id = target_organization_id
    and action = 'client_lookup.failed'
    and occurred_at > now() - interval '10 minutes';
  if recent_failures >= 5 then
    raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.';
  end if;

  select * into target_client from public.clients
  where organization_id = target_organization_id
    and lower(client_code) = lower(btrim(target_client_code))
    and deleted_at is null
    and status = 'active';

  if target_client.id is null then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.failed', 'clients', 'application');
    raise exception 'NOT_FOUND: That client ID was not found or is not active.';
  end if;

  select * into target_auth from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_client.id
    and service_id = target_service_id
    and deleted_at is null
    and is_current = true
    and started_at::date between period_start and period_end
  order by period_start desc limit 1;

  if target_auth.id is null then
    raise exception 'No active authorization covers this client and service - contact your agency administrator';
  end if;

  select coalesce(display_name, 'Caregiver') into caregiver_name
  from public.user_profiles where id = auth.uid();

  select upper(left(regexp_replace(slug, '[^a-zA-Z0-9]', '', 'g'), 4)) into org_slug
  from public.organizations where id = target_organization_id;
  new_visit_number := coalesce(nullif(org_slug, ''), 'CLK') || '-V-' || to_char(started_at, 'YYYYMMDD')
    || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4));

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by, visit_number_snapshot
  ) values (
    target_organization_id, target_client.id, target_client.client_code,
    auth.uid(), coalesce(caregiver_name, 'Caregiver'),
    null, target_auth.id, target_service_id, started_at::date,
    started_at, coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid(), new_visit_number
  ) returning id into visit_id;

  return visit_id;
end;
$$;

create or replace function public.list_authorized_services_for_client(
  target_organization_id uuid,
  target_client_id uuid
)
returns table (
  service_id uuid,
  service_code text,
  service_name text,
  service_color text,
  authorization_id uuid,
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
    sv.id, sv.code, sv.name, sv.color,
    a.id, a.max_monthly_hours,
    coalesce(usage.hours_used_this_month, 0),
    coalesce(usage.hours_scheduled_this_month, 0)
  from public.client_authorizations a
  join public.services sv on sv.id = a.service_id and sv.deleted_at is null
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
  ) usage on true
  where a.organization_id = target_organization_id
    and a.client_id = target_client_id
    and a.deleted_at is null
    and a.is_current = true
    and current_date between a.period_start and a.period_end
    and public.is_organization_member(target_organization_id)
  order by sv.name;
$$;

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
   and a.is_current = true
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

create or replace function public.list_service_verification_options(target_organization_id uuid)
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
   and a.is_current = true
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
  source_reference text
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
    a.source_reference
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
  then
    raise exception 'Authorization terms cannot be edited directly - use amend_client_authorization() to record a new version';
  end if;
  return NEW;
end;
$$;

create trigger client_authorizations_prevent_direct_edit
before update on public.client_authorizations
for each row execute function public.prevent_direct_authorization_edit();
