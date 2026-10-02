begin;

-- Link Service Verification visits to the scheduled shift they deliver.
--
-- Until now start_ad_hoc_service_visit() (20260824010000) always stored
-- scheduled_shift_id = null, so:
--   * a visit was never compared with the shift it delivered;
--   * shifts moved to 'completed' only when staff changed the status by hand,
--     and the Authorizations page counts "used" hours from completed shifts.
--
-- This migration:
--   1. match_scheduled_shift_for_visit(): finds the caller's own still
--      'scheduled' shift for the same client and service that is in progress,
--      or starts within the early-arrival window, at the server's Time In.
--      Excluded: shifts whose latest coverage event is a call-out, and shifts
--      that already have a live visit (also enforced by the existing
--      service_visits_shift_unique index). A shift already in progress wins
--      over a later one; otherwise the nearest start time wins. Caregivers
--      cannot be double-booked (shift overlap triggers), so the match is
--      unambiguous. The shift row is locked for the rest of the transaction.
--   2. start_ad_hoc_service_visit(): stores the matched shift. No match means
--      the visit stays unlinked, exactly as today; nothing new is refused.
--   3. end_service_visit(): Time Out moves the linked shift from 'scheduled'
--      to 'completed'. The shift validation triggers return early for any
--      status other than 'scheduled', so this cannot block Time Out.
--   4. list_service_visits(): returns the linked shift id and its scheduled
--      start/end so visit records can show scheduled vs actual.
--
-- Not changed: existing visits (no backfill; signed records stay as they
-- are), void_service_visit() (not reachable from the app), corrections (they
-- already copy scheduled_shift_id to the corrected row), billing rules.
--
-- The client never supplies a shift id. Permission checks, search_path and
-- grants of the three existing functions are unchanged.

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
  -- How early a caregiver can sign in and still be matched to the shift.
  -- A matching window only: it never refuses or shortens a visit.
  early_arrival constant interval := interval '60 minutes';
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

create or replace function public.end_service_visit(
  target_visit_id uuid,
  visit_task_categories text[] default null,
  visit_service_notes text default null
)
returns table (
  visit_id uuid,
  worked_minutes integer,
  time_in timestamptz,
  time_out timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_visit public.service_visits%rowtype;
  ended_at timestamptz := now();
  minutes integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into target_visit
  from public.service_visits v
  where v.id = target_visit_id
  for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if not public.organization_is_active(target_visit.organization_id)
     or (
       not public.is_organization_member(target_visit.organization_id)
       and not public.has_permission(target_visit.organization_id, 'visits.manage')
     ) then
    raise exception 'Your organization access is no longer active';
  end if;
  if target_visit.caregiver_user_id is distinct from auth.uid()
     and not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'You cannot end another caregiver''s visit';
  end if;

  if target_visit.status = 'awaiting_signature' and target_visit.time_out is not null then
    return query
    select target_visit.id, target_visit.worked_minutes, target_visit.time_in, target_visit.time_out;
    return;
  end if;
  if target_visit.status <> 'draft' then raise exception 'Visit has already been ended'; end if;

  minutes := floor(extract(epoch from (ended_at - target_visit.time_in)) / 60)::integer;
  if minutes < 1 then raise exception 'A visit must last at least one minute before it can be ended'; end if;
  if minutes > 1440 then
    raise exception 'This visit has been open for over 24 hours - contact a manager to resolve it';
  end if;

  update public.service_visits
  set time_out = ended_at,
      worked_minutes = minutes,
      caregiver_attested_at = ended_at,
      status = 'awaiting_signature',
      task_categories = coalesce(visit_task_categories, task_categories),
      service_notes = coalesce(nullif(trim(visit_service_notes), ''), service_notes)
  where id = target_visit.id;

  -- The linked shift has been delivered. Only a still-scheduled shift moves;
  -- a shift cancelled or already completed by staff is left as it is. The
  -- shift validation triggers only run for status 'scheduled', so this
  -- cannot block the caregiver's Time Out.
  if target_visit.scheduled_shift_id is not null then
    update public.shifts
    set status = 'completed',
        updated_by = auth.uid()
    where id = target_visit.scheduled_shift_id
      and organization_id = target_visit.organization_id
      and status = 'scheduled';
  end if;

  return query select target_visit.id, minutes, target_visit.time_in, ended_at;
end;
$$;

revoke all on function public.end_service_visit(uuid, text[], text) from public, anon;
grant execute on function public.end_service_visit(uuid, text[], text) to authenticated;

-- Return type changes, so the function is dropped and recreated.
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
  remaining_minutes bigint,
  scheduled_shift_id uuid,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz
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
    (vs.signed_visit_snapshot->>'remainingMinutes')::bigint,
    v.scheduled_shift_id,
    sh.starts_at,
    sh.ends_at
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  left join public.clients c on c.id = v.client_id
  left join public.visit_signatures vs on vs.visit_id = v.id
  left join public.shifts sh on sh.id = v.scheduled_shift_id
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
