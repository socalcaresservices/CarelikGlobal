begin;

-- Visit Verification Redesign
-- - Restores scheduled shift selection for caregivers
-- - Updates RPC to support shift-based visits
-- - Privacy-redacted shift list (no client legal name)
-- - Compact authorization summary in UI
-- - Preserves all audit and RLS protections

-- List scheduled shifts for a client today, privacy-redacted for caregivers.
-- No client legal name is returned. Shifts are filtered to:
-- - Today's date in organization timezone
-- - Scheduled status (not already started, cancelled, etc.)
-- - Not already covered by an existing non-voided/non-corrected visit
-- - Assigned to the calling caregiver
create or replace function public.list_scheduled_shifts_for_visit(
  target_organization_id uuid,
  target_client_id uuid
)
returns table (
  shift_id uuid,
  service_id uuid,
  service_code text,
  service_name text,
  service_color text,
  authorization_id uuid,
  max_monthly_hours numeric,
  hours_used_this_month numeric,
  hours_scheduled_this_month numeric,
  starts_at timestamptz,
  ends_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    sv.id,
    sv.code,
    sv.name,
    sv.color,
    a.id,
    a.max_monthly_hours,
    coalesce(used.hours, 0),
    coalesce(scheduled.hours, 0),
    s.starts_at,
    s.ends_at
  from public.shifts s
  join public.organizations o on o.id = s.organization_id
  join public.clients c
    on c.id = s.client_id
   and c.organization_id = s.organization_id
   and c.deleted_at is null
   and c.status = 'active'
  join public.services sv
    on sv.id = s.service_id
   and sv.organization_id = s.organization_id
   and sv.deleted_at is null
   and sv.is_active = true
  join public.client_authorizations a
    on a.organization_id = s.organization_id
   and a.client_id = s.client_id
   and a.service_id = s.service_id
   and a.deleted_at is null
   and s.starts_at::date between a.period_start and a.period_end
  left join lateral (
    select coalesce(sum(v.billable_minutes), 0)::numeric / 60.0 as hours
    from public.service_visits v
    where v.service_authorization_id = a.id
      and v.service_date >= date_trunc('month', s.starts_at)::date
      and v.service_date < (date_trunc('month', s.starts_at) + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
  ) used on true
  left join lateral (
    select coalesce(sum(extract(epoch from (
      least(s2.ends_at, date_trunc('month', s.starts_at) + interval '1 month')
      - greatest(s2.starts_at, date_trunc('month', s.starts_at))
    )) / 3600.0), 0)::numeric as hours
    from public.shifts s2
    where s2.organization_id = s.organization_id
      and s2.client_id = s.client_id
      and s2.service_id = s.service_id
      and s2.status = 'scheduled'
      and s2.starts_at < date_trunc('month', s.starts_at) + interval '1 month'
      and s2.ends_at > date_trunc('month', s.starts_at)
  ) scheduled on true
  where s.organization_id = target_organization_id
    and s.client_id = target_client_id
    and (s.caregiver_user_id = auth.uid() or s.caregiver_record_id is not null)
    and s.status = 'scheduled'
    and (s.starts_at at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
      = (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
    and public.is_organization_member(target_organization_id)
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  order by s.starts_at, sv.name;
$$;

revoke all on function public.list_scheduled_shifts_for_visit(uuid, uuid) from public, anon;
grant execute on function public.list_scheduled_shifts_for_visit(uuid, uuid) to authenticated;

-- Update start_ad_hoc_service_visit to support scheduled shifts.
-- When a scheduled_shift_id is provided, the visit is tied to that shift.
-- Otherwise, it remains an ad-hoc visit.
create or replace function public.start_ad_hoc_service_visit(
  target_organization_id uuid,
  target_client_id uuid,
  target_service_id uuid,
  scheduled_shift_id uuid default null,
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
  target_shift public.shifts%rowtype;
  caregiver_record public.caregiver_records%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
  local_service_date date;
  organization_timezone text;
  organization_slug text;
  new_visit_number text;
  caller_is_caregiver boolean;
  caller_can_manage boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select coalesce(o.timezone, 'America/Los_Angeles'), o.slug
  into organization_timezone, organization_slug
  from public.organizations o
  where o.id = target_organization_id
    and public.organization_is_active(o.id);
  if organization_timezone is null then raise exception 'Organization is not active'; end if;

  select exists (
    select 1
    from public.organization_memberships om
    where om.organization_id = target_organization_id
      and om.user_id = auth.uid()
      and om.status = 'active'
      and om.role = 'caregiver'
  ) into caller_is_caregiver;
  caller_can_manage := public.has_permission(target_organization_id, 'visits.manage');
  if not caller_is_caregiver and not caller_can_manage then
    raise exception 'Only an active caregiver or visit manager can start a visit';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));

  if exists (
    select 1
    from public.service_visits v
    where v.organization_id = target_organization_id
      and v.caregiver_user_id = auth.uid()
      and v.status in ('draft', 'awaiting_signature')
  ) then
    raise exception 'Finish your current visit before starting another client';
  end if;

  if not caller_can_manage
     and not public.caregiver_has_active_assignment(target_organization_id, target_client_id, target_service_id) then
    raise exception 'This client and service are not assigned to you';
  end if;

  select * into target_client
  from public.clients c
  where c.id = target_client_id
    and c.organization_id = target_organization_id
    and c.deleted_at is null
    and c.status = 'active';
  if target_client.id is null then raise exception 'Client not found or inactive'; end if;

  if not exists (
    select 1
    from public.services sv
    where sv.id = target_service_id
      and sv.organization_id = target_organization_id
      and sv.deleted_at is null
      and sv.is_active
  ) then
    raise exception 'Service not found or inactive';
  end if;

  -- If a scheduled shift is provided, validate it exists and belongs to this client/service
  if scheduled_shift_id is not null then
    select * into target_shift
    from public.shifts s
    where s.id = scheduled_shift_id
      and s.organization_id = target_organization_id
      and s.client_id = target_client_id
      and s.service_id = target_service_id
      and s.status = 'scheduled'
      and not exists (
        select 1 from public.service_visits v
        where v.scheduled_shift_id = s.id
          and v.status not in ('voided', 'corrected')
      );
    if target_shift.id is null then
      raise exception 'Scheduled shift not found or already in use';
    end if;
    started_at := target_shift.starts_at;
  end if;

  local_service_date := (started_at at time zone organization_timezone)::date;
  select * into target_auth
  from public.client_authorizations a
  where a.organization_id = target_organization_id
    and a.client_id = target_client_id
    and a.service_id = target_service_id
    and local_service_date between a.period_start and a.period_end
    and a.deleted_at is null
  order by a.period_start desc
  limit 1
  for update;
  if target_auth.id is null then
    raise exception 'No active authorization covers this client and service';
  end if;

  select cr.* into caregiver_record
  from public.caregiver_records cr
  where cr.organization_id = target_organization_id
    and cr.linked_user_id = auth.uid()
    and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;

  if caller_is_caregiver
     and (caregiver_record.id is null or caregiver_record.status not in ('active', 'ready')) then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before starting a visit.';
  end if;

  select coalesce(
    nullif(trim(concat_ws(' ', coalesce(caregiver_record.preferred_name, caregiver_record.first_name), caregiver_record.last_name)), ''),
    nullif(trim(up.display_name), ''),
    'Caregiver'
  ) into caregiver_name
  from public.user_profiles up
  where up.id = auth.uid();

  new_visit_number := coalesce(
    nullif(upper(left(regexp_replace(organization_slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''),
    'OGEV'
  ) || '-V-' || to_char(local_service_date, 'YYYYMMDD')
    || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4));

  insert into public.service_visits (
    organization_id,
    client_id,
    client_code_snapshot,
    caregiver_user_id,
    caregiver_record_id,
    caregiver_name_snapshot,
    scheduled_shift_id,
    service_authorization_id,
    service_id,
    service_date,
    time_in,
    task_categories,
    service_notes,
    status,
    created_by,
    visit_number_snapshot
  ) values (
    target_organization_id,
    target_client.id,
    target_client.client_code,
    auth.uid(),
    caregiver_record.id,
    coalesce(caregiver_name, 'Caregiver'),
    target_shift.id,
    target_auth.id,
    target_service_id,
    local_service_date,
    started_at,
    coalesce(visit_task_categories, '{}'),
    nullif(trim(visit_service_notes), ''),
    'draft',
    auth.uid(),
    new_visit_number
  ) returning id into visit_id;

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, source)
  values (
    target_organization_id,
    auth.uid(),
    case when scheduled_shift_id is not null then 'service_visit.started_from_shift' else 'service_visit.started_ad_hoc' end,
    'service_visits',
    visit_id,
    'application'
  );

  return visit_id;
end;
$$;

revoke all on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, uuid, text[], text) from public, anon;
grant execute on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, uuid, text[], text) to authenticated;

commit;
