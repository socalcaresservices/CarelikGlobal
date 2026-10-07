-- 0034 Recurring shifts (weekly series), one-occurrence changes, and
-- "this and future" changes.
--
-- Before this migration (verified in the repository, 2026-10-05): AWS had only
-- single staff shifts (0026). No weekly series, no change of one occurrence's
-- time, no "this and future" change.
--
-- Model (extends 0026; no second scheduler):
--   * shift_series holds the pattern: client, service, optional caregiver,
--     weekdays (0 = Sunday ... 6 = Saturday), agency-local start/end time,
--     start date and optional end date.
--   * Every occurrence is an ordinary shifts row (series_id set) with its own
--     reservation, so call-outs, replacements, cancellation, visits and
--     reports work on one occurrence exactly as before.
--   * Occurrences are calculated from the real calendar in the agency's time
--     zone (a month with five Mondays has five Monday occurrences; minutes come
--     from the actual instants, so a daylight-saving day is counted as it is).
--   * Capacity uses the same rule and lock as create_shift (0026): per
--     authorization lineage and month, billable usage + unreleased reservations
--     + new occurrences <= monthly authorized minutes. Earlier occurrences in
--     the month are counted first; an occurrence that would go over is flagged
--     with its date. Nothing is ever shortened, moved or dropped silently:
--     creation is refused while anything is flagged, unless the caller
--     explicitly chooses to skip the flagged dates, which are then recorded in
--     shift_series_skipped_dates with the reason.
--   * Occurrences are created only inside a current authorization's period
--     (dates without one are flagged no_authorization) and at most through
--     the end of the second month after the start (extend_shift_series adds
--     later months, with the same checks).
--   * "This and future": end_shift_series cancels the series' scheduled
--     occurrences from a date (releasing their reservations); occurrences
--     with a linked visit are kept. change_shift_series_from does that and
--     creates the replacement series in one transaction, counting the
--     released time once (never twice).
--   * "This occurrence": reschedule_shift moves one shift's time or date;
--     its reservation moves with it (same row, re-checked). Call-out,
--     replacement and cancel of one occurrence use the 0026 functions.
-- All writes need shifts.manage, are audited and idempotent.

create function ogevia.valid_weekdays(p_days smallint[])
returns boolean
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select p_days is not null and cardinality(p_days) between 1 and 7
     and not exists (select 1 from unnest(p_days) d where d is null or d < 0 or d > 6)
     and (select count(distinct d) from unnest(p_days) d) = cardinality(p_days);
$$;

create table ogevia.shift_series (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  service_id uuid not null,
  caregiver_record_id uuid,
  weekdays smallint[] not null,
  start_time time not null,
  end_time time not null,
  starts_on date not null,
  ends_on date,
  generated_through date not null,
  status text not null default 'active' check (status in ('active', 'ended')),
  replaces_series_id uuid references ogevia.shift_series(id),
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references ogevia.app_users(id),
  end_reason text,
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint shift_series_weekdays check (coalesce(ogevia.valid_weekdays(weekdays), false)),
  constraint shift_series_dates check (ends_on is null or ends_on >= starts_on),
  constraint shift_series_generated check (generated_through >= starts_on - 1),
  constraint shift_series_end_shape check (
    (status = 'active' and ended_at is null and ended_by is null)
    or (status = 'ended' and ended_at is not null and ended_by is not null and length(btrim(coalesce(end_reason, ''))) > 0))
);
create index shift_series_org_idx on ogevia.shift_series (organization_id, status, starts_on);

create table ogevia.shift_series_skipped_dates (
  series_id uuid not null references ogevia.shift_series(id),
  organization_id uuid not null references ogevia.organizations(id),
  local_date date not null,
  reason text not null check (reason in ('exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started')),
  minutes integer not null,
  recorded_by uuid not null references ogevia.app_users(id),
  recorded_at timestamptz not null default now(),
  primary key (series_id, local_date)
);
create trigger shift_series_skipped_dates_no_update before update on ogevia.shift_series_skipped_dates
for each row execute function ogevia.forbid_update();
create trigger shift_series_skipped_dates_no_delete before delete on ogevia.shift_series_skipped_dates
for each row execute function ogevia.forbid_delete();

alter table ogevia.shifts add column series_id uuid references ogevia.shift_series(id);
create index shifts_series_idx on ogevia.shifts (series_id, starts_at) where series_id is not null;

alter table ogevia.shift_series enable row level security;
alter table ogevia.shift_series_skipped_dates enable row level security;
create policy readonly_select on ogevia.shift_series for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.shift_series_skipped_dates for select to ogevia_readonly using (true);
grant select on ogevia.shift_series, ogevia.shift_series_skipped_dates to ogevia_readonly;

-- Every occurrence of a weekly pattern between two agency-local dates, with
-- its real instants in the agency's time zone (an end at or before the start
-- means the next day).
create function ogevia.series_occurrences(
  p_tz text, p_weekdays smallint[], p_start time, p_end time, p_from date, p_through date
)
returns table (local_date date, starts_at timestamptz, ends_at timestamptz, minutes integer)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select d::date,
         (d::date + p_start) at time zone p_tz,
         (case when p_end <= p_start then d::date + 1 else d::date end + p_end) at time zone p_tz,
         floor(extract(epoch from (
           ((case when p_end <= p_start then d::date + 1 else d::date end + p_end) at time zone p_tz)
           - ((d::date + p_start) at time zone p_tz))) / 60)::integer
  from generate_series(p_from::timestamp, p_through::timestamp, interval '1 day') d
  where extract(dow from d)::smallint = any (p_weekdays)
  order by 1;
$$;

-- Evaluates every occurrence in date order against authorization coverage,
-- monthly capacity and caregiver overlap. Pure read: it never writes. The
-- shifts of p_exclude_series from p_exclude_from (being replaced in the same
-- transaction) are left out of the reserved time and the overlap check, so
-- their time is counted once.
create function ogevia.series_evaluate(
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
    if o.starts_at <= now() then
      v_outcome := 'already_started';
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

-- Shared validation of a pattern; returns the last date to generate now.
create function ogevia.series_validate(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid,
  p_weekdays smallint[], p_start time, p_end time, p_from date, p_ends_on date
)
returns date
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
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

-- Locks every authorization lineage the dates could touch (sorted, so two
-- schedulers never deadlock) and the caregiver's schedule.
create function ogevia.series_lock(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_from date, p_through date)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare l uuid;
begin
  for l in select distinct a.lineage_id from ogevia.client_authorizations a
           where a.organization_id = p_organization_id and a.client_id = p_client_id and a.service_id = p_service_id
             and a.deleted_at is null and a.period_start <= p_through and a.period_end >= p_from
           order by a.lineage_id loop
    perform ogevia.lock_authorization_lineage(l);
  end loop;
  if p_caregiver_record_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || p_caregiver_record_id::text, 0));
  end if;
end;
$$;

-- Creates the ok occurrences (and records skipped ones) for a series; returns created, skipped, minutes.
create function ogevia.series_materialize(p_series ogevia.shift_series, p_from date, p_through date, p_on_conflict text,
  p_exclude_series uuid, p_exclude_from date, p_actor uuid)
returns table (created integer, skipped integer, reserved_minutes integer)
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
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
          p_exclude_series, p_exclude_from) where outcome <> 'ok' limit 12) x;
  if v_flagged is not null and p_on_conflict <> 'skip_flagged' then
    raise exception 'Some dates cannot be scheduled: %. Nothing was saved. Change the series, or choose to skip these dates.', v_flagged
      using errcode = 'OGC09';
  end if;
  for e in select * from ogevia.series_evaluate(p_series.organization_id, p_series.client_id, p_series.service_id,
             p_series.caregiver_record_id, p_series.weekdays, p_series.start_time, p_series.end_time, p_from, p_through,
             p_exclude_series, p_exclude_from) loop
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

create function ogevia_api.preview_shift_series(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid,
  p_weekdays smallint[], p_start time, p_end time, p_starts_on date, p_ends_on date default null
)
returns table (
  local_date date, starts_at timestamptz, ends_at timestamptz, minutes integer,
  month_start date, authorization_lineage_id uuid, authorized_minutes integer,
  used_minutes bigint, reserved_minutes bigint, series_minutes_before integer, outcome text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_through date;
begin
  perform ogevia.shift_admin_guard(p_organization_id);
  v_through := ogevia.series_validate(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_starts_on, p_ends_on);
  return query select * from ogevia.series_evaluate(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_starts_on, v_through, null, null);
end;
$$;

create function ogevia_api.create_shift_series(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid,
  p_weekdays smallint[], p_start time, p_end time, p_starts_on date, p_ends_on date,
  p_on_conflict text default 'refuse', p_idempotency_key uuid default null
)
returns table (series_id uuid, created integer, skipped integer, reserved_minutes integer, generated_through date)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_service_id, p_caregiver_record_id, array_to_string(p_weekdays, ','),
                         p_start, p_end, p_starts_on, p_ends_on, p_on_conflict);
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
    p_weekdays, p_start, p_end, p_starts_on, p_ends_on);
  perform ogevia.series_lock(p_organization_id, p_client_id, p_service_id, p_caregiver_record_id, p_starts_on, v_through);
  insert into ogevia.shift_series (organization_id, client_id, service_id, caregiver_record_id, weekdays, start_time, end_time,
                                   starts_on, ends_on, generated_through, created_by)
  values (p_organization_id, p_client_id, p_service_id, p_caregiver_record_id,
          array(select d from unnest(p_weekdays) d order by d), p_start, p_end, p_starts_on, p_ends_on, v_through, v_actor)
  returning * into v_series;
  select * into v_r from ogevia.series_materialize(v_series, p_starts_on, v_through, p_on_conflict, null, null, v_actor);
  if v_r.created = 0 then
    raise exception 'No date of this series can be scheduled; nothing was saved' using errcode = 'OGC09';
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift_series.created', 'shift_series', v_series.id, null,
    jsonb_build_object('client_id', p_client_id, 'service_id', p_service_id, 'caregiver_record_id', p_caregiver_record_id,
      'weekdays', v_series.weekdays, 'start_time', p_start, 'end_time', p_end, 'starts_on', p_starts_on, 'ends_on', p_ends_on,
      'generated_through', v_through, 'created', v_r.created, 'skipped', v_r.skipped, 'reserved_minutes', v_r.reserved_minutes,
      'on_conflict', p_on_conflict), null);
  perform ogevia.idempotency_finish('create_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('series_id', v_series.id, 'created', v_r.created, 'skipped', v_r.skipped,
      'reserved_minutes', v_r.reserved_minutes, 'generated_through', v_through));
  return query select v_series.id, v_r.created, v_r.skipped, v_r.reserved_minutes, v_through;
end;
$$;

-- Cancels a series' scheduled occurrences from a date (no linked visit, not started);
-- returns cancelled count, released minutes, kept count (occurrences with a visit or already started).
create function ogevia.series_cancel_from(p_series ogevia.shift_series, p_from date, p_reason text)
returns table (cancelled integer, released_minutes integer, kept integer)
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_tz text;
  s record;
  v_cancelled integer := 0;
  v_released integer := 0;
  v_kept integer := 0;
  v_min integer;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_series.organization_id;
  for s in select sh.* from ogevia.shifts sh
           where sh.series_id = p_series.id and sh.status = 'scheduled' and (sh.starts_at at time zone v_tz)::date >= p_from
           order by sh.starts_at for update loop
    if s.starts_at <= now()
       or exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')) then
      v_kept := v_kept + 1;
      continue;
    end if;
    update ogevia.shifts set status = 'cancelled', cancel_reason = p_reason, updated_at = now() where id = s.id;
    update ogevia.authorization_reservations r set released_at = now(), release_reason = 'series_changed'
     where r.shift_id = s.id and r.released_at is null
    returning r.reserved_minutes into v_min;
    v_cancelled := v_cancelled + 1;
    v_released := v_released + coalesce(v_min, 0);
  end loop;
  return query select v_cancelled, v_released, v_kept;
end;
$$;

create function ogevia.lock_series(p_organization_id uuid, p_series_id uuid)
returns ogevia.shift_series
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare v ogevia.shift_series%rowtype;
begin
  select * into v from ogevia.shift_series s where s.id = p_series_id and s.organization_id = p_organization_id for update;
  if v.id is null then raise exception 'Series not found' using errcode = 'OGN04'; end if;
  if v.status <> 'active' then raise exception 'This series has ended' using errcode = 'OGC09'; end if;
  return v;
end;
$$;

create function ogevia_api.end_shift_series(
  p_organization_id uuid, p_series_id uuid, p_from date, p_reason text, p_idempotency_key uuid default null
)
returns table (cancelled integer, released_minutes integer, kept integer)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_series_id, p_from);
  v_prior jsonb;
  v_s ogevia.shift_series%rowtype;
  v_r record;
begin
  v_prior := ogevia.idempotency_begin('end_shift_series', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'cancelled')::integer, (v_prior ->> 'released_minutes')::integer, (v_prior ->> 'kept')::integer;
    return;
  end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for ending the series' using errcode = 'OGV22'; end if;
  if p_from is null then raise exception 'Choose the first date to stop' using errcode = 'OGV22'; end if;
  v_s := ogevia.lock_series(p_organization_id, p_series_id);
  perform ogevia.series_lock(p_organization_id, v_s.client_id, v_s.service_id, v_s.caregiver_record_id, p_from, v_s.generated_through);
  select * into v_r from ogevia.series_cancel_from(v_s, p_from, v_reason);
  if p_from <= v_s.starts_on then
    update ogevia.shift_series set status = 'ended', ended_at = now(), ended_by = v_actor, end_reason = v_reason where id = v_s.id;
  else
    update ogevia.shift_series set ends_on = p_from - 1, generated_through = least(generated_through, p_from - 1) where id = v_s.id;
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift_series.ended_from', 'shift_series', v_s.id,
    jsonb_build_object('ends_on', v_s.ends_on, 'status', v_s.status),
    jsonb_build_object('from', p_from, 'cancelled', v_r.cancelled, 'released_minutes', v_r.released_minutes, 'kept', v_r.kept), v_reason);
  perform ogevia.idempotency_finish('end_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('cancelled', v_r.cancelled, 'released_minutes', v_r.released_minutes, 'kept', v_r.kept));
  return query select v_r.cancelled, v_r.released_minutes, v_r.kept;
end;
$$;

-- "This and future": ends the series from a date and starts its replacement
-- from that date in ONE transaction. The replaced occurrences' time is counted
-- once (left out while the replacement is checked). Refused as a whole unless
-- the caller explicitly skips flagged dates.
create function ogevia_api.change_shift_series_from(
  p_organization_id uuid, p_series_id uuid, p_from date,
  p_caregiver_record_id uuid, p_weekdays smallint[], p_start time, p_end time, p_ends_on date,
  p_on_conflict text, p_reason text, p_idempotency_key uuid default null
)
returns table (series_id uuid, cancelled integer, created integer, skipped integer, kept integer)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_series_id, p_from, p_caregiver_record_id, array_to_string(p_weekdays, ','),
                         p_start, p_end, p_ends_on, p_on_conflict);
  v_prior jsonb;
  v_old ogevia.shift_series%rowtype;
  v_new ogevia.shift_series%rowtype;
  v_through date;
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
  v_through := ogevia.series_validate(p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id,
    p_weekdays, p_start, p_end, p_from, p_ends_on);
  perform ogevia.series_lock(p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id, p_from,
    greatest(v_through, v_old.generated_through));
  if v_old.caregiver_record_id is not null and v_old.caregiver_record_id is distinct from p_caregiver_record_id then
    perform pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || v_old.caregiver_record_id::text, 0));
  end if;
  insert into ogevia.shift_series (organization_id, client_id, service_id, caregiver_record_id, weekdays, start_time, end_time,
                                   starts_on, ends_on, generated_through, replaces_series_id, created_by)
  values (p_organization_id, v_old.client_id, v_old.service_id, p_caregiver_record_id,
          array(select d from unnest(p_weekdays) d order by d), p_start, p_end, p_from, p_ends_on, v_through, v_old.id, v_actor)
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
      'weekdays', v_new.weekdays, 'start_time', p_start, 'end_time', p_end, 'ends_on', p_ends_on,
      'cancelled', v_c.cancelled, 'kept', v_c.kept, 'created', v_m.created, 'skipped', v_m.skipped), v_reason);
  perform ogevia.idempotency_finish('change_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('series_id', v_new.id, 'cancelled', v_c.cancelled, 'created', v_m.created, 'skipped', v_m.skipped, 'kept', v_c.kept));
  return query select v_new.id, v_c.cancelled, v_m.created, v_m.skipped, v_c.kept;
end;
$$;

create function ogevia_api.extend_shift_series(
  p_organization_id uuid, p_series_id uuid, p_through date, p_on_conflict text default 'refuse', p_idempotency_key uuid default null
)
returns table (created integer, skipped integer, generated_through date)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_series_id, p_through, p_on_conflict);
  v_prior jsonb;
  v_s ogevia.shift_series%rowtype;
  v_from date;
  v_to date;
  v_m record;
begin
  v_prior := ogevia.idempotency_begin('extend_shift_series', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'created')::integer, (v_prior ->> 'skipped')::integer, (v_prior ->> 'generated_through')::date;
    return;
  end if;
  if p_on_conflict is null or p_on_conflict not in ('refuse', 'skip_flagged') then
    raise exception 'Choose what happens to dates that do not fit: refuse, or skip them' using errcode = 'OGV22';
  end if;
  v_s := ogevia.lock_series(p_organization_id, p_series_id);
  v_from := greatest(v_s.generated_through + 1, ogevia.organization_local_date(p_organization_id, now()));
  v_to := least(coalesce(v_s.ends_on, 'infinity'::date), p_through,
                (date_trunc('month', v_from) + interval '3 months' - interval '1 day')::date);
  if p_through is null or v_to < v_from then
    raise exception 'Nothing to add: the series is already scheduled through that date' using errcode = 'OGV22';
  end if;
  perform ogevia.series_lock(p_organization_id, v_s.client_id, v_s.service_id, v_s.caregiver_record_id, v_from, v_to);
  select * into v_m from ogevia.series_materialize(v_s, v_from, v_to, p_on_conflict, null, null, v_actor);
  update ogevia.shift_series set generated_through = v_to where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift_series.extended', 'shift_series', v_s.id,
    jsonb_build_object('generated_through', v_s.generated_through),
    jsonb_build_object('generated_through', v_to, 'created', v_m.created, 'skipped', v_m.skipped), null);
  perform ogevia.idempotency_finish('extend_shift_series', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('created', v_m.created, 'skipped', v_m.skipped, 'generated_through', v_to));
  return query select v_m.created, v_m.skipped, v_to;
end;
$$;

-- One occurrence (or any staff shift): move its date/time. The reservation
-- moves with it (same row), re-checked against the authorization of the new
-- date; refused once started or once a visit is linked.
create function ogevia_api.reschedule_shift(
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
    perform ogevia.check_shift_caregiver(p_organization_id, v_s.caregiver_record_id, v_starts, v_ends, v_s.id);
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

create function ogevia_api.list_shift_series(p_organization_id uuid)
returns table (
  series_id uuid, status text, client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text,
  caregiver_record_id uuid, caregiver_name text, weekdays smallint[], start_time time, end_time time,
  starts_on date, ends_on date, generated_through date, replaces_series_id uuid,
  upcoming_occurrences integer, skipped_dates jsonb
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select ss.id, ss.status, c.id, c.client_code,
         case when ogevia.has_permission(p_organization_id, 'clients.names.read')
              then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
         sv.id, sv.code, sv.name,
         cr.id, case when cr.id is not null then coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name end,
         ss.weekdays, ss.start_time, ss.end_time, ss.starts_on, ss.ends_on, ss.generated_through, ss.replaces_series_id,
         (select count(*)::integer from ogevia.shifts s where s.series_id = ss.id and s.status = 'scheduled' and s.starts_at > now()),
         coalesce((select jsonb_agg(jsonb_build_object('date', k.local_date, 'reason', k.reason, 'minutes', k.minutes) order by k.local_date)
                   from ogevia.shift_series_skipped_dates k where k.series_id = ss.id), '[]'::jsonb)
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

revoke all on function ogevia.valid_weekdays(smallint[]) from public;
revoke all on function ogevia.series_occurrences(text, smallint[], time, time, date, date) from public;
revoke all on function ogevia.series_evaluate(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, uuid, date) from public;
revoke all on function ogevia.series_validate(uuid, uuid, uuid, uuid, smallint[], time, time, date, date) from public;
revoke all on function ogevia.series_lock(uuid, uuid, uuid, uuid, date, date) from public;
revoke all on function ogevia.series_materialize(ogevia.shift_series, date, date, text, uuid, date, uuid) from public;
revoke all on function ogevia.series_cancel_from(ogevia.shift_series, date, text) from public;
revoke all on function ogevia.lock_series(uuid, uuid) from public;
revoke all on function ogevia_api.preview_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date) from public;
revoke all on function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid) from public;
revoke all on function ogevia_api.end_shift_series(uuid, uuid, date, text, uuid) from public;
revoke all on function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid) from public;
revoke all on function ogevia_api.extend_shift_series(uuid, uuid, date, text, uuid) from public;
revoke all on function ogevia_api.reschedule_shift(uuid, uuid, date, time, time, text, uuid) from public;
revoke all on function ogevia_api.list_shift_series(uuid) from public;
grant execute on function ogevia_api.preview_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date) to ogevia_app;
grant execute on function ogevia_api.create_shift_series(uuid, uuid, uuid, uuid, smallint[], time, time, date, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.end_shift_series(uuid, uuid, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.change_shift_series_from(uuid, uuid, date, uuid, smallint[], time, time, date, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.extend_shift_series(uuid, uuid, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.reschedule_shift(uuid, uuid, date, time, time, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_shift_series(uuid) to ogevia_app;

-- list_shifts (0032 shape) also returns the series an occurrence belongs to.
drop function ogevia_api.list_shifts(uuid, date, date, uuid);
create function ogevia_api.list_shifts(p_organization_id uuid, p_from date, p_to date, p_client_id uuid default null)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, local_date date, coverage_state text, shift_status text,
  client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text,
  caregiver_record_id uuid, caregiver_code text, caregiver_name text, has_sign_in boolean,
  reserved_minutes integer, from_care_request boolean, has_visit boolean, last_callout_reason text,
  series_id uuid
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
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
         s.series_id
  from ctx
  join ogevia.shifts s on s.organization_id = p_organization_id
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = s.organization_id and cr.deleted_at is null
    and (cr.id = s.caregiver_record_id or (s.caregiver_record_id is null and cr.linked_user_id = s.caregiver_user_id))
  left join ogevia.client_private_names n on n.client_id = c.id
  -- 0032: only a reservation still held (a cancelled shift, or one whose visit was signed, holds nothing).
  left join ogevia.authorization_reservations r on r.shift_id = s.id and r.released_at is null
  where ctx.actor is not null and ctx.can_list
    and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62
    and (s.starts_at at time zone ctx.tz)::date between p_from and p_to
    and (p_client_id is null or s.client_id = p_client_id)
  order by s.starts_at, c.client_code;
$$;
revoke all on function ogevia_api.list_shifts(uuid, date, date, uuid) from public;
grant execute on function ogevia_api.list_shifts(uuid, date, date, uuid) to ogevia_app;
