begin;

-- Ogevia Service Verification v3
--
-- This is a mobile sign-in sheet, not EVV. It intentionally records no GPS.
-- Caregivers see only organization-owned client codes for clients assigned to
-- them, choose exactly one authorized service, and receive database timestamps.
-- An ended-but-unconfirmed visit remains resumable after a refresh. Manager
-- corrections preserve the signed record and reject impossible overlaps.

-- Enforce the single-open-visit rule across every visit starter, not only the
-- v3 RPC. The Care Team index also covers scheduled visits for a caregiver who
-- does not have a linked login. Replacing the draft-only index closes the gap
-- where an awaiting-signature visit previously allowed another draft visit.
drop index if exists public.service_visits_one_draft_per_caregiver;

create unique index service_visits_one_open_per_caregiver_user
  on public.service_visits (caregiver_user_id)
  where caregiver_user_id is not null
    and status in ('draft', 'awaiting_signature');

create unique index service_visits_one_open_per_caregiver_record
  on public.service_visits (caregiver_record_id)
  where caregiver_record_id is not null
    and status in ('draft', 'awaiting_signature');

-- Assignment checks use the organization's local date. The previous helper
-- used the database session's current_date (UTC in hosted Supabase), which could
-- incorrectly hide or allow an assignment around midnight Pacific time.
create or replace function public.caregiver_has_active_assignment(
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
  select public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and exists (
      select 1
      from public.caregiver_assignments ca
      join public.organizations o on o.id = ca.organization_id
      where ca.organization_id = target_organization_id
        and ca.caregiver_user_id = auth.uid()
        and ca.client_id = target_client_id
        and (target_service_id is null or ca.service_id = target_service_id)
        and ca.is_active
        and (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date >= ca.effective_start
        and (
          ca.effective_end is null
          or (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date <= ca.effective_end
        )
    );
$$;

revoke all on function public.caregiver_has_active_assignment(uuid, uuid, uuid) from public, anon;
grant execute on function public.caregiver_has_active_assignment(uuid, uuid, uuid) to authenticated;

-- One compact picker source for the mobile screen. No legal name, address,
-- date of birth, UCI, or other client detail is returned. Managers may use the
-- same screen for testing or an administrator-assisted visit; caregivers only
-- receive clients from their active assignment rows.
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
    c.client_code,
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
    )
  order by next_shift.starts_at nulls last, c.client_code;
$$;

revoke all on function public.list_assigned_visit_clients(uuid) from public, anon;
grant execute on function public.list_assigned_visit_clients(uuid) to authenticated;

-- Keep the legacy lookup callable during a rolling frontend deployment, but
-- make it code-only and stop returning a client's legal name.
create or replace function public.find_client_for_visit(
  target_organization_id uuid,
  search_term text
)
returns table (client_id uuid, client_code text, client_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_term text := lower(btrim(search_term));
  recent_failures integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.organization_is_active(target_organization_id)
     or not public.is_organization_member(target_organization_id) then
    raise exception 'Not an active member of this organization';
  end if;
  if normalized_term = '' then raise exception 'Enter a client ID'; end if;

  select count(*) into recent_failures
  from public.audit_logs
  where actor_user_id = auth.uid()
    and organization_id = target_organization_id
    and action = 'client_lookup.failed'
    and occurred_at > now() - interval '10 minutes';
  if recent_failures >= 5 then
    raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.';
  end if;

  return query
  select c.id, c.client_code, c.client_code
  from public.clients c
  where c.organization_id = target_organization_id
    and c.deleted_at is null
    and c.status = 'active'
    and lower(c.client_code) = normalized_term
    and (
      public.has_permission(target_organization_id, 'visits.manage')
      or public.caregiver_has_active_assignment(target_organization_id, c.id, null)
    )
  limit 1;

  if not found then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.failed', 'clients', 'application');
  end if;
end;
$$;

revoke all on function public.find_client_for_visit(uuid, text) from public, anon;
grant execute on function public.find_client_for_visit(uuid, text) to authenticated;

-- This superseded v2 picker returned a legal client name. No checked-in app
-- code calls it now; remove direct authenticated access so it cannot bypass
-- the v3 code-only caregiver boundary.
revoke all on function public.list_startable_shifts_for_client(uuid, uuid)
  from public, anon, authenticated;

-- Authorization usage is based on submitted visit records, while future
-- scheduled hours remain visible separately. Every row is still restricted to
-- a service assigned to the caregiver (unless the caller manages visits).
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
    )
  order by sv.name, sv.code;
$$;

revoke all on function public.list_authorized_services_for_client(uuid, uuid) from public, anon;
grant execute on function public.list_authorized_services_for_client(uuid, uuid) to authenticated;

-- Redact the legal-name field from the legacy active-visit RPC so an older
-- browser cannot bypass the v3 caregiver screen's code-only privacy rule.
create or replace function public.get_active_service_visit_v2(target_organization_id uuid)
returns table (
  visit_id uuid,
  visit_number text,
  client_code text,
  client_name text,
  service_code text,
  service_name text,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  time_in timestamptz,
  max_monthly_hours numeric,
  signed_minutes_this_month bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.visit_number_snapshot,
    v.client_code_snapshot,
    v.client_code_snapshot,
    sv.code,
    sv.name,
    s.starts_at,
    s.ends_at,
    v.time_in,
    a.max_monthly_hours,
    coalesce((
      select sum(v2.billable_minutes)::bigint
      from public.service_visits v2
      where v2.service_authorization_id = a.id
        and v2.id <> v.id
        and v2.service_date >= date_trunc('month', v.service_date::timestamp)::date
        and v2.service_date < (date_trunc('month', v.service_date::timestamp) + interval '1 month')::date
        and v2.status in ('signed', 'administrator_review')
    ), 0)
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  join public.client_authorizations a on a.id = v.service_authorization_id
  left join public.shifts s on s.id = v.scheduled_shift_id
  where v.organization_id = target_organization_id
    and v.caregiver_user_id = auth.uid()
    and public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and v.status = 'draft'
  limit 1;
$$;

revoke all on function public.get_active_service_visit_v2(uuid) from public, anon;
grant execute on function public.get_active_service_visit_v2(uuid) to authenticated;

-- V3 also returns an awaiting-signature visit. This is what lets a caregiver
-- refresh, close the browser, or recover from a weak connection after signing
-- out without losing the client confirmation screen.
create or replace function public.get_active_service_visit_v3(target_organization_id uuid)
returns table (
  visit_id uuid,
  visit_number text,
  client_code text,
  service_code text,
  service_name text,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  visit_status public.service_visit_status,
  max_monthly_hours numeric,
  confirmed_minutes_this_month bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.visit_number_snapshot,
    v.client_code_snapshot,
    sv.code,
    sv.name,
    s.starts_at,
    s.ends_at,
    v.time_in,
    v.time_out,
    v.worked_minutes,
    v.status,
    a.max_monthly_hours,
    coalesce((
      select sum(v2.billable_minutes)::bigint
      from public.service_visits v2
      where v2.service_authorization_id = a.id
        and v2.id <> v.id
        and v2.service_date >= date_trunc('month', v.service_date::timestamp)::date
        and v2.service_date < (date_trunc('month', v.service_date::timestamp) + interval '1 month')::date
        and v2.status in ('signed', 'administrator_review')
    ), 0)
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  join public.client_authorizations a on a.id = v.service_authorization_id
  left join public.shifts s on s.id = v.scheduled_shift_id
  where v.organization_id = target_organization_id
    and v.caregiver_user_id = auth.uid()
    and public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and v.status in ('draft', 'awaiting_signature')
  order by v.time_in desc
  limit 1;
$$;

revoke all on function public.get_active_service_visit_v3(uuid) from public, anon;
grant execute on function public.get_active_service_visit_v3(uuid) to authenticated;

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
    null,
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
    'service_visit.started_ad_hoc',
    'service_visits',
    visit_id,
    'application'
  );

  return visit_id;
end;
$$;

revoke all on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text) from public, anon;
grant execute on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text) to authenticated;

-- End is retry-safe: if the server ended the visit but the response was lost,
-- the same caregiver receives the original server timestamps instead of being
-- stranded by an "already ended" error.
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

  return query select target_visit.id, minutes, target_visit.time_in, ended_at;
end;
$$;

revoke all on function public.end_service_visit(uuid, text[], text) from public, anon;
grant execute on function public.end_service_visit(uuid, text[], text) to authenticated;

-- A client/guardian signature can confirm worked and billable minutes. If no
-- signer is available, the visit remains visibly unverified, contributes zero
-- billable minutes, and is routed to manager review. A manager cannot use this
-- RPC to manufacture a confirmation for another caregiver's visit.
create or replace function public.confirm_service_visit(
  target_visit_id uuid,
  signer_role public.visit_signer_role,
  confirmation_method text,
  signature_storage_path text default null,
  typed_signer_name text default null,
  signer_relationship text default null,
  confirmation_reason text default null
)
returns table (
  visit_id uuid,
  status public.service_visit_status,
  authorization_status public.visit_authorization_status,
  worked_minutes integer,
  billable_minutes integer,
  month_to_date_minutes bigint,
  remaining_minutes bigint
)
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  target_visit public.service_visits%rowtype;
  target_auth public.client_authorizations%rowtype;
  target_service public.services%rowtype;
  prior_minutes bigint;
  potential_billable_minutes integer;
  allowed_minutes integer;
  resulting_auth_status public.visit_authorization_status;
  resulting_visit_status public.service_visit_status;
  snapshot jsonb;
  cap_minutes integer;
  is_confirmed boolean;
  method text := lower(btrim(coalesce(confirmation_method, '')));
  signer_name text := nullif(btrim(coalesce(typed_signer_name, '')), '');
  relationship text := nullif(btrim(coalesce(signer_relationship, '')), '');
  reason_text text := nullif(btrim(coalesce(confirmation_reason, '')), '');
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if method not in ('draw', 'typed', 'verbal', 'assisted_mark', 'unable_to_confirm') then
    raise exception 'Choose a valid confirmation method';
  end if;

  select * into target_visit
  from public.service_visits v
  where v.id = target_visit_id
  for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if not public.organization_is_active(target_visit.organization_id)
     or not public.is_organization_member(target_visit.organization_id) then
    raise exception 'Your organization access is no longer active';
  end if;
  if target_visit.caregiver_user_id is distinct from auth.uid() then
    raise exception 'Only the caregiver who recorded this visit can submit its client confirmation';
  end if;
  if target_visit.status <> 'awaiting_signature' then
    raise exception 'Visit is already locked or is not ready for confirmation';
  end if;

  is_confirmed := method in ('draw', 'assisted_mark');
  if is_confirmed then
    if signature_storage_path is null
       or signature_storage_path <> target_visit.organization_id::text || '/' || target_visit.id::text || '/client-signature.png' then
      raise exception 'A signature or mark is required';
    end if;
    if not exists (
      select 1
      from storage.objects
      where bucket_id = 'visit-signatures'
        and name = signature_storage_path
    ) then
      raise exception 'Signature upload was not found';
    end if;
  elsif method in ('typed', 'verbal') and signer_name is null then
    raise exception 'Enter the name of the person confirming the visit';
  elsif method = 'unable_to_confirm' and reason_text is null then
    raise exception 'Explain why confirmation could not be obtained';
  end if;

  select * into target_auth
  from public.client_authorizations a
  where a.id = target_visit.service_authorization_id
  for update;
  if target_auth.id is null then raise exception 'The visit authorization no longer exists'; end if;
  select * into target_service from public.services where id = target_visit.service_id;

  select coalesce(sum(v.billable_minutes), 0)::bigint into prior_minutes
  from public.service_visits v
  where v.service_authorization_id = target_auth.id
    and v.id <> target_visit.id
    and v.service_date >= date_trunc('month', target_visit.service_date::timestamp)::date
    and v.service_date < (date_trunc('month', target_visit.service_date::timestamp) + interval '1 month')::date
    and v.status in ('signed', 'administrator_review');

  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;
  potential_billable_minutes := greatest(
    0,
    least(target_visit.worked_minutes, cap_minutes - prior_minutes::integer)
  );

  if potential_billable_minutes < target_visit.worked_minutes then
    resulting_auth_status := 'exceeds_authorization';
  elsif prior_minutes + potential_billable_minutes >= cap_minutes then
    resulting_auth_status := 'limit_reached';
  else
    resulting_auth_status := 'within_authorization';
  end if;

  if is_confirmed then
    allowed_minutes := potential_billable_minutes;
    resulting_visit_status := case
      when potential_billable_minutes < target_visit.worked_minutes then 'administrator_review'
      else 'signed'
    end;
  else
    allowed_minutes := 0;
    resulting_visit_status := 'administrator_review';
  end if;

  snapshot := jsonb_build_object(
    'clientCode', target_visit.client_code_snapshot,
    'caregiverName', target_visit.caregiver_name_snapshot,
    'serviceName', target_service.name,
    'serviceCode', target_service.code,
    'serviceDate', target_visit.service_date,
    'timeIn', target_visit.time_in,
    'timeOut', target_visit.time_out,
    'workedMinutes', target_visit.worked_minutes,
    'verifiedMinutes', case when is_confirmed then target_visit.worked_minutes else 0 end,
    'billableMinutes', allowed_minutes,
    'signerRole', signer_role,
    'confirmationMethod', method,
    'typedSignerName', signer_name,
    'signerRelationship', relationship,
    'confirmationReason', reason_text,
    'caregiverAttestedAt', target_visit.caregiver_attested_at,
    'timeZone', 'America/Los_Angeles',
    'confirmationVersion', 3,
    'monthToDateBeforeMinutes', prior_minutes,
    'monthToDateAfterMinutes', prior_minutes + allowed_minutes,
    'authorizedMinutes', cap_minutes,
    'remainingMinutes', greatest(0, cap_minutes - prior_minutes - allowed_minutes)
  );

  insert into public.visit_signatures (
    organization_id,
    visit_id,
    signer_role,
    storage_path,
    signed_visit_snapshot,
    confirmation_method,
    typed_signer_name,
    signer_relationship,
    confirmation_reason
  ) values (
    target_visit.organization_id,
    target_visit.id,
    signer_role,
    signature_storage_path,
    snapshot,
    method,
    signer_name,
    relationship,
    reason_text
  );

  update public.service_visits
  set verified_minutes = case when is_confirmed then target_visit.worked_minutes else 0 end,
      billable_minutes = allowed_minutes,
      status = resulting_visit_status,
      authorization_status = resulting_auth_status,
      -- signed_at is the legacy schema's required submission timestamp for
      -- both signed and administrator_review rows. confirmation_method remains
      -- the source of truth for whether a client signature actually exists.
      signed_at = now(),
      locked_at = now()
  where id = target_visit.id;

  return query
  select
    target_visit.id,
    resulting_visit_status,
    resulting_auth_status,
    target_visit.worked_minutes,
    allowed_minutes,
    prior_minutes + allowed_minutes,
    greatest(0, cap_minutes::bigint - prior_minutes - allowed_minutes);
end;
$$;

revoke all on function public.confirm_service_visit(uuid, public.visit_signer_role, text, text, text, text, text) from public, anon;
grant execute on function public.confirm_service_visit(uuid, public.visit_signer_role, text, text, text, text, text) to authenticated;

-- Manager corrections retain the original row, reason, actor, and before/after
-- values. Corrections cannot end in the future, leave the authorization period,
-- or overlap another recorded visit for the same caregiver.
create or replace function public.correct_service_visit(
  target_visit_id uuid,
  new_time_in timestamptz,
  new_time_out timestamptz,
  reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  original public.service_visits%rowtype;
  target_auth public.client_authorizations%rowtype;
  corrected_id uuid;
  minutes integer;
  prior_minutes bigint;
  allowed_minutes integer;
  cap_minutes integer;
  resulting_auth_status public.visit_authorization_status;
  resulting_visit_status public.service_visit_status;
  before_snap jsonb;
  after_snap jsonb;
  organization_timezone text;
  corrected_service_date date;
  corrected_end_service_date date;
  original_was_confirmed boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to correct a visit';
  end if;
  if new_time_out <= new_time_in then raise exception 'Time out must be after time in'; end if;
  if new_time_out > now() then raise exception 'Corrected time out cannot be in the future'; end if;

  select * into original
  from public.service_visits v
  where v.id = target_visit_id
  for update;
  if original.id is null then raise exception 'Visit not found'; end if;
  if not public.has_permission(original.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to correct visits for this organization';
  end if;
  if original.status not in ('signed', 'administrator_review') then
    raise exception 'Only a submitted visit can be corrected';
  end if;

  minutes := floor(extract(epoch from (new_time_out - new_time_in)) / 60)::integer;
  if minutes < 1 or minutes > 1440 then
    raise exception 'Corrected duration must be between 1 minute and 24 hours';
  end if;

  select coalesce(o.timezone, 'America/Los_Angeles') into organization_timezone
  from public.organizations o
  where o.id = original.organization_id;
  corrected_service_date := (new_time_in at time zone organization_timezone)::date;
  corrected_end_service_date := (new_time_out at time zone organization_timezone)::date;

  select * into target_auth
  from public.client_authorizations a
  where a.organization_id = original.organization_id
    and a.client_id = original.client_id
    and a.service_id = original.service_id
    and a.deleted_at is null
    and corrected_service_date between a.period_start and a.period_end
    and corrected_end_service_date between a.period_start and a.period_end
  order by a.period_start desc
  limit 1
  for update;
  if target_auth.id is null then
    raise exception 'The corrected time is outside an active authorization period';
  end if;

  if exists (
    select 1
    from public.service_visits v
    where v.organization_id = original.organization_id
      and v.id <> original.id
      and v.status not in ('voided', 'corrected')
      and (
        (original.caregiver_user_id is not null and v.caregiver_user_id = original.caregiver_user_id)
        or (original.caregiver_record_id is not null and v.caregiver_record_id = original.caregiver_record_id)
      )
      and v.time_in < new_time_out
      and coalesce(v.time_out, now()) > new_time_in
  ) then
    raise exception 'The corrected time overlaps another visit for this caregiver';
  end if;

  select exists (
    select 1
    from public.visit_signatures vs
    where vs.visit_id in (original.id, original.original_visit_id)
      and (
        vs.confirmation_method in ('draw', 'assisted_mark')
        or (
          vs.confirmation_method in ('typed', 'verbal')
          and coalesce(vs.signed_visit_snapshot->>'confirmationVersion', '2') in ('1', '2')
        )
      )
  ) into original_was_confirmed;

  select coalesce(sum(v.billable_minutes), 0)::bigint into prior_minutes
  from public.service_visits v
  where v.service_authorization_id = target_auth.id
    and v.id <> original.id
    and v.service_date >= date_trunc('month', corrected_service_date::timestamp)::date
    and v.service_date < (date_trunc('month', corrected_service_date::timestamp) + interval '1 month')::date
    and v.status in ('signed', 'administrator_review');

  cap_minutes := round(target_auth.max_monthly_hours * 60)::integer;
  if original_was_confirmed then
    allowed_minutes := greatest(0, least(minutes, cap_minutes - prior_minutes::integer));
  else
    allowed_minutes := 0;
  end if;

  if not original_was_confirmed then
    resulting_auth_status := case
      when greatest(0, least(minutes, cap_minutes - prior_minutes::integer)) < minutes then 'exceeds_authorization'
      when prior_minutes + minutes >= cap_minutes then 'limit_reached'
      else 'within_authorization'
    end;
    resulting_visit_status := 'administrator_review';
  elsif allowed_minutes < minutes then
    resulting_auth_status := 'exceeds_authorization';
    resulting_visit_status := 'administrator_review';
  else
    resulting_auth_status := 'administrator_override';
    resulting_visit_status := 'signed';
  end if;

  before_snap := jsonb_build_object(
    'visitId', original.id,
    'visitNumber', original.visit_number_snapshot,
    'timeIn', original.time_in,
    'timeOut', original.time_out,
    'workedMinutes', original.worked_minutes,
    'verifiedMinutes', original.verified_minutes,
    'billableMinutes', original.billable_minutes,
    'status', original.status,
    'authorizationId', original.service_authorization_id
  );
  after_snap := jsonb_build_object(
    'timeIn', new_time_in,
    'timeOut', new_time_out,
    'workedMinutes', minutes,
    'verifiedMinutes', case when original_was_confirmed then minutes else 0 end,
    'billableMinutes', allowed_minutes,
    'status', resulting_visit_status,
    'authorizationId', target_auth.id,
    'managerCorrected', true,
    'clientConfirmationSourceVisitId', case
      when original_was_confirmed then coalesce(original.original_visit_id, original.id)
      else null
    end
  );

  update public.service_visits set status = 'corrected' where id = original.id;

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
    time_out,
    worked_minutes,
    verified_minutes,
    billable_minutes,
    task_categories,
    service_notes,
    caregiver_attested_at,
    status,
    authorization_status,
    signed_at,
    locked_at,
    original_visit_id,
    correction_reason,
    created_by,
    visit_number_snapshot
  ) values (
    original.organization_id,
    original.client_id,
    original.client_code_snapshot,
    original.caregiver_user_id,
    original.caregiver_record_id,
    original.caregiver_name_snapshot,
    original.scheduled_shift_id,
    target_auth.id,
    original.service_id,
    corrected_service_date,
    new_time_in,
    new_time_out,
    minutes,
    case when original_was_confirmed then minutes else 0 end,
    allowed_minutes,
    original.task_categories,
    original.service_notes,
    original.caregiver_attested_at,
    resulting_visit_status,
    resulting_auth_status,
    now(),
    now(),
    coalesce(original.original_visit_id, original.id),
    btrim(reason),
    auth.uid(),
    original.visit_number_snapshot
  ) returning id into corrected_id;

  insert into public.visit_corrections (
    organization_id,
    original_visit_id,
    corrected_visit_id,
    corrected_by,
    reason,
    before_snapshot,
    after_snapshot
  ) values (
    original.organization_id,
    original.id,
    corrected_id,
    auth.uid(),
    btrim(reason),
    before_snap,
    after_snap
  );

  return corrected_id;
end;
$$;

revoke all on function public.correct_service_visit(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.correct_service_visit(uuid, timestamptz, timestamptz, text) to authenticated;

commit;
