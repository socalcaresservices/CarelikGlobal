-- Archive copies retain values, not operational constraints or automatic restoration.
-- Prefer retaining the migrated database and rolling back compatible application artifacts.
-- ROLLBACK 0042_readiness_gate | CLASS: BACKUP REQUIRED (archives settings, history and overrides; drops nothing that holds data)
-- Restores every function the gate was added to, exactly as it was, then archives the readiness settings,
-- the setting-change history and the availability overrides into ogevia.archived_*_0042_<timestamp> tables
-- (count-checked). Series skipped dates recorded for readiness reasons are archived and removed so the old
-- reason list can be restored (the table's no-delete trigger is lifted for that one statement).
do $$
declare
  v_ts text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
  t text;
  n_src bigint;
  n_dst bigint;
begin
  foreach t in array array['organization_readiness_settings', 'readiness_setting_events', 'availability_overrides'] loop
    execute format('select count(*) from ogevia.%I', t) into n_src;
    if n_src > 0 then
      execute format('create table ogevia.%I as table ogevia.%I', 'archived_' || t || '_0042_' || v_ts, t);
      execute format('select count(*) from ogevia.%I', 'archived_' || t || '_0042_' || v_ts) into n_dst;
      if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of % is incomplete', t; end if;
    end if;
  end loop;
  select count(*) into n_src from ogevia.shift_series_skipped_dates
   where reason in ('documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided');
  if n_src > 0 then
    execute format('create table ogevia.%I as select * from ogevia.shift_series_skipped_dates where reason in (''documents_not_current'', ''service_not_approved'', ''availability_outside'', ''availability_not_provided'')',
                   'archived_shift_series_skipped_dates_0042_' || v_ts);
    execute format('select count(*) from ogevia.%I', 'archived_shift_series_skipped_dates_0042_' || v_ts) into n_dst;
    if n_dst <> n_src then raise exception 'ROLLBACK REFUSED: archive copy of skipped dates is incomplete'; end if;
  end if;
end $$;

alter table ogevia.shift_series_skipped_dates disable trigger shift_series_skipped_dates_no_delete;
delete from ogevia.shift_series_skipped_dates
 where reason in ('documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided');
alter table ogevia.shift_series_skipped_dates enable trigger shift_series_skipped_dates_no_delete;
alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check check (
  reason in ('exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started',
             'time_does_not_exist', 'time_occurs_twice'));

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
  v_rec := ogevia.check_shift_caregiver(p_organization_id, p_caregiver_record_id, v_s.starts_at, v_s.ends_at, v_s.id);
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

create or replace function ogevia_api.assign_care_request(p_organization_id uuid,p_request_id uuid,p_offer_id uuid)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare r ogevia.care_requests%rowtype; o ogevia.care_request_offers%rowtype; cr ogevia.caregiver_records%rowtype; a ogevia.client_authorizations%rowtype; v_shift uuid; v_used bigint; v_reserved bigint; v_date date;
begin
 if not ogevia.has_permission(p_organization_id,'care_requests.manage') then raise exception 'Forbidden' using errcode='OGA03'; end if;
 select * into r from ogevia.care_requests where id=p_request_id and organization_id=p_organization_id for update;
 select * into o from ogevia.care_request_offers where id=p_offer_id and care_request_id=p_request_id and organization_id=p_organization_id and status='available' for update;
 if r.id is null or o.id is null then raise exception 'Request or accepted offer not found' using errcode='OGN04'; end if;
 select * into cr from ogevia.caregiver_records where id=o.caregiver_record_id and organization_id=p_organization_id and status in('ready','active') and deleted_at is null;
 if cr.id is null then raise exception 'Caregiver is no longer active' using errcode='OGV22'; end if;
 if not exists(select 1 from ogevia_api.list_available_caregivers(p_organization_id,p_request_id) x where x.caregiver_record_id=cr.id) then
   raise exception 'Caregiver is no longer available for this request' using errcode='OGC09';
 end if;
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

-- check_shift_caregiver returns to its single 0026 form.
drop function ogevia.check_shift_caregiver(uuid, uuid, timestamptz, timestamptz, uuid);
drop function ogevia.check_shift_caregiver(uuid, uuid, timestamptz, timestamptz, uuid, uuid);
create function ogevia.check_shift_caregiver(
  p_organization_id uuid, p_caregiver_record_id uuid, p_starts timestamptz, p_ends timestamptz, p_exclude_shift uuid
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
  perform pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || v_rec.id::text, 0));
  if exists (
    select 1 from ogevia.shifts s
    where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
      and (s.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
      and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
      and s.starts_at < p_ends and s.ends_at > p_starts) then
    raise exception 'This caregiver already has a shift at that time' using errcode = 'OGC09';
  end if;
  return v_rec;
end;
$$;

drop function ogevia_api.list_readiness_flags(uuid, text);
drop function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text);
drop function ogevia_api.set_service_checks(uuid, boolean, text);
drop function ogevia_api.activate_readiness_enforcement(uuid, text, integer);
drop function ogevia_api.get_readiness_status(uuid);
drop function ogevia_api.evaluate_assignment_readiness_local(uuid, uuid, uuid, date, time, time, text, uuid, uuid);
drop function ogevia_api.evaluate_assignment_readiness(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid);
drop function ogevia.readiness_manage_guard(uuid);
drop function ogevia.readiness_read_guard(uuid);
drop function ogevia.readiness_outcome(uuid, uuid, uuid, timestamptz, timestamptz);
drop function ogevia.assert_ready_for_assignment(uuid, uuid, uuid, date);
drop function ogevia.assert_ready_for_work(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid);
drop function ogevia.readiness_checks(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid, boolean);
drop function ogevia.client_requirement_issues(uuid, uuid, uuid);
drop function ogevia.readiness_enforced(uuid, text, text);
drop function ogevia.readiness_message(text, text);
drop table ogevia.availability_overrides;
drop table ogevia.readiness_setting_events;
drop table ogevia.organization_readiness_settings;
delete from ogevia.role_permissions where permission_key in ('readiness.read', 'readiness.manage', 'availability.override');
delete from ogevia.permissions where key in ('readiness.read', 'readiness.manage', 'availability.override');
