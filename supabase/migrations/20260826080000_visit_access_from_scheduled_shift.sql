begin;

-- Let a caregiver clock in for a client they are SCHEDULED to serve now,
-- even without a standing client assignment.
--
-- Visit start (start_ad_hoc_service_visit) and the caregiver's client and
-- service pickers only accepted a standing caregiver_assignments row. Shifts
-- are written by the Schedule page, reassign_shift (call-out replacement)
-- and claim_shift (SMS claim link) without creating one, so a caregiver who
-- was scheduled, reassigned or claimed onto a client they were not
-- standing-assigned to could not clock in for that shift.
--
-- This migration:
--   1. visit_shift_early_arrival(): the one early-arrival window (60 minutes)
--      shared by shift matching and shift-based access.
--   2. caregiver_has_current_shift(): true while the caller has their own
--      still-'scheduled', not-called-out shift for the client (and service,
--      when given) that is in progress or starts within that window. Access
--      ends by itself when the shift is completed, cancelled, called out or
--      reassigned; nothing is stored or has to be revoked.
--   3. list_assigned_visit_clients(), list_authorized_services_for_client()
--      and start_ad_hoc_service_visit(): accept a standing assignment OR a
--      current shift. Caregivers still see client codes only; managers are
--      unchanged.
--   4. match_scheduled_shift_for_visit(): uses the shared window (no
--      behaviour change).
--
-- The predicate is deliberately separate from caregiver_has_active_assignment
-- so no other caller of that function gains anything. Permission checks,
-- search_path and grants of the changed functions are otherwise unchanged.

create or replace function public.visit_shift_early_arrival()
returns interval
language sql
immutable
set search_path = public
as $$
  -- How early a caregiver can sign in for a scheduled shift. A matching
  -- window only: it never refuses or shortens a visit.
  select interval '60 minutes'
$$;

revoke all on function public.visit_shift_early_arrival() from public, anon, authenticated;

create or replace function public.caregiver_has_current_shift(
  target_organization_id uuid,
  target_client_id uuid,
  target_service_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and exists (
      select 1
      from public.shifts s
      left join public.caregiver_records cr
        on cr.id = s.caregiver_record_id
       and cr.organization_id = s.organization_id
       and cr.deleted_at is null
      where s.organization_id = target_organization_id
        and s.client_id = target_client_id
        and (target_service_id is null or s.service_id = target_service_id)
        and s.status = 'scheduled'
        and (s.caregiver_user_id = auth.uid() or cr.linked_user_id = auth.uid())
        and now() >= s.starts_at - public.visit_shift_early_arrival()
        and now() < s.ends_at
        and (
          select e.event_type
          from public.shift_coverage_events e
          where e.shift_id = s.id
          order by e.created_at desc
          limit 1
        ) is distinct from 'called_out'
    );
$$;

-- Internal helper: only the SECURITY DEFINER visit functions call it.
revoke all on function public.caregiver_has_current_shift(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.match_scheduled_shift_for_visit(
  target_organization_id uuid,
  target_caregiver_record_id uuid,
  target_caregiver_user_id uuid,
  target_client_id uuid,
  target_service_id uuid,
  visit_started_at timestamptz
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  early_arrival constant interval := public.visit_shift_early_arrival();
  matched_shift_id uuid;
begin
  select s.id into matched_shift_id
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.client_id = target_client_id
    and s.service_id = target_service_id
    and s.status = 'scheduled'
    and (
      (target_caregiver_record_id is not null and s.caregiver_record_id = target_caregiver_record_id)
      or (target_caregiver_user_id is not null and s.caregiver_user_id = target_caregiver_user_id)
    )
    and visit_started_at >= s.starts_at - early_arrival
    and visit_started_at < s.ends_at
    and (
      select e.event_type
      from public.shift_coverage_events e
      where e.shift_id = s.id
      order by e.created_at desc
      limit 1
    ) is distinct from 'called_out'
    and not exists (
      select 1
      from public.service_visits v
      where v.scheduled_shift_id = s.id
        and v.status not in ('voided', 'corrected')
    )
  order by
    (visit_started_at >= s.starts_at) desc,
    abs(extract(epoch from (s.starts_at - visit_started_at)))
  limit 1
  for update of s;

  return matched_shift_id;
end;
$$;

-- Internal helper: only the SECURITY DEFINER visit functions call it.
revoke all on function public.match_scheduled_shift_for_visit(uuid, uuid, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;

create or replace function public.list_assigned_visit_clients(target_organization_id uuid)
returns table (
  client_id uuid,
  client_code text,
  next_scheduled_starts_at timestamptz,
  next_scheduled_ends_at timestamptz,
  active_service_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    next_shift.starts_at,
    next_shift.ends_at,
    (
      select count(distinct a.service_id)::integer
      from public.client_authorizations a
      join public.services sv
        on sv.id = a.service_id
       and sv.organization_id = a.organization_id
       and sv.deleted_at is null
       and sv.is_active
      where a.organization_id = c.organization_id
        and a.client_id = c.id
        and a.deleted_at is null
        and (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
          between a.period_start and a.period_end
        and (
          public.has_permission(target_organization_id, 'visits.manage')
          or public.caregiver_has_active_assignment(target_organization_id, c.id, a.service_id)
          or public.caregiver_has_current_shift(target_organization_id, c.id, a.service_id)
        )
    ) as active_service_count
  from public.clients c
  join public.organizations o on o.id = c.organization_id
  left join lateral (
    select s.starts_at, s.ends_at
    from public.shifts s
    left join public.caregiver_records cr
      on cr.id = s.caregiver_record_id
     and cr.organization_id = s.organization_id
     and cr.deleted_at is null
    where s.organization_id = c.organization_id
      and s.client_id = c.id
      and s.status = 'scheduled'
      and (s.starts_at at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
        = (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
      and (
        public.has_permission(target_organization_id, 'visits.manage')
        or s.caregiver_user_id = auth.uid()
        or cr.linked_user_id = auth.uid()
      )
      and (
        select e.event_type
        from public.shift_coverage_events e
        where e.shift_id = s.id
        order by e.created_at desc
        limit 1
      ) is distinct from 'called_out'
    order by s.starts_at
    limit 1
  ) next_shift on true
  where c.organization_id = target_organization_id
    and c.deleted_at is null
    and c.status = 'active'
    and auth.uid() is not null
    and public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and (
      public.has_permission(target_organization_id, 'visits.manage')
      or public.caregiver_has_active_assignment(target_organization_id, c.id, null)
      or public.caregiver_has_current_shift(target_organization_id, c.id, null)
    )
  order by next_shift.starts_at nulls last,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code);
$$;

revoke all on function public.list_assigned_visit_clients(uuid) from public, anon;
grant execute on function public.list_assigned_visit_clients(uuid) to authenticated;

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
    sv.id,
    sv.code,
    sv.name,
    sv.color,
    a.id,
    a.max_monthly_hours,
    coalesce(used.hours, 0),
    coalesce(scheduled.hours, 0)
  from public.client_authorizations a
  join public.organizations o on o.id = a.organization_id
  join public.clients c
    on c.id = a.client_id
   and c.organization_id = a.organization_id
   and c.deleted_at is null
   and c.status = 'active'
  join public.services sv
    on sv.id = a.service_id
   and sv.organization_id = a.organization_id
   and sv.deleted_at is null
   and sv.is_active
  left join lateral (
    select coalesce(sum(v.billable_minutes), 0)::numeric / 60.0 as hours
    from public.service_visits v
    where v.service_authorization_id = a.id
      and v.service_date >= date_trunc(
        'month',
        (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::timestamp
      )::date
      and v.service_date < (
        date_trunc('month', (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::timestamp)
        + interval '1 month'
      )::date
      and v.status in ('signed', 'administrator_review')
  ) used on true
  left join lateral (
    select coalesce(sum(extract(epoch from (s.ends_at - s.starts_at)) / 3600.0), 0)::numeric as hours
    from public.shifts s
    where s.organization_id = a.organization_id
      and s.client_id = a.client_id
      and s.service_id = a.service_id
      and s.status = 'scheduled'
      and (s.starts_at at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date >= date_trunc(
        'month',
        (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::timestamp
      )::date
      and (s.starts_at at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date < (
        date_trunc('month', (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::timestamp)
        + interval '1 month'
      )::date
      and (
        select e.event_type
        from public.shift_coverage_events e
        where e.shift_id = s.id
        order by e.created_at desc
        limit 1
      ) is distinct from 'called_out'
  ) scheduled on true
  where a.organization_id = target_organization_id
    and a.client_id = target_client_id
    and a.deleted_at is null
    and auth.uid() is not null
    and public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
      between a.period_start and a.period_end
    and (
      public.has_permission(target_organization_id, 'visits.manage')
      or public.caregiver_has_active_assignment(target_organization_id, target_client_id, a.service_id)
      or public.caregiver_has_current_shift(target_organization_id, target_client_id, a.service_id)
    )
  order by sv.name, sv.code;
$$;

revoke all on function public.list_authorized_services_for_client(uuid, uuid) from public, anon;
grant execute on function public.list_authorized_services_for_client(uuid, uuid) to authenticated;

create or replace function public.start_ad_hoc_service_visit(
  target_organization_id uuid,
  target_client_id uuid,
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
  linked_shift_id uuid;
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

  -- Serialize starts per authenticated caregiver. Together with the existing
  -- partial unique index on draft visits, this also makes double taps safe.
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
     and not public.caregiver_has_active_assignment(target_organization_id, target_client_id, target_service_id)
     and not public.caregiver_has_current_shift(target_organization_id, target_client_id, target_service_id) then
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

  -- Link the visit to the caregiver's own scheduled shift for this client and
  -- service when one is in progress or about to start. Resolved on the server
  -- only; a visit with no matching shift stays unlinked (unscheduled).
  linked_shift_id := public.match_scheduled_shift_for_visit(
    target_organization_id,
    caregiver_record.id,
    auth.uid(),
    target_client_id,
    target_service_id,
    started_at
  );

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
    linked_shift_id,
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

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, source, metadata)
  values (
    target_organization_id,
    auth.uid(),
    'service_visit.started_ad_hoc',
    'service_visits',
    visit_id,
    'application',
    jsonb_build_object('scheduled_shift_id', linked_shift_id)
  );

  return visit_id;
end;
$$;

revoke all on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text) from public, anon;
grant execute on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text) to authenticated;

commit;
