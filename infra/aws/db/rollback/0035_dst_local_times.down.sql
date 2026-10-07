-- ROLLBACK 0035_dst_local_times | CLASS: SAFE AUTOMATED (no data)
-- Restores create_shift (0032), reschedule_shift and series_evaluate (0034)
-- exactly and drops the local-time helpers. No rows change. Shifts created
-- while 0035 was applied stay as they are (they all have clear local times).
-- Refuses while a skipped date records a daylight-saving reason (it would no
-- longer fit the 0034 constraint).
do $$ begin
  if exists (select 1 from ogevia.shift_series_skipped_dates where reason in ('time_does_not_exist', 'time_occurs_twice')) then
    raise exception 'ROLLBACK REFUSED: skipped series dates record a daylight-saving reason; keep 0035 (export them first if needed)';
  end if;
end $$;
alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check
  check (reason in ('exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started'));
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
    v_rec := ogevia.check_shift_caregiver(p_organization_id, p_caregiver_record_id, v_starts, v_ends, null);
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
drop function ogevia.require_clear_local_times(text, date, time, time);
drop function ogevia.local_times_issue(text, date, time, time);
drop function ogevia.local_time_issue(text, date, time);
