-- 0042 Commit-time readiness gate, enforcement transition, availability override (caregiver-readiness release).
--
-- One gate, used by every path that commits a caregiver to work, decides whether the caregiver may be
-- committed for a specific interval. It keeps the checks SEPARATE and reports each on its own:
--     caregiver status | Approved services | CPR | TB | availability | already booked
-- and never lets one stand in for another. A score (0043) never overrides a failed check.
--
-- ENFORCEMENT IS NOT AUTOMATIC. Every agency starts in REPORT-ONLY mode: the gate computes and reports what
-- would be blocked, and nothing existing is stranded. An administrator reviews the readiness report
-- (setup gaps, who and what would be blocked) and then activates enforcement (audited, owner only).
--   * Once active: CPR/TB (verified, current, covering the whole interval) and approved availability are required
--     before new shifts, recurring series, reschedules, reassignments, care-request assignments and new
--     standing assignments, and CPR/TB (and service approval when on) before a caregiver starts a new visit.
--   * "Service checks" is a separate On/Off switch (default Off). Turning it Off never disables CPR/TB,
--     availability or any other safety check. When Off the screens say: "Service checks: Off",
--     "Caregivers can be assigned without service approval.", action "Review services".
--   * Care-request assignment keeps requiring approved availability at all times (it did before this release).
--   * An administrator with availability.override may authorise ONE caregiver/time-range exception with a
--     recorded reason (30 minutes to use). It lifts only the availability check; never service approval,
--     documents, tenant permissions, caregiver status or double-booking.
--   * Not enforced here: manager-started visits (unscheduled visits a manager approves are not changed
--     retroactively) and visits already in progress (never interrupted). Client mandatory requirements are
--     checked through ogevia.client_requirement_issues (extended in 0043).
--
-- Locking: every commit-time check and every readiness change (service approve/revoke, document review,
-- policy change) first takes ogevia.lock_caregiver(caregiver) - the same advisory lock the overlap check already
-- used - so a revocation, a verification and an assignment can never interleave on the same caregiver.
-- Error SQLSTATE OGR30 = not ready; the message lists exactly the failed checks.

insert into ogevia.permissions (key, description) values
  ('readiness.read', 'View caregiver readiness, setup gaps and affected work'),
  ('readiness.manage', 'Activate readiness enforcement and turn Service checks on or off'),
  ('availability.override', 'Authorise an availability exception for one caregiver and time range, with a reason');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'readiness.read'),
  ('manager', 'readiness.read'),
  ('scheduler', 'readiness.read'),
  ('organization_owner', 'readiness.manage'),
  ('organization_owner', 'availability.override');

create table ogevia.organization_readiness_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  enforcement_active_from timestamptz,
  enforcement_activated_by uuid references ogevia.app_users(id),
  service_checks boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references ogevia.app_users(id)
);
alter table ogevia.organization_readiness_settings enable row level security;

create table ogevia.readiness_setting_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  setting text not null check (setting in ('enforcement', 'service_checks')),
  old_value text,
  new_value text not null,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  report jsonb,
  changed_by uuid not null references ogevia.app_users(id),
  changed_at timestamptz not null default now()
);
alter table ogevia.readiness_setting_events enable row level security;

create table ogevia.availability_overrides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  range_start timestamptz not null,
  range_end timestamptz not null,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  authorised_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_count integer not null default 0,
  last_used_at timestamptz,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint availability_overrides_range check (range_end > range_start and range_end - range_start <= interval '400 days')
);
create index availability_overrides_lookup_idx on ogevia.availability_overrides (caregiver_record_id, expires_at);
alter table ogevia.availability_overrides enable row level security;

-- Series skipped dates may now also record readiness reasons.
alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check check (
  reason in ('exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started',
             'time_does_not_exist', 'time_occurs_twice',
             'documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided'));

-- ---------------------------------------------------------------------------
-- The checks
-- ---------------------------------------------------------------------------

-- The words shown for a failed check. One place, so the screens and the API never disagree.
create function ogevia.readiness_message(p_check text, p_code text)
returns text
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select case
    when p_check in ('cpr', 'tb') then
      upper(p_check) || case p_code
        when 'missing' then ' missing.'
        when 'awaiting_review' then ' needs review.'
        when 'rejected' then ' rejected.'
        when 'expired' then ' expired.'
        when 'expires_during' then ' expires before this work ends.'
        when 'expiry_missing' then ' expiry date missing.'
        when 'policy_not_set' then ' rule not set (setup incomplete).'
        when 'type_not_set' then ' record not set up (setup incomplete).'
        else ' not current.' end
    when p_check = 'service' then
      case p_code
        when 'service_partial' then 'Not approved for this service for the whole shift.'
        when 'service_revoked' then 'Service approval revoked.'
        when 'service_expired' then 'Service approval expired.'
        else 'Not approved for this service.' end
    when p_check = 'availability' then
      case p_code
        when 'availability_not_provided' then 'Availability not provided.'
        when 'availability_override' then 'Availability overridden by an administrator.'
        else 'Outside approved hours.' end
    when p_check = 'conflict' then 'Already booked.'
    when p_check = 'caregiver' then 'Caregiver is not active.'
    when p_check = 'client' then 'A mandatory client requirement is not met.'
    else 'Not ready.' end;
$$;

-- Does this check block, for this agency, in this context?
create function ogevia.readiness_enforced(p_organization_id uuid, p_check text, p_context text)
returns boolean
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare s ogevia.organization_readiness_settings%rowtype; v_active boolean;
begin
  select * into s from ogevia.organization_readiness_settings x where x.organization_id = p_organization_id;
  v_active := s.organization_id is not null and s.enforcement_active_from is not null and s.enforcement_active_from <= now();
  return case p_check
    when 'caregiver' then true
    when 'conflict' then true
    when 'cpr' then v_active
    when 'tb' then v_active
    when 'client' then v_active
    when 'availability' then v_active or p_context = 'care_request'
    when 'service' then v_active and coalesce(s.service_checks, false)
    else v_active end;
end;
$$;

-- Hook for recorded mandatory client requirements (filled in by 0043). No issues until then.
create function ogevia.client_requirement_issues(p_organization_id uuid, p_client_id uuid, p_caregiver_record_id uuid)
returns table (code text, message text)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select null::text, null::text where false;
$$;

-- Every check, separately. status: ok | blocked | overridden | not_checked. enforced says whether a blocked
-- check actually stops the commit in this agency right now. Reads only (safe in stable callers).
create function ogevia.readiness_checks(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz,
  p_context text default 'shift', p_exclude_shift uuid default null, p_client_id uuid default null, p_with_conflict boolean default false
)
returns table (check_name text, status text, code text, message text, enforced boolean)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_st text;
  d record;
  i record;
  v_ov boolean;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if p_context = 'assignment' then
    -- A standing assignment may be prepared for a caregiver who is not Ready yet; it grants nothing until they are.
    null;
  elsif v_rec.id is null or v_rec.status not in ('ready', 'active') then
    return query select 'caregiver'::text, 'blocked'::text, 'caregiver_not_active'::text, ogevia.readiness_message('caregiver', null), true;
  else
    return query select 'caregiver'::text, 'ok'::text, null::text, null::text, true;
  end if;

  if p_service_id is null then
    return query select 'service'::text, 'not_checked'::text, null::text, null::text, false;
  else
    v_st := ogevia.service_approval_status(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends);
    return query select 'service'::text, case when v_st = 'approved' then 'ok' else 'blocked' end,
                        case when v_st = 'approved' then null else 'service_' || v_st end,
                        case when v_st = 'approved' then null else ogevia.readiness_message('service', 'service_' || v_st) end,
                        ogevia.readiness_enforced(p_organization_id, 'service', p_context);
  end if;

  for d in select * from ogevia.document_readiness(p_organization_id, p_caregiver_record_id, p_starts, p_ends) loop
    return query select d.requirement, case when d.status = 'ok' then 'ok' else 'blocked' end,
                        case when d.status = 'ok' then null else d.status end,
                        case when d.status = 'ok' then null else ogevia.readiness_message(d.requirement, d.status) end,
                        ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
  end loop;

  if p_context in ('shift', 'care_request', 'reschedule', 'series') then
    v_st := ogevia.availability_status(p_organization_id, p_caregiver_record_id, p_starts, p_ends);
    if v_st = 'covered' then
      return query select 'availability'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
    else
      v_ov := exists (select 1 from ogevia.availability_overrides o
                      where o.organization_id = p_organization_id and o.caregiver_record_id = p_caregiver_record_id
                        and o.expires_at > now() and o.range_start <= p_starts and o.range_end >= p_ends);
      if v_ov then
        return query select 'availability'::text, 'overridden'::text, 'availability_override'::text,
                            ogevia.readiness_message('availability', 'availability_override'), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      else
        return query select 'availability'::text, 'blocked'::text, 'availability_' || v_st,
                            ogevia.readiness_message('availability', 'availability_' || v_st), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      end if;
    end if;
  end if;

  if p_with_conflict then
    if exists (
      select 1 from ogevia.shifts s
      where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
        and (s.caregiver_record_id = p_caregiver_record_id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
        and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
        and s.starts_at < p_ends and s.ends_at > p_starts) then
      return query select 'conflict'::text, 'blocked'::text, 'already_booked'::text, ogevia.readiness_message('conflict', null), true;
    else
      return query select 'conflict'::text, 'ok'::text, null::text, null::text, true;
    end if;
  end if;

  if p_client_id is not null then
    for i in select * from ogevia.client_requirement_issues(p_organization_id, p_client_id, p_caregiver_record_id) loop
      return query select 'client'::text, 'blocked'::text, i.code, coalesce(i.message, ogevia.readiness_message('client', null)),
                          ogevia.readiness_enforced(p_organization_id, 'client', p_context);
    end loop;
  end if;
end;
$$;

-- The commit-time gate. The CALLER must already hold ogevia.lock_caregiver(caregiver). Raises OGR30 listing the
-- failed, enforced checks. Report-only agencies pass (except care-request availability, which was always required).
create function ogevia.assert_ready_for_work(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz,
  p_context text default 'shift', p_client_id uuid default null
)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_msgs text;
  v_codes text;
  v_ov uuid;
begin
  select string_agg(c.message, ' ' order by c.check_name), string_agg(c.check_name || ':' || c.code, ',' order by c.check_name)
    into v_msgs, v_codes
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, p_context, null, p_client_id, false) c
  where c.status = 'blocked' and c.enforced;
  if v_msgs is not null then
    raise exception '%', v_msgs using errcode = 'OGR30', detail = v_codes;
  end if;
  -- Record every use of an availability override (reason and authoriser are on the override itself).
  if exists (select 1 from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, p_context, null, null, false) c
             where c.check_name = 'availability' and c.status = 'overridden') then
    update ogevia.availability_overrides o set used_count = o.used_count + 1, last_used_at = now()
     where o.id = (select x.id from ogevia.availability_overrides x
                   where x.organization_id = p_organization_id and x.caregiver_record_id = p_caregiver_record_id
                     and x.expires_at > now() and x.range_start <= p_starts and x.range_end >= p_ends
                   order by x.created_at desc limit 1)
    returning o.id into v_ov;
    if v_ov is not null then
      perform ogevia.write_audit(p_organization_id, 'availability.override_used', 'availability_overrides', v_ov, null,
        jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'starts_at', p_starts, 'ends_at', p_ends, 'context', p_context), null);
    end if;
  end if;
end;
$$;

-- A standing assignment is a relationship, not permission to do a dated visit: it must be ready on its first
-- day (documents and, when on, service approval). Each dated visit is checked again when it is started.
create function ogevia.assert_ready_for_assignment(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_first_day date
)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare v_tz text;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  perform ogevia.assert_ready_for_work(p_organization_id, p_caregiver_record_id, p_service_id,
    p_first_day::timestamp at time zone v_tz, (p_first_day + 1)::timestamp at time zone v_tz, 'assignment');
end;
$$;

-- The series outcome (or null) for one occurrence; reads only, so the stable series evaluation can use it.
create function ogevia.readiness_outcome(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz
)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when bool_or(c.check_name in ('cpr', 'tb')) then 'documents_not_current'
    when bool_or(c.check_name = 'service') then 'service_not_approved'
    when bool_or(c.check_name = 'availability' and c.code = 'availability_not_provided') then 'availability_not_provided'
    when bool_or(c.check_name = 'availability') then 'availability_outside'
  end
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, 'series') c
  where c.status = 'blocked' and c.enforced and c.check_name <> 'caregiver';
$$;

-- check_shift_caregiver: status, overlap (unchanged), then the gate. The 5-argument form that existed
-- before keeps working but cannot know the service, so the service check is skipped for callers that
-- have not been moved to the 6-argument form (none remain in the database; a test proves it).
create function ogevia.check_shift_caregiver(
  p_organization_id uuid, p_caregiver_record_id uuid, p_starts timestamptz, p_ends timestamptz, p_exclude_shift uuid, p_service_id uuid
)
returns ogevia.caregiver_records
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare v_rec ogevia.caregiver_records%rowtype;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status not in ('ready', 'active') then
    raise exception 'Only caregivers who are Ready to work or Active can be scheduled' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_caregiver(v_rec.id);
  if exists (
    select 1 from ogevia.shifts s
    where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
      and (s.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
      and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
      and s.starts_at < p_ends and s.ends_at > p_starts) then
    raise exception 'This caregiver already has a shift at that time' using errcode = 'OGC09';
  end if;
  perform ogevia.assert_ready_for_work(p_organization_id, v_rec.id, p_service_id, p_starts, p_ends,
    case when p_exclude_shift is null then 'shift' else 'reschedule' end);
  return v_rec;
end;
$$;

create or replace function ogevia.check_shift_caregiver(
  p_organization_id uuid, p_caregiver_record_id uuid, p_starts timestamptz, p_ends timestamptz, p_exclude_shift uuid
)
returns ogevia.caregiver_records
language sql
volatile
set search_path = ogevia, pg_temp
as $$
  select * from ogevia.check_shift_caregiver(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_exclude_shift, null::uuid);
$$;

-- Moved onto the gate (each call below is the only change from the previous definition):
create or replace function ogevia_api.create_shift(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_local_date date, p_start time, p_end time,
  p_caregiver_record_id uuid default null, p_idempotency_key uuid default null
)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, reserved_minutes integer, remaining_minutes bigint)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_service_id, p_local_date, p_start, p_end, p_caregiver_record_id);
  v_prior jsonb;
  v_tz text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_minutes integer;
  v_auth ogevia.client_authorizations%rowtype;
  v_used bigint;
  v_reserved bigint;
  v_rec ogevia.caregiver_records%rowtype;
  v_id uuid := gen_random_uuid();
begin
  v_prior := ogevia.idempotency_begin('create_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'shift_id')::uuid, (v_prior ->> 'starts_at')::timestamptz, (v_prior ->> 'ends_at')::timestamptz,
                        (v_prior ->> 'reserved_minutes')::integer, (v_prior ->> 'remaining_minutes')::bigint;
    return;
  end if;
  if p_local_date is null or p_start is null or p_end is null then
    raise exception 'Enter the date, start time and end time' using errcode = 'OGV22';
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  perform ogevia.require_clear_local_times(v_tz, p_local_date, p_start, p_end);
  v_starts := (p_local_date + p_start) at time zone v_tz;
  v_ends := (case when p_end <= p_start then p_local_date + 1 else p_local_date end + p_end) at time zone v_tz;
  v_minutes := floor(extract(epoch from (v_ends - v_starts)) / 60)::integer;
  if v_minutes < 15 or v_minutes > 1440 then
    raise exception 'A shift must be between 15 minutes and 24 hours' using errcode = 'OGV22';
  end if;
  if v_ends <= now() then
    raise exception 'This shift is already over; record past service as a visit instead' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id
                 and c.deleted_at is null and c.status = 'active') then
    raise exception 'The client must be active in this agency' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id
                 and s.deleted_at is null and s.is_active) then
    raise exception 'The service must be active in this agency' using errcode = 'OGV22';
  end if;

  select * into v_auth from ogevia.client_authorizations a
  where a.organization_id = p_organization_id and a.client_id = p_client_id and a.service_id = p_service_id
    and a.is_current and a.deleted_at is null and p_local_date between a.period_start and a.period_end;
  if v_auth.id is null then
    raise exception 'No current authorization covers this client and service on that date' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_authorization_lineage(v_auth.lineage_id);
  v_used := ogevia.authorization_month_usage(v_auth.lineage_id, p_local_date, null);
  v_reserved := ogevia.authorization_month_reserved(v_auth.lineage_id, p_local_date);
  if v_used + v_reserved + v_minutes > v_auth.monthly_authorized_minutes then
    -- 0032: hours and minutes, with what the shift needs (was "179 minutes left").
    raise exception 'Not enough authorized time remains this month for this shift: % available, this shift needs %',
      ogevia.format_duration(greatest(v_auth.monthly_authorized_minutes - v_used - v_reserved, 0)::integer),
      ogevia.format_duration(v_minutes::integer) using errcode = 'OGC09';
  end if;

  if p_caregiver_record_id is not null then
    v_rec := ogevia.check_shift_caregiver(p_organization_id, p_caregiver_record_id, v_starts, v_ends, null, p_service_id);
  end if;

  insert into ogevia.shifts (id, organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id,
                             starts_at, ends_at, status, authorization_lineage_id, created_by)
  values (v_id, p_organization_id, p_client_id, p_service_id, v_rec.linked_user_id, v_rec.id,
          v_starts, v_ends, 'scheduled', v_auth.lineage_id, v_actor);
  insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
  values (p_organization_id, v_auth.lineage_id, null, v_id, p_local_date, v_minutes);
  perform ogevia.write_audit(p_organization_id, 'shift.created', 'shifts', v_id, null,
    jsonb_build_object('client_id', p_client_id, 'service_id', p_service_id, 'starts_at', v_starts, 'ends_at', v_ends,
                       'caregiver_record_id', v_rec.id, 'reserved_minutes', v_minutes, 'authorization_lineage_id', v_auth.lineage_id), null);
  perform ogevia.idempotency_finish('create_shift', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('shift_id', v_id, 'starts_at', v_starts, 'ends_at', v_ends, 'reserved_minutes', v_minutes,
                       'remaining_minutes', v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes));
  return query select v_id, v_starts, v_ends, v_minutes, (v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes)::bigint;
end;
$$;

-- Moved onto the gate (each call below is the only change from the previous definition):
create or replace function ogevia_api.reschedule_shift(
  p_organization_id uuid, p_shift_id uuid, p_local_date date, p_start time, p_end time, p_reason text, p_idempotency_key uuid default null
)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, reserved_minutes integer, remaining_minutes bigint)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_shift_id, p_local_date, p_start, p_end);
  v_prior jsonb;
  v_s ogevia.shifts%rowtype;
  v_tz text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_minutes integer;
  v_auth ogevia.client_authorizations%rowtype;
  v_res ogevia.authorization_reservations%rowtype;
  v_used bigint;
  v_reserved bigint;
begin
  v_prior := ogevia.idempotency_begin('reschedule_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'shift_id')::uuid, (v_prior ->> 'starts_at')::timestamptz, (v_prior ->> 'ends_at')::timestamptz,
      (v_prior ->> 'reserved_minutes')::integer, (v_prior ->> 'remaining_minutes')::bigint;
    return;
  end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for the change' using errcode = 'OGV22'; end if;
  if p_local_date is null or p_start is null or p_end is null then
    raise exception 'Enter the date, start time and end time' using errcode = 'OGV22';
  end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  if v_s.starts_at <= now() then raise exception 'This shift has started; record the visit instead' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit is linked to this shift; it cannot be moved' using errcode = 'OGC09';
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  perform ogevia.require_clear_local_times(v_tz, p_local_date, p_start, p_end);
  v_starts := (p_local_date + p_start) at time zone v_tz;
  v_ends := (case when p_end <= p_start then p_local_date + 1 else p_local_date end + p_end) at time zone v_tz;
  v_minutes := floor(extract(epoch from (v_ends - v_starts)) / 60)::integer;
  if v_minutes < 15 or v_minutes > 1440 then
    raise exception 'A shift must be between 15 minutes and 24 hours' using errcode = 'OGV22';
  end if;
  if v_starts <= now() then raise exception 'The new time is in the past' using errcode = 'OGV22'; end if;
  select * into v_auth from ogevia.client_authorizations a
  where a.organization_id = p_organization_id and a.client_id = v_s.client_id and a.service_id = v_s.service_id
    and a.is_current and a.deleted_at is null and p_local_date between a.period_start and a.period_end;
  if v_auth.id is null then
    raise exception 'No current authorization covers this client and service on that date' using errcode = 'OGV22';
  end if;
  select * into v_res from ogevia.authorization_reservations r where r.shift_id = v_s.id and r.released_at is null for update;
  -- Lock both lineages in a fixed order.
  perform ogevia.lock_authorization_lineage(l) from (
    select distinct x as l from unnest(array[v_auth.lineage_id, v_res.authorization_lineage_id]) x where x is not null order by 1) q;
  v_used := ogevia.authorization_month_usage(v_auth.lineage_id, p_local_date, null);
  v_reserved := ogevia.authorization_month_reserved(v_auth.lineage_id, p_local_date)
    - case when v_res.id is not null and v_res.authorization_lineage_id = v_auth.lineage_id
                and date_trunc('month', v_res.service_date) = date_trunc('month', p_local_date)
           then v_res.reserved_minutes else 0 end;
  if v_used + v_reserved + v_minutes > v_auth.monthly_authorized_minutes then
    raise exception 'Not enough authorized time remains this month for this shift: % available, this shift needs %',
      ogevia.format_duration(greatest(v_auth.monthly_authorized_minutes - v_used - v_reserved, 0)::integer),
      ogevia.format_duration(v_minutes) using errcode = 'OGC09';
  end if;
  if v_s.caregiver_record_id is not null then
    perform ogevia.check_shift_caregiver(p_organization_id, v_s.caregiver_record_id, v_starts, v_ends, v_s.id, v_s.service_id);
  end if;
  update ogevia.shifts set starts_at = v_starts, ends_at = v_ends, authorization_lineage_id = v_auth.lineage_id, updated_at = now()
   where id = v_s.id;
  if v_res.id is not null then
    update ogevia.authorization_reservations set authorization_lineage_id = v_auth.lineage_id, service_date = p_local_date,
           reserved_minutes = v_minutes where id = v_res.id;
  else
    insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
    values (p_organization_id, v_auth.lineage_id, null, v_s.id, p_local_date, v_minutes);
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift.rescheduled', 'shifts', v_s.id,
    jsonb_build_object('starts_at', v_s.starts_at, 'ends_at', v_s.ends_at, 'reserved_minutes', v_res.reserved_minutes,
      'service_date', v_res.service_date, 'series_id', v_s.series_id),
    jsonb_build_object('starts_at', v_starts, 'ends_at', v_ends, 'reserved_minutes', v_minutes, 'service_date', p_local_date), v_reason);
  perform ogevia.idempotency_finish('reschedule_shift', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('shift_id', v_s.id, 'starts_at', v_starts, 'ends_at', v_ends, 'reserved_minutes', v_minutes,
      'remaining_minutes', v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes));
  return query select v_s.id, v_starts, v_ends, v_minutes, (v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes)::bigint;
end;
$$;

-- Moved onto the gate (each call below is the only change from the previous definition):
create or replace function ogevia_api.assign_shift_caregiver(
  p_organization_id uuid, p_shift_id uuid, p_caregiver_record_id uuid, p_reason text default null, p_idempotency_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_shift_id, p_caregiver_record_id);
  v_prior jsonb;
  v_s ogevia.shifts%rowtype;
  v_rec ogevia.caregiver_records%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_prior := ogevia.idempotency_begin('assign_shift_caregiver', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  if v_s.caregiver_record_id = p_caregiver_record_id and not ogevia.shift_is_called_out(v_s.id) then
    raise exception 'This caregiver is already on this shift' using errcode = 'OGC09';
  end if;
  if v_s.caregiver_record_id is not null and not ogevia.shift_is_called_out(v_s.id) and v_reason is null then
    raise exception 'Give a reason for changing the caregiver' using errcode = 'OGV22';
  end if;
  if v_s.caregiver_record_id = p_caregiver_record_id then
    raise exception 'This caregiver called out of this shift; choose someone else' using errcode = 'OGC09';
  end if;
  v_rec := ogevia.check_shift_caregiver(p_organization_id, p_caregiver_record_id, v_s.starts_at, v_s.ends_at, v_s.id, v_s.service_id);
  insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type, actor_user_id, original_caregiver_record_id,
                                            replacement_caregiver_record_id, reason, before_snapshot, after_snapshot)
  values (p_organization_id, v_s.id, 'reassigned', v_actor, v_s.caregiver_record_id, v_rec.id,
          coalesce(v_reason, case when v_s.caregiver_record_id is null then 'Open shift filled' else 'Replacement after call-out' end),
          jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id), jsonb_build_object('caregiver_record_id', v_rec.id));
  update ogevia.shifts set caregiver_record_id = v_rec.id, caregiver_user_id = v_rec.linked_user_id, updated_at = now() where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift.caregiver_assigned', 'shifts', v_s.id,
    jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id), jsonb_build_object('caregiver_record_id', v_rec.id), v_reason);
  perform ogevia.idempotency_finish('assign_shift_caregiver', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'covered'));
  return 'covered';
end;
$$;

-- Moved onto the gate (each call below is the only change from the previous definition):
create or replace function ogevia_api.assign_care_request(p_organization_id uuid,p_request_id uuid,p_offer_id uuid)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare r ogevia.care_requests%rowtype; o ogevia.care_request_offers%rowtype; cr ogevia.caregiver_records%rowtype; a ogevia.client_authorizations%rowtype; v_shift uuid; v_pre uuid; v_used bigint; v_reserved bigint; v_date date;
begin
 if not ogevia.has_permission(p_organization_id,'care_requests.manage') then raise exception 'Forbidden' using errcode='OGA03'; end if;
 -- Take the caregiver lock BEFORE the request row so two requests for one caregiver serialise (the overlap race), in the same order as every other path.
 select o0.caregiver_record_id into v_pre from ogevia.care_request_offers o0 where o0.id=p_offer_id and o0.care_request_id=p_request_id and o0.organization_id=p_organization_id;
 if v_pre is not null then perform ogevia.lock_caregiver(v_pre); end if;
 select * into r from ogevia.care_requests where id=p_request_id and organization_id=p_organization_id for update;
 select * into o from ogevia.care_request_offers where id=p_offer_id and care_request_id=p_request_id and organization_id=p_organization_id and status='available' for update;
 if r.id is null or o.id is null then raise exception 'Request or accepted offer not found' using errcode='OGN04'; end if;
 select * into cr from ogevia.caregiver_records where id=o.caregiver_record_id and organization_id=p_organization_id and status in('ready','active') and deleted_at is null;
 if cr.id is null then raise exception 'Caregiver is no longer active' using errcode='OGV22'; end if;
 -- Recheck everything at commit time: status, documents, service approval and approved hours (an administrator override lifts only the hours).
 perform ogevia.assert_ready_for_work(p_organization_id,cr.id,r.service_id,r.starts_at,r.ends_at,'care_request',r.client_id);
 if exists(select 1 from ogevia.shifts sh where sh.organization_id=p_organization_id and sh.caregiver_record_id=cr.id and sh.id is distinct from r.assigned_shift_id and sh.status in('scheduled','completed') and sh.starts_at<r.ends_at and sh.ends_at>r.starts_at) then raise exception 'Caregiver is already scheduled at this time' using errcode='OGC09'; end if;
 v_date:=ogevia.organization_local_date(p_organization_id,r.starts_at);
 if r.assigned_shift_id is null then
   select * into a from ogevia.client_authorizations where lineage_id=r.authorization_lineage_id and is_current and deleted_at is null and v_date between period_start and period_end;
   if a.id is null then raise exception 'Authorization is no longer active' using errcode='OGV22'; end if;
   perform ogevia.lock_authorization_lineage(r.authorization_lineage_id);
   v_used:=ogevia.authorization_month_usage(r.authorization_lineage_id,v_date,null);
   v_reserved:=ogevia.care_request_reserved_usage(r.authorization_lineage_id,v_date,r.id);
   if v_used+v_reserved+r.requested_minutes>a.monthly_authorized_minutes then raise exception 'Not enough authorized time remains for this assignment' using errcode='OGC09'; end if;
   insert into ogevia.shifts(organization_id,client_id,service_id,caregiver_user_id,caregiver_record_id,starts_at,ends_at,status)
   values(p_organization_id,r.client_id,r.service_id,cr.linked_user_id,cr.id,r.starts_at,r.ends_at,'scheduled') returning id into v_shift;
   insert into ogevia.authorization_reservations(organization_id,authorization_lineage_id,care_request_id,shift_id,service_date,reserved_minutes)
   values(p_organization_id,r.authorization_lineage_id,r.id,v_shift,v_date,r.requested_minutes);
 else
   v_shift:=r.assigned_shift_id;
   insert into ogevia.shift_coverage_events(organization_id,shift_id,event_type,actor_user_id,original_caregiver_record_id,replacement_caregiver_record_id,reason,before_snapshot,after_snapshot)
   values(p_organization_id,v_shift,'reassigned',ogevia.require_actor(),r.assigned_caregiver_record_id,cr.id,'Coverage reassigned',jsonb_build_object('caregiver_record_id',r.assigned_caregiver_record_id),jsonb_build_object('caregiver_record_id',cr.id));
   insert into ogevia.care_request_events(organization_id,care_request_id,shift_id,event_key,actor_user_id,before_snapshot,after_snapshot)
   values(p_organization_id,r.id,v_shift,'reassigned',ogevia.require_actor(),jsonb_build_object('caregiver_record_id',r.assigned_caregiver_record_id),jsonb_build_object('caregiver_record_id',cr.id));
   update ogevia.shifts set caregiver_record_id=cr.id,caregiver_user_id=cr.linked_user_id,status='scheduled',updated_at=now() where id=v_shift;
 end if;
 update ogevia.care_requests set status='assigned',assigned_shift_id=v_shift,assigned_caregiver_record_id=cr.id,assigned_at=now(),updated_at=now() where id=r.id;
 update ogevia.care_request_offers set status=case when id=o.id then 'assigned'::ogevia.care_offer_status when status in('sent','available') then 'filled'::ogevia.care_offer_status else status end,updated_at=now() where care_request_id=r.id;
 insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,caregiver_record_id,event_key) values(p_organization_id,r.id,'caregiver',cr.id,'assignment_confirmed');
 insert into ogevia.care_notifications(organization_id,care_request_id,recipient_type,event_key) values(p_organization_id,r.id,'client_portal','assignment_confirmed');
 return v_shift;
end;$$;

-- Moved onto the gate (each call below is the only change from the previous definition):
create or replace function ogevia_api.create_assignment(
  p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid,
  p_effective_start date, p_effective_end date default null, p_idempotency_key uuid default null
)
returns table (assignment_id uuid, has_authorization boolean, grants_access boolean)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.assignment_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_client_id, p_service_id, p_effective_start, p_effective_end);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_user uuid;
  v_id uuid := gen_random_uuid();
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_covered boolean;
begin
  v_prior := ogevia.idempotency_begin('create_assignment', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'assignment_id')::uuid, (v_prior ->> 'has_authorization')::boolean,
                        coalesce((v_prior ->> 'grants_access')::boolean, true);
    return;
  end if;
  if p_effective_start is null then raise exception 'Enter the start date' using errcode = 'OGV22'; end if;
  if p_effective_end is not null and p_effective_end < p_effective_start then
    raise exception 'The end date cannot be before the start date' using errcode = 'OGV22';
  end if;
  if p_effective_end is not null and p_effective_end < v_today then
    raise exception 'An assignment that has already ended cannot be added' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = 'inactive' then
    raise exception 'This caregiver is inactive; reactivate them before assigning' using errcode = 'OGV22';
  end if;
  v_user := case when v_rec.status in ('active', 'ready') then v_rec.linked_user_id end;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;

  -- Only an assignment that takes effect now (the caregiver is Ready or Active) is a commitment; a planned one
  -- grants nothing yet. Each dated visit and shift is checked again when it is started or scheduled.
  if v_user is not null then
    perform ogevia.lock_caregiver(v_rec.id);
    perform ogevia.assert_ready_for_assignment(p_organization_id, v_rec.id, p_service_id, greatest(p_effective_start, v_today));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'assignment-record', p_organization_id, v_rec.id, p_client_id, p_service_id), 0));
  if exists (
    select 1 from ogevia.caregiver_assignments a
    where a.organization_id = p_organization_id
      and (a.caregiver_record_id = v_rec.id or (a.caregiver_record_id is null and v_rec.linked_user_id is not null and a.caregiver_user_id = v_rec.linked_user_id))
      and a.client_id = p_client_id and a.service_id = p_service_id and a.is_active
      and daterange(a.effective_start, a.effective_end, '[]') && daterange(p_effective_start, p_effective_end, '[]')) then
    raise exception 'This caregiver is already assigned to this client and service for these dates' using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_assignments (id, organization_id, caregiver_user_id, caregiver_record_id, client_id, service_id, effective_start, effective_end)
  values (v_id, p_organization_id, v_user, v_rec.id, p_client_id, p_service_id, p_effective_start, p_effective_end);
  v_covered := ogevia.authorization_covers(p_organization_id, p_client_id, p_service_id, greatest(p_effective_start, v_today), p_effective_end);
  perform ogevia.write_audit(p_organization_id, 'assignment.created', 'caregiver_assignments', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'client_id', p_client_id, 'service_id', p_service_id,
                       'effective_start', p_effective_start, 'effective_end', p_effective_end, 'has_authorization', v_covered,
                       'grants_access', v_user is not null), null);
  perform ogevia.idempotency_finish('create_assignment', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('assignment_id', v_id, 'has_authorization', v_covered, 'grants_access', v_user is not null));
  return query select v_id, v_covered, v_user is not null;
end;
$$;

-- Moved onto the gate (each call below is the only change from the previous definition):
create or replace function ogevia_api.start_ad_hoc_service_visit(
  p_organization_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_task_categories text[] default '{}',
  p_service_notes text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_started_at timestamptz := now();
  v_fingerprint text := concat_ws('|', p_organization_id, p_client_id, p_service_id);
  v_prior jsonb;
  v_client ogevia.clients%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_record ogevia.caregiver_records%rowtype;
  v_org ogevia.organizations%rowtype;
  v_is_caregiver boolean;
  v_can_manage boolean;
  v_service_date date;
  v_name text;
  v_visit_id uuid;
  v_shift_id uuid;
begin
  select * into v_org from ogevia.organizations o where o.id = p_organization_id and o.status = 'active';
  if v_org.id is null then
    raise exception 'Organization is not active' using errcode = 'OGA03';
  end if;
  v_is_caregiver := ogevia.is_active_caregiver(p_organization_id);
  v_can_manage := ogevia.has_permission(p_organization_id, 'visits.manage');
  if not v_is_caregiver and not v_can_manage then
    raise exception 'Only an active caregiver or visit manager can start a visit' using errcode = 'OGA03';
  end if;

  -- Serialize starts per caller; with the partial unique indexes this makes
  -- double taps and concurrent starts safe.
  perform pg_advisory_xact_lock(hashtextextended('ogevia.start:' || v_actor::text, 0));

  v_prior := ogevia.idempotency_begin('start_visit', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'visit_id')::uuid;
  end if;

  if exists (
    select 1 from ogevia.service_visits v
    where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature')
  ) then
    raise exception 'Finish your current visit before starting another client' using errcode = 'OGC09';
  end if;

  if not v_can_manage
     and not ogevia.caregiver_has_active_assignment(p_organization_id, p_client_id, p_service_id)
     and not ogevia.caregiver_has_current_shift(p_organization_id, p_client_id, p_service_id) then
    raise exception 'This client and service are not assigned to you' using errcode = 'OGA03';
  end if;

  select * into v_client from ogevia.clients c
  where c.id = p_client_id and c.organization_id = p_organization_id
    and c.deleted_at is null and c.status = 'active';
  if v_client.id is null then
    raise exception 'Client not found or inactive' using errcode = 'OGN04';
  end if;
  if not exists (
    select 1 from ogevia.services sv
    where sv.id = p_service_id and sv.organization_id = p_organization_id
      and sv.deleted_at is null and sv.is_active
  ) then
    raise exception 'Service not found or inactive' using errcode = 'OGN04';
  end if;

  v_service_date := ogevia.organization_local_date(p_organization_id, v_started_at);
  -- M-1 fix: CURRENT version only.
  select * into v_auth
  from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_service_date);
  if v_auth.id is null then
    raise exception 'No active authorization covers this client and service' using errcode = 'OGC09';
  end if;

  select cr.* into v_record
  from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.linked_user_id = v_actor and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;
  if v_is_caregiver and (v_record.id is null or v_record.status not in ('active', 'ready')) then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before starting a visit.'
      using errcode = 'OGA03';
  end if;

  select coalesce(
    nullif(btrim(concat_ws(' ', coalesce(v_record.preferred_name, v_record.first_name), v_record.last_name)), ''),
    nullif(btrim(u.display_name), ''),
    'Caregiver'
  ) into v_name
  from ogevia.app_users u where u.id = v_actor;

  -- Link the visit to the caregiver's own scheduled shift for this client and
  -- service when one is in progress or about to start (server-side only).
  v_shift_id := ogevia.match_scheduled_shift_for_visit(
    p_organization_id, v_record.id, v_actor, p_client_id, p_service_id, v_started_at);

  -- A new visit by a caregiver needs verified, current CPR/TB (and service approval when Service checks are On), also when it starts
  -- through a standing assignment. Visits already in progress and manager-started visits are not touched.
  if v_is_caregiver and v_record.id is not null then
    perform ogevia.lock_caregiver(v_record.id);
    perform ogevia.assert_ready_for_work(p_organization_id, v_record.id, p_service_id, v_started_at,
      greatest(coalesce((select sh.ends_at from ogevia.shifts sh where sh.id = v_shift_id), v_started_at), v_started_at) + interval '1 minute',
      'visit_start', p_client_id);
  end if;

  insert into ogevia.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id, service_id,
    service_date, time_in, task_categories, service_notes, status, created_by, visit_number_snapshot
  ) values (
    p_organization_id, v_client.id,
    coalesce(nullif(btrim(v_client.caregiver_display_code), ''), v_client.client_code),
    v_actor, v_record.id, coalesce(v_name, 'Caregiver'), v_shift_id, v_auth.id, p_service_id,
    v_service_date, v_started_at, coalesce(p_task_categories, '{}'),
    nullif(btrim(p_service_notes), ''), 'draft', v_actor,
    coalesce(nullif(upper(left(regexp_replace(v_org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''), 'OGEV')
      || '-V-' || to_char(v_service_date, 'YYYYMMDD')
      || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
  ) returning id into v_visit_id;

  perform ogevia.write_audit(p_organization_id, 'service_visit.started', 'service_visits', v_visit_id,
    null, jsonb_build_object('status', 'draft', 'time_in', v_started_at,
                             'authorization_id', v_auth.id, 'service_id', p_service_id,
                             'scheduled_shift_id', v_shift_id));
  perform ogevia.idempotency_finish('start_visit', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit_id));
  return v_visit_id;
end;
$$;

-- Moved onto the gate (each call below is the only change from the previous definition):
create or replace function ogevia.series_evaluate(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid,
  p_weekdays smallint[], p_start time, p_end time, p_from date, p_through date,
  p_exclude_series uuid default null, p_exclude_from date default null
)
returns table (
  local_date date, starts_at timestamptz, ends_at timestamptz, minutes integer,
  month_start date, authorization_lineage_id uuid, authorized_minutes integer,
  used_minutes bigint, reserved_minutes bigint, series_minutes_before integer, outcome text
)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_tz text;
  v_today date;
  o record;
  v_auth ogevia.client_authorizations%rowtype;
  v_rec ogevia.caregiver_records%rowtype;
  v_key text;
  v_tally jsonb := '{}'::jsonb;
  v_used bigint;
  v_reserved bigint;
  v_series integer;
  v_outcome text;
  v_ready text;
begin
  select o2.timezone into v_tz from ogevia.organizations o2 where o2.id = p_organization_id;
  v_today := ogevia.organization_local_date(p_organization_id, now());
  if p_caregiver_record_id is not null then
    select * into v_rec from ogevia.caregiver_records r
    where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  end if;
  for o in select * from ogevia.series_occurrences(v_tz, p_weekdays, p_start, p_end, p_from, p_through) loop
    v_auth := null;
    select * into v_auth from ogevia.client_authorizations a
    where a.organization_id = p_organization_id and a.client_id = p_client_id and a.service_id = p_service_id
      and a.is_current and a.deleted_at is null and o.local_date between a.period_start and a.period_end;
    v_used := null; v_reserved := null; v_series := null;
    v_ready := case when v_rec.id is not null then ogevia.readiness_outcome(p_organization_id, v_rec.id, p_service_id, o.starts_at, o.ends_at) end;
    if o.starts_at <= now() then
      v_outcome := 'already_started';
    elsif ogevia.local_times_issue(v_tz, o.local_date, p_start, p_end) = 'nonexistent' then
      v_outcome := 'time_does_not_exist';
    elsif ogevia.local_times_issue(v_tz, o.local_date, p_start, p_end) = 'ambiguous' then
      v_outcome := 'time_occurs_twice';
    elsif v_auth.id is null then
      v_outcome := 'no_authorization';
    else
      v_key := v_auth.lineage_id::text || '|' || to_char(date_trunc('month', o.local_date), 'YYYY-MM');
      v_used := ogevia.authorization_month_usage(v_auth.lineage_id, o.local_date, null);
      v_reserved := ogevia.authorization_month_reserved(v_auth.lineage_id, o.local_date)
        - coalesce((select sum(r.reserved_minutes) from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
                    where p_exclude_series is not null and s.series_id = p_exclude_series and r.released_at is null
                      and s.status = 'scheduled' and (s.starts_at at time zone v_tz)::date >= p_exclude_from
                      and date_trunc('month', r.service_date) = date_trunc('month', o.local_date)
                      and r.authorization_lineage_id = v_auth.lineage_id
                      and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))), 0);
      v_series := coalesce((v_tally ->> v_key)::integer, 0);
      if v_rec.id is not null and exists (
        select 1 from ogevia.shifts s
        where s.organization_id = p_organization_id
          and (s.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
          and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
          and s.starts_at < o.ends_at and s.ends_at > o.starts_at
          and not (p_exclude_series is not null and s.series_id = p_exclude_series and s.status = 'scheduled'
                   and (s.starts_at at time zone v_tz)::date >= p_exclude_from)) then
        v_outcome := 'caregiver_conflict';
      elsif v_ready is not null then
        v_outcome := v_ready;
      elsif v_used + v_reserved + v_series + o.minutes > v_auth.monthly_authorized_minutes then
        v_outcome := 'exceeds_authorization';
      else
        v_outcome := 'ok';
        v_tally := jsonb_set(v_tally, array[v_key], to_jsonb(v_series + o.minutes));
      end if;
    end if;
    return query select o.local_date, o.starts_at, o.ends_at, o.minutes,
      date_trunc('month', o.local_date)::date, v_auth.lineage_id, v_auth.monthly_authorized_minutes,
      v_used, v_reserved, v_series, v_outcome;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

create function ogevia.readiness_read_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'readiness.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  return v_actor;
end;
$$;

-- All checks for one caregiver, client/service and interval, for the assignment screens. Nothing is changed.
create function ogevia_api.evaluate_assignment_readiness(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz,
  p_context text default 'shift', p_exclude_shift uuid default null, p_client_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_rows jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'readiness.read') or ogevia.has_permission(p_organization_id, 'shifts.manage')
          or ogevia.has_permission(p_organization_id, 'care_requests.manage') or ogevia.has_permission(p_organization_id, 'assignments.manage')) then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  if p_context not in ('shift', 'care_request', 'reschedule', 'series', 'assignment', 'visit_start') then
    raise exception 'Unknown context' using errcode = 'OGV22';
  end if;
  if p_starts is null or p_ends is null or p_ends <= p_starts then raise exception 'Enter a start and an end' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('check', c.check_name, 'status', c.status, 'code', c.code, 'message', c.message,
                                              'enforced', c.enforced, 'blocking', c.status = 'blocked' and c.enforced) order by c.check_name), '[]'::jsonb)
    into v_rows
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, p_context, p_exclude_shift, p_client_id,
                               p_context in ('shift', 'care_request', 'reschedule', 'series')) c;
  return jsonb_build_object(
    'checks', v_rows,
    'ready', not exists (select 1 from jsonb_array_elements(v_rows) e where (e ->> 'blocking')::boolean),
    'wouldBlockAfterActivation', exists (select 1 from jsonb_array_elements(v_rows) e where e ->> 'status' = 'blocked' and not (e ->> 'enforced')::boolean));
end;
$$;

-- The current state and the transition report: setup gaps and what activation would affect.
create function ogevia_api.get_readiness_status(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  s ogevia.organization_readiness_settings%rowtype;
  v_gaps jsonb;
  v_doc_blocked integer := 0;
  v_avail_missing integer := 0;
  v_svc_pairs integer := 0;
  v_care integer := 0;
  v_shift_docs integer := 0;
  v_shift_svc integer := 0;
  v_shift_avail integer := 0;
  v_shifts_total integer := 0;
  v_assign_docs integer := 0;
  v_assign_svc integer := 0;
  r record;
  sh record;
  ca record;
  c record;
  v_flag_docs boolean;
  v_flag_svc boolean;
  v_flag_av boolean;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_tz text;
begin
  perform ogevia.readiness_read_guard(p_organization_id);
  select * into s from ogevia.organization_readiness_settings x where x.organization_id = p_organization_id;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select coalesce(jsonb_agg(jsonb_build_object('code', g.req || '_' || coalesce(g.gap, ''), 'requirement', g.req, 'gap', g.gap) order by g.req), '[]'::jsonb)
    into v_gaps
  from (select r2.req,
               case when t.id is null then 'type_not_set' when p.requirement is null then 'policy_not_set' end as gap
        from unnest(array['cpr', 'tb']) as r2(req)
        left join ogevia.document_types t on t.organization_id = p_organization_id and t.work_requirement = r2.req and t.is_active
        left join ogevia.document_requirement_policies p on p.organization_id = p_organization_id and p.requirement = r2.req) g
  where g.gap is not null;

  for c in select cr.id from ogevia.caregiver_records cr
           where cr.organization_id = p_organization_id and cr.deleted_at is null and cr.status in ('ready', 'active') loop
    v_care := v_care + 1;
    if exists (select 1 from ogevia.document_readiness(p_organization_id, c.id) d where d.status <> 'ok') then v_doc_blocked := v_doc_blocked + 1; end if;
    if not exists (select 1 from ogevia.caregiver_availability_windows w where w.organization_id = p_organization_id and w.caregiver_record_id = c.id) then
      v_avail_missing := v_avail_missing + 1;
    end if;
  end loop;

  select count(*)::int into v_svc_pairs from ogevia_api.list_service_review_pairs(p_organization_id);

  for sh in select x.id, x.caregiver_record_id, x.service_id, x.starts_at, x.ends_at from ogevia.shifts x
            where x.organization_id = p_organization_id and x.status = 'scheduled' and x.starts_at > now()
              and x.caregiver_record_id is not null and not ogevia.shift_is_called_out(x.id) loop
    v_shifts_total := v_shifts_total + 1;
    select coalesce(bool_or(k.check_name in ('cpr', 'tb') and k.status = 'blocked'), false),
           coalesce(bool_or(k.check_name = 'service' and k.status = 'blocked'), false),
           coalesce(bool_or(k.check_name = 'availability' and k.status = 'blocked'), false)
      into v_flag_docs, v_flag_svc, v_flag_av
    from ogevia.readiness_checks(p_organization_id, sh.caregiver_record_id, sh.service_id, sh.starts_at, sh.ends_at, 'shift') k;
    if v_flag_docs then v_shift_docs := v_shift_docs + 1; end if;
    if v_flag_svc then v_shift_svc := v_shift_svc + 1; end if;
    if v_flag_av then v_shift_avail := v_shift_avail + 1; end if;
  end loop;

  for ca in select a.id, a.caregiver_record_id, a.service_id, a.effective_start, a.effective_end
            from ogevia.caregiver_assignments a
            where a.organization_id = p_organization_id and a.is_active and a.caregiver_record_id is not null
              and (a.effective_end is null or a.effective_end >= v_today) loop
    select coalesce(bool_or(k.check_name in ('cpr', 'tb') and k.status = 'blocked'), false),
           coalesce(bool_or(k.check_name = 'service' and k.status = 'blocked'), false)
      into v_flag_docs, v_flag_svc
    from ogevia.readiness_checks(p_organization_id, ca.caregiver_record_id, ca.service_id,
           greatest(ca.effective_start, v_today)::timestamp at time zone v_tz, (greatest(ca.effective_start, v_today) + 1)::timestamp at time zone v_tz, 'assignment') k;
    if v_flag_docs then v_assign_docs := v_assign_docs + 1; end if;
    if v_flag_svc then v_assign_svc := v_assign_svc + 1; end if;
  end loop;

  return jsonb_build_object(
    'enforcementActive', s.enforcement_active_from is not null and s.enforcement_active_from <= now(),
    'enforcementActiveFrom', s.enforcement_active_from,
    'serviceChecks', jsonb_build_object(
      'label', 'Service checks',
      'state', case when coalesce(s.service_checks, false) then 'On' else 'Off' end,
      'enabled', coalesce(s.service_checks, false),
      'offMessage', case when coalesce(s.service_checks, false) then null else 'Caregivers can be assigned without service approval.' end,
      'offHeadline', case when coalesce(s.service_checks, false) then null else 'Service checks: Off' end,
      'action', 'Review services'),
    'setupGaps', v_gaps,
    'setupComplete', jsonb_array_length(v_gaps) = 0,
    'caregivers', jsonb_build_object('readyOrActive', v_care, 'withDocumentGaps', v_doc_blocked, 'availabilityNotProvided', v_avail_missing,
                                     'servicePairsToReview', v_svc_pairs),
    'futureWork', jsonb_build_object('scheduledShifts', v_shifts_total, 'shiftsNeedingDocuments', v_shift_docs, 'shiftsNeedingServiceApproval', v_shift_svc,
                                     'shiftsOutsideApprovedHours', v_shift_avail,
                                     'standingAssignmentsNeedingDocuments', v_assign_docs, 'standingAssignmentsNeedingServiceApproval', v_assign_svc),
    'affectedShiftsCount', (select count(distinct sh2.id) from ogevia.shifts sh2
        where sh2.organization_id = p_organization_id and sh2.status = 'scheduled' and sh2.starts_at > now() and sh2.caregiver_record_id is not null
          and not ogevia.shift_is_called_out(sh2.id)
          and exists (select 1 from ogevia.readiness_checks(p_organization_id, sh2.caregiver_record_id, sh2.service_id, sh2.starts_at, sh2.ends_at, 'shift') k2
                      where k2.status = 'blocked' and k2.check_name <> 'service')));
end;
$$;

create function ogevia.readiness_manage_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'readiness.manage') then
    raise exception 'Only an administrator can change readiness settings' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

-- Turns enforcement on. The administrator must pass back the number of affected future shifts that the report
-- showed, so activation cannot happen without seeing it. Setup gaps block activation. Not reversible through the API.
create function ogevia_api.activate_readiness_enforcement(p_organization_id uuid, p_reason text, p_expected_affected_shifts integer)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.readiness_manage_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  s ogevia.organization_readiness_settings%rowtype;
  v_status jsonb;
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for activating readiness checks' using errcode = 'OGV22'; end if;
  insert into ogevia.organization_readiness_settings (organization_id) values (p_organization_id) on conflict do nothing;
  select * into s from ogevia.organization_readiness_settings x where x.organization_id = p_organization_id for update;
  if s.enforcement_active_from is not null then raise exception 'Readiness checks are already active.' using errcode = 'OGC09'; end if;
  v_status := ogevia_api.get_readiness_status(p_organization_id);
  if not (v_status ->> 'setupComplete')::boolean then
    raise exception 'Finish the CPR and TB setup first (document type and validity rule for each).' using errcode = 'OGC09';
  end if;
  if p_expected_affected_shifts is distinct from (v_status ->> 'affectedShiftsCount')::integer then
    raise exception 'The affected work changed since you reviewed it. Review the report again.' using errcode = 'OGC09';
  end if;
  update ogevia.organization_readiness_settings
     set enforcement_active_from = now(), enforcement_activated_by = v_actor, updated_at = now(), updated_by = v_actor
   where organization_id = p_organization_id;
  insert into ogevia.readiness_setting_events (organization_id, setting, old_value, new_value, reason, report, changed_by)
  values (p_organization_id, 'enforcement', 'report-only', 'active', v_reason, v_status, v_actor);
  perform ogevia.write_audit(p_organization_id, 'readiness.enforcement_activated', 'organization_readiness_settings', p_organization_id,
    jsonb_build_object('enforcement', 'report-only'), jsonb_build_object('enforcement', 'active', 'affected_shifts', p_expected_affected_shifts), v_reason);
  return ogevia_api.get_readiness_status(p_organization_id);
end;
$$;

-- "Service checks" On/Off. Only an administrator; always audited. Never touches CPR/TB or any other check.
create function ogevia_api.set_service_checks(p_organization_id uuid, p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.readiness_manage_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  s ogevia.organization_readiness_settings%rowtype;
begin
  if p_enabled is null then raise exception 'Choose On or Off' using errcode = 'OGV22'; end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the change' using errcode = 'OGV22'; end if;
  insert into ogevia.organization_readiness_settings (organization_id) values (p_organization_id) on conflict do nothing;
  select * into s from ogevia.organization_readiness_settings x where x.organization_id = p_organization_id for update;
  if p_enabled and s.enforcement_active_from is null then
    raise exception 'Activate readiness checks before turning Service checks On.' using errcode = 'OGC09';
  end if;
  if s.service_checks = p_enabled then raise exception 'Service checks are already %.', case when p_enabled then 'On' else 'Off' end using errcode = 'OGC09'; end if;
  update ogevia.organization_readiness_settings set service_checks = p_enabled, updated_at = now(), updated_by = v_actor where organization_id = p_organization_id;
  insert into ogevia.readiness_setting_events (organization_id, setting, old_value, new_value, reason, changed_by)
  values (p_organization_id, 'service_checks', case when s.service_checks then 'On' else 'Off' end, case when p_enabled then 'On' else 'Off' end, v_reason, v_actor);
  perform ogevia.write_audit(p_organization_id, 'readiness.service_checks_changed', 'organization_readiness_settings', p_organization_id,
    jsonb_build_object('service_checks', case when s.service_checks then 'On' else 'Off' end),
    jsonb_build_object('service_checks', case when p_enabled then 'On' else 'Off' end), v_reason);
  return ogevia_api.get_readiness_status(p_organization_id);
end;
$$;

-- One caregiver, one time range, one reason. Lifts only the availability check; expires in 30 minutes.
create function ogevia_api.authorize_availability_override(
  p_organization_id uuid, p_caregiver_record_id uuid, p_range_start timestamptz, p_range_end timestamptz, p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid := gen_random_uuid();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'availability.override') then
    raise exception 'Only an administrator can override availability' using errcode = 'OGA03';
  end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the override' using errcode = 'OGV22'; end if;
  if p_range_start is null or p_range_end is null or p_range_end <= p_range_start or p_range_end - p_range_start > interval '400 days' then
    raise exception 'Enter the dates the override covers' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id
                 and r.deleted_at is null and r.status in ('ready', 'active')) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.availability_overrides (id, organization_id, caregiver_record_id, range_start, range_end, reason, authorised_by, expires_at)
  values (v_id, p_organization_id, p_caregiver_record_id, p_range_start, p_range_end, v_reason, v_actor, now() + interval '30 minutes');
  perform ogevia.write_audit(p_organization_id, 'availability.override_authorized', 'availability_overrides', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'range_start', p_range_start, 'range_end', p_range_end), v_reason);
  return v_id;
end;
$$;

-- Open readiness flags (shifts and standing assignments, every cause) for the review screens.
create function ogevia_api.list_readiness_flags(p_organization_id uuid, p_kind text default null)
returns table (
  flag_id uuid, subject text, subject_id uuid, caregiver_record_id uuid, caregiver_code text, kind text, reason_code text,
  starts_at timestamp with time zone, ends_at timestamp with time zone, created_at timestamp with time zone
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.readiness_read_guard(p_organization_id);
  return query
  select f.id, 'shift'::text, f.shift_id, f.caregiver_record_id, c.caregiver_code, f.kind, f.reason_code, s.starts_at, s.ends_at, f.created_at
  from ogevia.shift_readiness_flags f
  join ogevia.shifts s on s.id = f.shift_id
  join ogevia.caregiver_records c on c.id = f.caregiver_record_id and c.organization_id = f.organization_id
  where f.organization_id = p_organization_id and f.resolved_at is null and (p_kind is null or f.kind = p_kind)
  union all
  select f.id, 'assignment'::text, f.assignment_id, f.caregiver_record_id, c.caregiver_code, f.kind, f.reason_code, null::timestamptz, null::timestamptz, f.created_at
  from ogevia.assignment_readiness_flags f
  join ogevia.caregiver_records c on c.id = f.caregiver_record_id and c.organization_id = f.organization_id
  where f.organization_id = p_organization_id and f.resolved_at is null and (p_kind is null or f.kind = p_kind)
  order by 10 desc;
end;
$$;

revoke all on function ogevia.readiness_message(text, text) from public;
revoke all on function ogevia.readiness_enforced(uuid, text, text) from public;
revoke all on function ogevia.client_requirement_issues(uuid, uuid, uuid) from public;
revoke all on function ogevia.readiness_checks(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, boolean) from public;
revoke all on function ogevia.assert_ready_for_work(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid) from public;
revoke all on function ogevia.assert_ready_for_assignment(uuid, uuid, uuid, date) from public;
revoke all on function ogevia.readiness_outcome(uuid, uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function ogevia.check_shift_caregiver(uuid, uuid, timestamptz, timestamptz, uuid, uuid) from public;
revoke all on function ogevia.readiness_read_guard(uuid) from public;
revoke all on function ogevia.readiness_manage_guard(uuid) from public;
revoke all on function ogevia_api.evaluate_assignment_readiness(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid) from public;
revoke all on function ogevia_api.get_readiness_status(uuid) from public;
revoke all on function ogevia_api.activate_readiness_enforcement(uuid, text, integer) from public;
revoke all on function ogevia_api.set_service_checks(uuid, boolean, text) from public;
revoke all on function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text) from public;
revoke all on function ogevia_api.list_readiness_flags(uuid, text) from public;
grant execute on function ogevia_api.evaluate_assignment_readiness(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_readiness_status(uuid) to ogevia_app;
grant execute on function ogevia_api.activate_readiness_enforcement(uuid, text, integer) to ogevia_app;
grant execute on function ogevia_api.set_service_checks(uuid, boolean, text) to ogevia_app;
grant execute on function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text) to ogevia_app;
grant execute on function ogevia_api.list_readiness_flags(uuid, text) to ogevia_app;
