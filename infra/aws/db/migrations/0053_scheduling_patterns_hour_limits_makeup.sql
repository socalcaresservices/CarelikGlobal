-- 0053 Scheduling: recurrence patterns, caregiver hour limits, make-up visits (owner request 2026-10-15,
-- "Consolidated Application Correction", section THIRD).
--
-- Reuses the 0034/0035 series engine. A series stays a set of ordinary shifts, each with its own reservation, created and
-- evaluated by the same functions; nothing is regenerated or rewritten. New:
--   * shift_series.pattern (jsonb, null = every selected weekday, as before). Keys (all optional):
--       every_weeks 1..4 + anchor date   alternating weeks (2 = every other week), counted from the anchor's Monday-week
--       nth 1..5 / except_nth 1..5       only / all but the Nth occurrence of that weekday in the month
--                                        ("every Saturday except the first Saturday" = weekdays {6}, except_nth {1})
--       exclude_dates [date]             named dates left out (holidays)
--     Different schedules for different weeks = several series for the same client (week A / week B); several caregivers
--     = several series (the engine only forbids one CAREGIVER from overlapping, never a client from having two).
--   * caregiver_hour_limits: agency default and per-caregiver daily/weekly limits, mode 'report' (default: shown, not
--     blocking) or 'block'. Evaluated as a readiness check 'hours' (so every assignment path sees it) and, for a series,
--     with the series' own earlier dates counted.
--   * shifts.makeup_for_shift_id and ogevia_api.schedule_makeup_shift: a make-up must replace time that was lost
--     (cancelled / called out / shorter than scheduled), in the same calendar month (the authorization month), and cannot
--     exceed the minutes still unmade. It is an ordinary shift: the same authorization, readiness and conflict rules apply,
--     so authorized/used/reserved/remaining are never counted twice.
-- No stored row is changed except the new columns' defaults (null). Completed services are never touched.

create function ogevia.valid_series_pattern(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ogevia, pg_temp
as $$
declare k text; v jsonb; e jsonb;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(p) loop
    if k not in ('every_weeks', 'anchor', 'nth', 'except_nth', 'exclude_dates') then return false; end if;
  end loop;
  if p ? 'every_weeks' then
    if jsonb_typeof(p -> 'every_weeks') <> 'number' or (p ->> 'every_weeks') !~ '^[1-4]$' then return false; end if;
    if (p ->> 'every_weeks') <> '1' and not (p ? 'anchor') then return false; end if;
  end if;
  if p ? 'anchor' then
    if jsonb_typeof(p -> 'anchor') <> 'string' or (p ->> 'anchor') !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
    begin perform (p ->> 'anchor')::date; exception when others then return false; end;
  end if;
  for k in select unnest(array['nth', 'except_nth']) loop
    if p ? k then
      if jsonb_typeof(p -> k) <> 'array' or jsonb_array_length(p -> k) not between 1 and 5 then return false; end if;
      for e in select * from jsonb_array_elements(p -> k) loop
        if jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[1-5]$' then return false; end if;
      end loop;
    end if;
  end loop;
  if p ? 'exclude_dates' then
    if jsonb_typeof(p -> 'exclude_dates') <> 'array' or jsonb_array_length(p -> 'exclude_dates') > 60 then return false; end if;
    for e in select * from jsonb_array_elements(p -> 'exclude_dates') loop
      if jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
      begin perform (e #>> '{}')::date; exception when others then return false; end;
    end loop;
  end if;
  return true;
end;
$$;

create function ogevia.pattern_matches(p_pattern jsonb, p_date date)
returns boolean
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select p_pattern is null
    or (
      (not (p_pattern ? 'every_weeks')
        or ((((date_trunc('week', p_date::timestamp)::date - date_trunc('week', (p_pattern ->> 'anchor')::timestamp)::date) / 7)
              % (p_pattern ->> 'every_weeks')::integer) + (p_pattern ->> 'every_weeks')::integer) % (p_pattern ->> 'every_weeks')::integer = 0)
      and (not (p_pattern ? 'nth')
        or ceil(extract(day from p_date) / 7.0)::integer in (select (x #>> '{}')::integer from jsonb_array_elements(p_pattern -> 'nth') x))
      and (not (p_pattern ? 'except_nth')
        or ceil(extract(day from p_date) / 7.0)::integer not in (select (x #>> '{}')::integer from jsonb_array_elements(p_pattern -> 'except_nth') x))
      and (not (p_pattern ? 'exclude_dates')
        or to_char(p_date, 'YYYY-MM-DD') not in (select x #>> '{}' from jsonb_array_elements(p_pattern -> 'exclude_dates') x))
    );
$$;

alter table ogevia.shift_series add column pattern jsonb;
alter table ogevia.shift_series add constraint shift_series_pattern check (ogevia.valid_series_pattern(pattern));
alter table ogevia.shifts add column makeup_for_shift_id uuid references ogevia.shifts(id);
create index shifts_makeup_idx on ogevia.shifts (makeup_for_shift_id) where makeup_for_shift_id is not null;

alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check check (reason = any (array[
  'exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started', 'time_does_not_exist', 'time_occurs_twice',
  'documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided', 'over_hour_limit']));

-- series_occurrences gains the pattern (new signature; the old one is dropped after its only callers are replaced below).

create function ogevia.series_occurrences(p_tz text, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_from date, p_through date, p_pattern jsonb default null)
 RETURNS TABLE(local_date date, starts_at timestamp with time zone, ends_at timestamp with time zone, minutes integer)
 LANGUAGE sql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
  select d::date,
         (d::date + p_start) at time zone p_tz,
         (case when p_end <= p_start then d::date + 1 else d::date end + p_end) at time zone p_tz,
         floor(extract(epoch from (
           ((case when p_end <= p_start then d::date + 1 else d::date end + p_end) at time zone p_tz)
           - ((d::date + p_start) at time zone p_tz))) / 60)::integer
  from generate_series(p_from::timestamp, p_through::timestamp, interval '1 day') d
  where extract(dow from d)::smallint = any (p_weekdays)
    and ogevia.pattern_matches(p_pattern, d::date)
  order by 1;
$$;


-- ---------------------------------------------------------------------------
-- Caregiver hour limits
-- ---------------------------------------------------------------------------
-- One row per agency default (caregiver_record_id null) and one per caregiver override. A caregiver override replaces the
-- default as a whole. Mode 'report' shows the warning but does not block; 'block' refuses the assignment. History is in the
-- audit log (every change is audited with the old and new values and a reason).
create table ogevia.caregiver_hour_limits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid,
  max_daily_minutes integer check (max_daily_minutes is null or max_daily_minutes between 60 and 1440),
  max_weekly_minutes integer check (max_weekly_minutes is null or max_weekly_minutes between 60 and 10080),
  mode text not null default 'report' check (mode in ('report', 'block')),
  updated_by uuid not null references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint caregiver_hour_limits_something check (max_daily_minutes is not null or max_weekly_minutes is not null)
);
create unique index caregiver_hour_limits_scope_idx on ogevia.caregiver_hour_limits
  (organization_id, coalesce(caregiver_record_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table ogevia.caregiver_hour_limits enable row level security;
create policy readonly_select on ogevia.caregiver_hour_limits for select to ogevia_readonly using (true);
grant select on ogevia.caregiver_hour_limits to ogevia_readonly;

create function ogevia.effective_hour_limit(p_organization_id uuid, p_caregiver_record_id uuid)
returns ogevia.caregiver_hour_limits
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select l.* from ogevia.caregiver_hour_limits l
  where l.organization_id = p_organization_id and (l.caregiver_record_id = p_caregiver_record_id or l.caregiver_record_id is null)
  order by (l.caregiver_record_id is null)
  limit 1;
$$;

-- Scheduled and completed minutes of one caregiver on an agency-local date and in that date's Monday-Sunday week, not counting
-- cancelled shifts, called-out shifts or p_exclude_shift. A shift belongs to the date it starts on.
create function ogevia.caregiver_hour_load(p_organization_id uuid, p_caregiver_record_id uuid, p_local_date date, p_exclude_shift uuid default null)
returns table (day_minutes bigint, week_minutes bigint)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with tz as (select o.timezone as z from ogevia.organizations o where o.id = p_organization_id),
  m as (
    select (s.starts_at at time zone tz.z)::date as d,
           floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::bigint as mins
    from ogevia.shifts s, tz
    where s.organization_id = p_organization_id and s.caregiver_record_id = p_caregiver_record_id
      and s.status in ('scheduled', 'completed') and s.id is distinct from p_exclude_shift
      and not ogevia.shift_is_called_out(s.id)
      and (s.starts_at at time zone tz.z)::date between date_trunc('week', p_local_date::timestamp)::date
                                                    and date_trunc('week', p_local_date::timestamp)::date + 6
  )
  select coalesce(sum(mins) filter (where d = p_local_date), 0), coalesce(sum(mins), 0) from m;
$$;

-- null when the interval fits; otherwise 'daily' or 'weekly'. p_extra_day/p_extra_week are minutes not yet stored (the
-- earlier dates of a series being evaluated).
create function ogevia.hour_limit_issue(
  p_organization_id uuid, p_caregiver_record_id uuid, p_local_date date, p_minutes integer, p_exclude_shift uuid,
  p_extra_day integer default 0, p_extra_week integer default 0
)
returns text
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare l ogevia.caregiver_hour_limits%rowtype; w record;
begin
  l := ogevia.effective_hour_limit(p_organization_id, p_caregiver_record_id);
  if l.id is null then return null; end if;
  select * into w from ogevia.caregiver_hour_load(p_organization_id, p_caregiver_record_id, p_local_date, p_exclude_shift);
  if l.max_daily_minutes is not null and w.day_minutes + p_extra_day + p_minutes > l.max_daily_minutes then return 'daily'; end if;
  if l.max_weekly_minutes is not null and w.week_minutes + p_extra_week + p_minutes > l.max_weekly_minutes then return 'weekly'; end if;
  return null;
end;
$$;


-- readiness_checks: adds the 'hours' check (its enforcement is the limit's own mode).
create or replace function ogevia.readiness_checks(p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone, p_context text DEFAULT 'shift'::text, p_exclude_shift uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid, p_with_conflict boolean DEFAULT false)
 RETURNS TABLE(check_name text, status text, code text, message text, enforced boolean)
 LANGUAGE plpgsql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
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

  if p_context in ('shift', 'care_request', 'reschedule', 'series', 'visit_start') then
    v_st := ogevia.availability_status(p_organization_id, p_caregiver_record_id, p_starts, p_ends);
    if v_st = 'covered' then
      return query select 'availability'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
    else
      v_ov := ogevia.availability_override_for(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_context, p_client_id) is not null;
      if v_ov then
        return query select 'availability'::text, 'overridden'::text, 'availability_override'::text,
                            ogevia.readiness_message('availability', 'availability_override'), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      else
        return query select 'availability'::text, 'blocked'::text, 'availability_' || v_st,
                            ogevia.readiness_message('availability', 'availability_' || v_st), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      end if;
    end if;
  end if;

  if p_context in ('shift', 'care_request', 'reschedule', 'series') and v_rec.id is not null then
    declare
      v_lim ogevia.caregiver_hour_limits%rowtype;
      v_issue text;
      v_tz text;
      v_date date;
      v_min integer;
    begin
      v_lim := ogevia.effective_hour_limit(p_organization_id, p_caregiver_record_id);
      if v_lim.id is not null then
        select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
        v_date := (p_starts at time zone v_tz)::date;
        v_min := floor(extract(epoch from (p_ends - p_starts)) / 60)::integer;
        v_issue := ogevia.hour_limit_issue(p_organization_id, p_caregiver_record_id, v_date, v_min, p_exclude_shift);
        if v_issue is null then
          return query select 'hours'::text, 'ok'::text, null::text, null::text, v_lim.mode = 'block';
        else
          return query select 'hours'::text, 'blocked'::text, v_issue || '_hour_limit', ogevia.readiness_message('hours', v_issue || '_hour_limit'), v_lim.mode = 'block';
        end if;
      end if;
    end;
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

create or replace function ogevia.readiness_message(p_check text, p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 set search_path = ogevia, pg_temp
AS $$
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
    when p_check = 'hours' then
      case p_code when 'daily_hour_limit' then 'Over the daily hour limit.' else 'Over the weekly hour limit.' end
    when p_check = 'conflict' then 'Already booked.'
    when p_check = 'caregiver' then 'Caregiver is not active.'
    when p_check = 'client' then 'A mandatory client requirement is not met.'
    else 'Not ready.' end;
$$;

create or replace function ogevia.readiness_outcome(p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
  select case
    when bool_or(c.check_name in ('cpr', 'tb')) then 'documents_not_current'
    when bool_or(c.check_name = 'service') then 'service_not_approved'
    when bool_or(c.check_name = 'availability' and c.code = 'availability_not_provided') then 'availability_not_provided'
    when bool_or(c.check_name = 'availability') then 'availability_outside'
    when bool_or(c.check_name = 'hours') then 'over_hour_limit'
  end
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, 'series') c
  where c.status = 'blocked' and c.enforced and c.check_name <> 'caregiver';
$$;


-- series_evaluate: the pattern, and the hour limit with the series' own earlier dates counted.
drop function ogevia.series_evaluate(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, uuid, date);
create function ogevia.series_evaluate(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_from date, p_through date, p_exclude_series uuid DEFAULT NULL::uuid, p_exclude_from date DEFAULT NULL::date, p_pattern jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(local_date date, starts_at timestamp with time zone, ends_at timestamp with time zone, minutes integer, month_start date, authorization_lineage_id uuid, authorized_minutes integer, used_minutes bigint, reserved_minutes bigint, series_minutes_before integer, outcome text)
 LANGUAGE plpgsql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
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
  v_lim ogevia.caregiver_hour_limits%rowtype;
  v_issue text;
  v_day_tally jsonb := '{}'::jsonb;
  v_week_tally jsonb := '{}'::jsonb;
  v_day_key text;
  v_week_key text;
begin
  select o2.timezone into v_tz from ogevia.organizations o2 where o2.id = p_organization_id;
  v_today := ogevia.organization_local_date(p_organization_id, now());
  if p_caregiver_record_id is not null then
    select * into v_rec from ogevia.caregiver_records r
    where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  end if;
  if v_rec.id is not null then v_lim := ogevia.effective_hour_limit(p_organization_id, v_rec.id); end if;
  for o in select * from ogevia.series_occurrences(v_tz, p_weekdays, p_start, p_end, p_from, p_through, p_pattern) loop
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
      v_issue := null;
      if v_lim.id is not null and v_lim.mode = 'block' then
        v_issue := ogevia.hour_limit_issue(p_organization_id, v_rec.id, o.local_date, o.minutes, null,
          coalesce((v_day_tally ->> o.local_date::text)::integer, 0),
          coalesce((v_week_tally ->> date_trunc('week', o.local_date::timestamp)::date::text)::integer, 0));
      end if;
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
      elsif v_issue is not null then
        v_outcome := 'over_hour_limit';
      elsif v_used + v_reserved + v_series + o.minutes > v_auth.monthly_authorized_minutes then
        v_outcome := 'exceeds_authorization';
      else
        v_outcome := 'ok';
        v_tally := jsonb_set(v_tally, array[v_key], to_jsonb(v_series + o.minutes));
        v_day_key := o.local_date::text;
        v_week_key := date_trunc('week', o.local_date::timestamp)::date::text;
        v_day_tally := jsonb_set(v_day_tally, array[v_day_key], to_jsonb(coalesce((v_day_tally ->> v_day_key)::integer, 0) + o.minutes));
        v_week_tally := jsonb_set(v_week_tally, array[v_week_key], to_jsonb(coalesce((v_week_tally ->> v_week_key)::integer, 0) + o.minutes));
      end if;
    end if;
    return query select o.local_date, o.starts_at, o.ends_at, o.minutes,
      date_trunc('month', o.local_date)::date, v_auth.lineage_id, v_auth.monthly_authorized_minutes,
      v_used, v_reserved, v_series, v_outcome;
  end loop;
end;
$$;

drop function ogevia.series_validate(uuid, uuid, uuid, uuid, smallint[], time, time, date, date);
create function ogevia.series_validate(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_from date, p_ends_on date, p_pattern jsonb DEFAULT NULL::jsonb)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
declare
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_minutes integer;
  v_status text;
begin
  if p_weekdays is null or cardinality(p_weekdays) = 0 or p_start is null or p_end is null or p_from is null then
    raise exception 'Choose the weekdays, start time, end time and first date' using errcode = 'OGV22';
  end if;
  if not coalesce(ogevia.valid_weekdays(p_weekdays), false) then
    raise exception 'Weekdays must be different days from Sunday (0) to Saturday (6)' using errcode = 'OGV22';
  end if;
  if not coalesce(ogevia.valid_series_pattern(p_pattern), false) then
    raise exception 'The repeat pattern is not valid' using errcode = 'OGV22';
  end if;
  v_minutes := (extract(epoch from (p_end - p_start)) / 60)::integer;
  if p_end <= p_start then v_minutes := v_minutes + 1440; end if;
  if v_minutes < 15 or v_minutes > 1440 then
    raise exception 'A shift must be between 15 minutes and 24 hours' using errcode = 'OGV22';
  end if;
  if p_from < v_today then
    raise exception 'The first date cannot be in the past' using errcode = 'OGV22';
  end if;
  if p_ends_on is not null and p_ends_on < p_from then
    raise exception 'The end date must be on or after the first date' using errcode = 'OGV22';
  end if;
  if p_ends_on is not null and p_ends_on > p_from + 366 then
    raise exception 'A series can be scheduled at most one year ahead' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id
                 and c.deleted_at is null and c.status = 'active') then
    raise exception 'The client must be active in this agency' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id
                 and s.deleted_at is null and s.is_active) then
    raise exception 'The service must be active in this agency' using errcode = 'OGV22';
  end if;
  if p_caregiver_record_id is not null then
    select r.status into v_status from ogevia.caregiver_records r
    where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
    if v_status is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
    if v_status not in ('ready', 'active') then
      raise exception 'Only caregivers who are Ready to work or Active can be scheduled' using errcode = 'OGV22';
    end if;
  end if;
  -- Generate now at most through the end of the second month after the first date.
  return least(coalesce(p_ends_on, 'infinity'::date),
               (date_trunc('month', p_from) + interval '3 months' - interval '1 day')::date);
end;
$$;

create or replace function ogevia.series_materialize(p_series ogevia.shift_series, p_from date, p_through date, p_on_conflict text, p_exclude_series uuid, p_exclude_from date, p_actor uuid)
 RETURNS TABLE(created integer, skipped integer, reserved_minutes integer)
 LANGUAGE plpgsql
 set search_path = ogevia, pg_temp
AS $$
declare
  e record;
  v_rec ogevia.caregiver_records%rowtype;
  v_created integer := 0;
  v_skipped integer := 0;
  v_minutes integer := 0;
  v_flagged text;
  v_id uuid;
begin
  if p_series.caregiver_record_id is not null then
    select * into v_rec from ogevia.caregiver_records r where r.id = p_series.caregiver_record_id;
  end if;
  select string_agg(to_char(x.local_date, 'MM/DD/YYYY') || ' (' || replace(x.outcome, '_', ' ') || ')', ', ' order by x.local_date)
    into v_flagged
  from (select * from ogevia.series_evaluate(p_series.organization_id, p_series.client_id, p_series.service_id,
          p_series.caregiver_record_id, p_series.weekdays, p_series.start_time, p_series.end_time, p_from, p_through,
          p_exclude_series, p_exclude_from, p_series.pattern) where outcome <> 'ok' limit 12) x;
  if v_flagged is not null and p_on_conflict <> 'skip_flagged' then
    raise exception 'Some dates cannot be scheduled: %. Nothing was saved. Change the series, or choose to skip these dates.', v_flagged
      using errcode = 'OGC09';
  end if;
  for e in select * from ogevia.series_evaluate(p_series.organization_id, p_series.client_id, p_series.service_id,
             p_series.caregiver_record_id, p_series.weekdays, p_series.start_time, p_series.end_time, p_from, p_through,
             p_exclude_series, p_exclude_from, p_series.pattern) loop
    if e.outcome = 'ok' then
      v_id := gen_random_uuid();
      insert into ogevia.shifts (id, organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id,
                                 starts_at, ends_at, status, authorization_lineage_id, created_by, series_id)
      values (v_id, p_series.organization_id, p_series.client_id, p_series.service_id, v_rec.linked_user_id, v_rec.id,
              e.starts_at, e.ends_at, 'scheduled', e.authorization_lineage_id, p_actor, p_series.id);
      insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
      values (p_series.organization_id, e.authorization_lineage_id, null, v_id, e.local_date, e.minutes);
      v_created := v_created + 1;
      v_minutes := v_minutes + e.minutes;
    else
      insert into ogevia.shift_series_skipped_dates (series_id, organization_id, local_date, reason, minutes, recorded_by)
      values (p_series.id, p_series.organization_id, e.local_date, e.outcome, e.minutes, p_actor);
      v_skipped := v_skipped + 1;
    end if;
  end loop;
  return query select v_created, v_skipped, v_minutes;
end;
$$;

drop function ogevia.series_occurrences(text, smallint[], time, time, date, date);


drop function ogevia_api.preview_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date);
create function ogevia_api.preview_shift_series(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_starts_on date, p_ends_on date DEFAULT NULL::date, p_pattern jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(local_date date, starts_at timestamp with time zone, ends_at timestamp with time zone, minutes integer, month_start date, authorization_lineage_id uuid, authorized_minutes integer, used_minutes bigint, reserved_minutes bigint, series_minutes_before integer, outcome text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
declare v_through date;
begin
  perform ogevia.shift_admin_guard(p_organization_id);
  v_through := ogevia.series_validate(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_starts_on, p_ends_on, p_pattern);
  return query select * from ogevia.series_evaluate(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_starts_on, v_through, null, null, p_pattern);
end;
$$;

drop function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid);
create function ogevia_api.create_shift_series(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_starts_on date, p_ends_on date, p_on_conflict text DEFAULT 'refuse'::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_pattern jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(series_id uuid, created integer, skipped integer, reserved_minutes integer, generated_through date)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_service_id, p_caregiver_record_id, array_to_string(p_weekdays, ','),
                         p_start, p_end, p_starts_on, p_ends_on, p_on_conflict, p_pattern::text);
  v_prior jsonb;
  v_through date;
  v_series ogevia.shift_series%rowtype;
  v_r record;
begin
  v_prior := ogevia.idempotency_begin('create_shift_series', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'series_id')::uuid, (v_prior ->> 'created')::integer, (v_prior ->> 'skipped')::integer,
      (v_prior ->> 'reserved_minutes')::integer, (v_prior ->> 'generated_through')::date;
    return;
  end if;
  if p_on_conflict is null or p_on_conflict not in ('refuse', 'skip_flagged') then
    raise exception 'Choose what happens to dates that do not fit: refuse, or skip them' using errcode = 'OGV22';
  end if;
  v_through := ogevia.series_validate(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_starts_on, p_ends_on, p_pattern);
  perform ogevia.series_lock(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id, p_starts_on, v_through);
  insert into ogevia.shift_series (organization_id, client_id, service_id, caregiver_record_id, weekdays, start_time, end_time,
                                   starts_on, ends_on, generated_through, created_by, pattern)
  values (p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
          array(select d from unnest(p_weekdays) d order by d), p_start, p_end, p_starts_on, p_ends_on, v_through, v_actor, p_pattern)
  returning * into v_series;
  select * into v_r from ogevia.series_materialize(v_series, p_starts_on, v_through, p_on_conflict, null, null, v_actor);
  if v_r.created = 0 then
    raise exception 'No date of this series can be scheduled; nothing was saved' using errcode = 'OGC09';
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift_series.created', 'shift_series', v_series.id, null,
    jsonb_build_object('client_id', p_client_id, 'service_id', p_service_id, 'caregiver_record_id', p_caregiver_record_id,
      'weekdays', v_series.weekdays, 'start_time', p_start, 'end_time', p_end, 'starts_on', p_starts_on, 'ends_on', p_ends_on,
      'generated_through', v_through, 'pattern', p_pattern, 'created', v_r.created, 'skipped', v_r.skipped, 'reserved_minutes', v_r.reserved_minutes,
      'on_conflict', p_on_conflict), null);
  perform ogevia.idempotency_finish('create_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('series_id', v_series.id, 'created', v_r.created, 'skipped', v_r.skipped,
      'reserved_minutes', v_r.reserved_minutes, 'generated_through', v_through));
  return query select v_series.id, v_r.created, v_r.skipped, v_r.reserved_minutes, v_through;
end;
$$;

drop function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid);
create function ogevia_api.change_shift_series_from(p_organization_id uuid, p_series_id uuid, p_from date, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_ends_on date, p_on_conflict text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid, p_pattern jsonb DEFAULT NULL::jsonb, p_clear_pattern boolean DEFAULT false)
 RETURNS TABLE(series_id uuid, cancelled integer, created integer, skipped integer, kept integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_series_id, p_from, p_caregiver_record_id, array_to_string(p_weekdays, ','),
                         p_start, p_end, p_ends_on, p_on_conflict, p_pattern::text, p_clear_pattern);
  v_prior jsonb;
  v_old ogevia.shift_series%rowtype;
  v_new ogevia.shift_series%rowtype;
  v_through date;
  v_pattern jsonb;
  v_c record;
  v_m record;
begin
  v_prior := ogevia.idempotency_begin('change_shift_series', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'series_id')::uuid, (v_prior ->> 'cancelled')::integer, (v_prior ->> 'created')::integer,
      (v_prior ->> 'skipped')::integer, (v_prior ->> 'kept')::integer;
    return;
  end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for the change' using errcode = 'OGV22'; end if;
  if p_on_conflict is null or p_on_conflict not in ('refuse', 'skip_flagged') then
    raise exception 'Choose what happens to dates that do not fit: refuse, or skip them' using errcode = 'OGV22';
  end if;
  v_old := ogevia.lock_series(p_organization_id, p_series_id);
  if p_from is null or p_from < v_old.starts_on then
    raise exception 'The change must start on or after the series start date' using errcode = 'OGV22';
  end if;
  -- Omitted pattern keeps the series' own; p_clear_pattern removes it (back to every selected weekday).
  v_pattern := case when p_clear_pattern then null else coalesce(p_pattern, v_old.pattern) end;
  v_through := ogevia.series_validate(p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_from, p_ends_on, v_pattern);
  perform ogevia.series_lock(p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id, p_from,
    greatest(v_through, v_old.generated_through));
  if v_old.caregiver_record_id is not null and v_old.caregiver_record_id is distinct from p_caregiver_record_id then
    perform pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || v_old.caregiver_record_id::text, 0));
  end if;
  insert into ogevia.shift_series (organization_id, client_id, service_id, caregiver_record_id, weekdays, start_time, end_time,
                                   starts_on, ends_on, generated_through, replaces_series_id, created_by, pattern)
  values (p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id,
          array(select d from unnest(p_weekdays) d order by d), p_start, p_end, p_from, p_ends_on, v_through, v_old.id, v_actor, v_pattern)
  returning * into v_new;
  -- Evaluate and create the replacement first (it ignores the old future occurrences), then cancel them.
  select * into v_m from ogevia.series_materialize(v_new, p_from, v_through, p_on_conflict, v_old.id, p_from, v_actor);
  select * into v_c from ogevia.series_cancel_from(v_old, p_from, v_reason);
  if p_from <= v_old.starts_on then
    update ogevia.shift_series set status = 'ended', ended_at = now(), ended_by = v_actor, end_reason = v_reason where id = v_old.id;
  else
    update ogevia.shift_series set ends_on = p_from - 1, generated_through = least(generated_through, p_from - 1) where id = v_old.id;
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift_series.changed_from', 'shift_series', v_old.id,
    jsonb_build_object('caregiver_record_id', v_old.caregiver_record_id, 'weekdays', v_old.weekdays,
      'start_time', v_old.start_time, 'end_time', v_old.end_time, 'ends_on', v_old.ends_on),
    jsonb_build_object('replacement_series_id', v_new.id, 'from', p_from, 'caregiver_record_id', p_caregiver_record_id,
      'weekdays', v_new.weekdays, 'pattern', v_pattern, 'start_time', p_start, 'end_time', p_end, 'ends_on', p_ends_on,
      'cancelled', v_c.cancelled, 'kept', v_c.kept, 'created', v_m.created, 'skipped', v_m.skipped), v_reason);
  perform ogevia.idempotency_finish('change_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('series_id', v_new.id, 'cancelled', v_c.cancelled, 'created', v_m.created, 'skipped', v_m.skipped, 'kept', v_c.kept));
  return query select v_new.id, v_c.cancelled, v_m.created, v_m.skipped, v_c.kept;
end;
$$;

drop function ogevia_api.list_shift_series(uuid);
create function ogevia_api.list_shift_series(p_organization_id uuid)
 RETURNS TABLE(series_id uuid, status text, client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text, caregiver_record_id uuid, caregiver_name text, weekdays smallint[], start_time time without time zone, end_time time without time zone, starts_on date, ends_on date, generated_through date, replaces_series_id uuid, upcoming_occurrences integer, skipped_dates jsonb, pattern jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
  select ss.id, ss.status, c.id, c.client_code,
         case when ogevia.has_permission(p_organization_id, 'clients.names.read')
              then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
         sv.id, sv.code, sv.name,
         cr.id, case when cr.id is not null then coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name end,
         ss.weekdays, ss.start_time, ss.end_time, ss.starts_on, ss.ends_on, ss.generated_through, ss.replaces_series_id,
         (select count(*)::integer from ogevia.shifts s where s.series_id = ss.id and s.status = 'scheduled' and s.starts_at > now()),
         coalesce((select jsonb_agg(jsonb_build_object('date', k.local_date, 'reason', k.reason, 'minutes', k.minutes) order by k.local_date)
                   from ogevia.shift_series_skipped_dates k where k.series_id = ss.id), '[]'::jsonb),
         ss.pattern
  from ogevia.shift_series ss
  join ogevia.clients c on c.id = ss.client_id
  join ogevia.services sv on sv.id = ss.service_id
  left join ogevia.caregiver_records cr on cr.id = ss.caregiver_record_id
  left join ogevia.client_private_names n on n.client_id = c.id
  where ss.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage'))
  order by ss.status, ss.starts_on desc;
$$;

drop function ogevia_api.list_shifts(uuid, date, date, uuid);
create function ogevia_api.list_shifts(p_organization_id uuid, p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(shift_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, local_date date, coverage_state text, shift_status text, client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text, caregiver_record_id uuid, caregiver_code text, caregiver_name text, has_sign_in boolean, reserved_minutes integer, from_care_request boolean, has_visit boolean, last_callout_reason text, series_id uuid, availability_override boolean, availability_override_reason text, makeup_for_shift_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id)
             and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage')) as can_list,
           ogevia.has_permission(p_organization_id, 'clients.names.read') as can_names,
           o.timezone as tz
    from ogevia.organizations o where o.id = p_organization_id
  )
  select s.id, s.starts_at, s.ends_at, (s.starts_at at time zone ctx.tz)::date, ogevia.shift_coverage_state(s), s.status::text,
         c.id, c.client_code,
         case when ctx.can_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
         sv.id, sv.code, sv.name,
         cr.id, cr.caregiver_code, case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end,
         cr.linked_user_id is not null,
         r.reserved_minutes, ogevia.shift_is_care_request(s.id),
         exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')),
         (select e.reason from ogevia.shift_coverage_events e where e.shift_id = s.id and e.event_type = 'called_out' order by e.created_at desc limit 1),
         s.series_id, (ov.id is not null), ov.reason, s.makeup_for_shift_id
  from ctx
  join ogevia.shifts s on s.organization_id = p_organization_id
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = s.organization_id and cr.deleted_at is null
    and (cr.id = s.caregiver_record_id or (s.caregiver_record_id is null and cr.linked_user_id = s.caregiver_user_id))
  left join ogevia.client_private_names n on n.client_id = c.id
  -- 0047: the Admin availability override this shift was assigned under, if any (staff who can list shifts see that it happened and why).
  left join lateral (select o.id, o.reason from ogevia.availability_overrides o
                     where o.shift_id = s.id and o.consumed_at is not null order by o.consumed_at desc limit 1) ov on true
  -- 0032: only a reservation still held (a cancelled shift, or one whose visit was signed, holds nothing).
  left join ogevia.authorization_reservations r on r.shift_id = s.id and r.released_at is null
  where ctx.actor is not null and ctx.can_list
    and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62
    and (s.starts_at at time zone ctx.tz)::date between p_from and p_to
    and (p_client_id is null or s.client_id = p_client_id)
  order by s.starts_at, c.client_code;
$$;


-- ---------------------------------------------------------------------------
-- API: hour limits, caregiver load, make-up visits
-- ---------------------------------------------------------------------------
create function ogevia_api.list_hour_limits(p_organization_id uuid)
returns table (caregiver_record_id uuid, caregiver_name text, max_daily_minutes integer, max_weekly_minutes integer, mode text, updated_at timestamptz)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select l.caregiver_record_id,
         case when cr.id is not null then coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name end,
         l.max_daily_minutes, l.max_weekly_minutes, l.mode, l.updated_at
  from ogevia.caregiver_hour_limits l
  left join ogevia.caregiver_records cr on cr.id = l.caregiver_record_id
  where l.organization_id = p_organization_id and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'caregivers.manage'))
  order by (l.caregiver_record_id is not null), 2;
$$;

-- p_caregiver_record_id null = the agency default. Both limits null removes the row.
create function ogevia_api.set_hour_limit(
  p_organization_id uuid, p_caregiver_record_id uuid, p_max_daily_minutes integer, p_max_weekly_minutes integer, p_mode text, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old ogevia.caregiver_hour_limits%rowtype;
begin
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for the change' using errcode = 'OGV22'; end if;
  if p_mode is null or p_mode not in ('report', 'block') then raise exception 'Choose report or block' using errcode = 'OGV22'; end if;
  if p_caregiver_record_id is not null and not exists (
    select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  if p_max_daily_minutes is not null and p_max_weekly_minutes is not null and p_max_weekly_minutes < p_max_daily_minutes then
    raise exception 'The weekly limit cannot be below the daily limit' using errcode = 'OGV22';
  end if;
  select * into v_old from ogevia.caregiver_hour_limits l
  where l.organization_id = p_organization_id and l.caregiver_record_id is not distinct from p_caregiver_record_id for update;
  if p_max_daily_minutes is null and p_max_weekly_minutes is null then
    if v_old.id is not null then
      delete from ogevia.caregiver_hour_limits where id = v_old.id;
      perform ogevia.write_audit(p_organization_id, 'hour_limit.removed', 'caregiver_hour_limits', v_old.id,
        jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'max_daily_minutes', v_old.max_daily_minutes,
          'max_weekly_minutes', v_old.max_weekly_minutes, 'mode', v_old.mode), null, v_reason);
    end if;
    return;
  end if;
  if v_old.id is null then
    insert into ogevia.caregiver_hour_limits (organization_id, caregiver_record_id, max_daily_minutes, max_weekly_minutes, mode, updated_by)
    values (p_organization_id, p_caregiver_record_id, p_max_daily_minutes, p_max_weekly_minutes, p_mode, v_actor)
    returning * into v_old;
    perform ogevia.write_audit(p_organization_id, 'hour_limit.set', 'caregiver_hour_limits', v_old.id, null,
      jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'max_daily_minutes', p_max_daily_minutes,
        'max_weekly_minutes', p_max_weekly_minutes, 'mode', p_mode), v_reason);
  else
    perform ogevia.write_audit(p_organization_id, 'hour_limit.changed', 'caregiver_hour_limits', v_old.id,
      jsonb_build_object('max_daily_minutes', v_old.max_daily_minutes, 'max_weekly_minutes', v_old.max_weekly_minutes, 'mode', v_old.mode),
      jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'max_daily_minutes', p_max_daily_minutes,
        'max_weekly_minutes', p_max_weekly_minutes, 'mode', p_mode), v_reason);
    update ogevia.caregiver_hour_limits set max_daily_minutes = p_max_daily_minutes, max_weekly_minutes = p_max_weekly_minutes,
      mode = p_mode, updated_by = v_actor, updated_at = now() where id = v_old.id;
  end if;
end;
$$;

-- Per caregiver and Monday-Sunday week in [p_from, p_to] (at most 62 days): scheduled minutes against the effective limits.
create function ogevia_api.list_caregiver_load(p_organization_id uuid, p_from date, p_to date)
returns table (caregiver_record_id uuid, caregiver_name text, week_start date, scheduled_minutes bigint, busiest_day date,
               busiest_day_minutes bigint, max_daily_minutes integer, max_weekly_minutes integer, mode text, over_daily boolean, over_weekly boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select o.timezone as tz,
           ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id)
             and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage'))
             and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62 as ok
    from ogevia.organizations o where o.id = p_organization_id
  ),
  m as (
    select s.caregiver_record_id as cid, (s.starts_at at time zone ctx.tz)::date as d,
           floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::bigint as mins
    from ctx, ogevia.shifts s
    where ctx.ok and s.organization_id = p_organization_id and s.caregiver_record_id is not null
      and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
      and (s.starts_at at time zone ctx.tz)::date between p_from and p_to
  ),
  daily as (select cid, d, date_trunc('week', d::timestamp)::date as wk, sum(mins) as mins from m group by cid, d),
  weekly as (
    select cid, wk, sum(mins) as total,
           (array_agg(d order by mins desc, d))[1] as top_day, max(mins) as top_mins
    from daily group by cid, wk
  )
  select w.cid, coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name, w.wk, w.total, w.top_day, w.top_mins,
         l.max_daily_minutes, l.max_weekly_minutes, l.mode,
         coalesce(l.max_daily_minutes is not null and w.top_mins > l.max_daily_minutes, false),
         coalesce(l.max_weekly_minutes is not null and w.total > l.max_weekly_minutes, false)
  from weekly w
  join ogevia.caregiver_records cr on cr.id = w.cid
  left join lateral (select (ogevia.effective_hour_limit(p_organization_id, w.cid)).*) l on true
  order by 2, w.wk;
$$;

-- A make-up for lost time: p_original_shift_id must be cancelled or called out, or completed shorter than scheduled; the
-- make-up is on a date in the SAME calendar month (the authorization month), for the same client and service, and cannot
-- exceed the minutes of the original not yet made up. Everything else is create_shift, unchanged (authorization,
-- readiness, conflicts, hour limits), so nothing is counted twice.
create function ogevia_api.schedule_makeup_shift(
  p_organization_id uuid, p_original_shift_id uuid, p_local_date date, p_start time, p_end time,
  p_caregiver_record_id uuid default null, p_idempotency_key uuid default null
)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, reserved_minutes integer, remaining_minutes bigint, unmade_minutes_after integer)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_tz text;
  v_orig ogevia.shifts%rowtype;
  v_orig_date date;
  v_scheduled integer;
  v_lost integer;
  v_made integer;
  v_new_minutes integer;
  v_r record;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select * into v_orig from ogevia.shifts s where s.id = p_original_shift_id and s.organization_id = p_organization_id for update;
  if v_orig.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  if v_orig.makeup_for_shift_id is not null then
    raise exception 'A make-up visit cannot itself be made up' using errcode = 'OGV22';
  end if;
  v_orig_date := (v_orig.starts_at at time zone v_tz)::date;
  v_scheduled := floor(extract(epoch from (v_orig.ends_at - v_orig.starts_at)) / 60)::integer;
  if v_orig.status = 'cancelled' or ogevia.shift_is_called_out(v_orig.id) then
    v_lost := v_scheduled;
  elsif v_orig.status = 'completed' then
    v_lost := v_scheduled - coalesce((select v.worked_minutes from ogevia.service_visits v
                where v.scheduled_shift_id = v_orig.id and v.status not in ('voided', 'corrected') limit 1), v_scheduled);
  else
    raise exception 'Only cancelled, called-out or short shifts can be made up' using errcode = 'OGV22';
  end if;
  if v_lost <= 0 then raise exception 'This shift was fully worked; there is nothing to make up' using errcode = 'OGV22'; end if;
  if p_local_date is null or date_trunc('month', p_local_date::timestamp) <> date_trunc('month', v_orig_date::timestamp) then
    raise exception 'A make-up must be in the same calendar month as the missed visit' using errcode = 'OGV22';
  end if;
  select coalesce(sum(floor(extract(epoch from (m.ends_at - m.starts_at)) / 60)), 0)::integer into v_made
  from ogevia.shifts m where m.makeup_for_shift_id = v_orig.id and m.status in ('scheduled', 'completed');
  v_new_minutes := floor(extract(epoch from (
    (case when p_end <= p_start then p_local_date + 1 else p_local_date end + p_end) at time zone v_tz
    - (p_local_date + p_start) at time zone v_tz)) / 60)::integer;
  if v_made + v_new_minutes > v_lost then
    raise exception 'This make-up is longer than the time still owed: % remaining', ogevia.format_duration(greatest(v_lost - v_made, 0)) using errcode = 'OGC09';
  end if;
  select * into v_r from ogevia_api.create_shift(p_organization_id, v_orig.client_id, v_orig.service_id, p_local_date, p_start, p_end,
                                                 coalesce(p_caregiver_record_id, v_orig.caregiver_record_id), p_idempotency_key);
  update ogevia.shifts set makeup_for_shift_id = v_orig.id where id = v_r.shift_id and makeup_for_shift_id is null;
  perform ogevia.write_audit(p_organization_id, 'shift.makeup_scheduled', 'shifts', v_r.shift_id, null,
    jsonb_build_object('original_shift_id', v_orig.id, 'minutes', v_new_minutes, 'owed_minutes_before', v_lost - v_made), null);
  return query select v_r.shift_id, v_r.starts_at, v_r.ends_at, v_r.reserved_minutes, v_r.remaining_minutes, v_lost - v_made - v_new_minutes;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (every function: no PUBLIC; ogevia_app only for the API surface)
-- ---------------------------------------------------------------------------
revoke all on function ogevia.valid_series_pattern(jsonb) from public;
revoke all on function ogevia.pattern_matches(jsonb, date) from public;
revoke all on function ogevia.series_occurrences(text, smallint[], time, time, date, date, jsonb) from public;
revoke all on function ogevia.effective_hour_limit(uuid, uuid) from public;
revoke all on function ogevia.caregiver_hour_load(uuid, uuid, date, uuid) from public;
revoke all on function ogevia.hour_limit_issue(uuid, uuid, date, integer, uuid, integer, integer) from public;
revoke all on function ogevia.series_evaluate(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, uuid, date, jsonb) from public;
revoke all on function ogevia.series_validate(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, jsonb) from public;
revoke all on function ogevia_api.preview_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, jsonb) from public;
revoke all on function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid, jsonb) from public;
revoke all on function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid, jsonb, boolean) from public;
revoke all on function ogevia_api.list_shift_series(uuid) from public;
revoke all on function ogevia_api.list_shifts(uuid, date, date, uuid) from public;
revoke all on function ogevia_api.list_hour_limits(uuid) from public;
revoke all on function ogevia_api.set_hour_limit(uuid, uuid, integer, integer, text, text) from public;
revoke all on function ogevia_api.list_caregiver_load(uuid, date, date) from public;
revoke all on function ogevia_api.schedule_makeup_shift(uuid, uuid, date, time, time, uuid, uuid) from public;
grant execute on function ogevia_api.preview_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, jsonb) to ogevia_app;
grant execute on function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid, jsonb) to ogevia_app;
grant execute on function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid, jsonb, boolean) to ogevia_app;
grant execute on function ogevia_api.list_shift_series(uuid) to ogevia_app;
grant execute on function ogevia_api.list_shifts(uuid, date, date, uuid) to ogevia_app;
grant execute on function ogevia_api.list_hour_limits(uuid) to ogevia_app;
grant execute on function ogevia_api.set_hour_limit(uuid, uuid, integer, integer, text, text) to ogevia_app;
grant execute on function ogevia_api.list_caregiver_load(uuid, date, date) to ogevia_app;
grant execute on function ogevia_api.schedule_makeup_shift(uuid, uuid, date, time, time, uuid, uuid) to ogevia_app;
