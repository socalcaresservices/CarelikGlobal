-- 0026 Staff-scheduled shifts, call-outs, replacements and coverage history.
--
-- Extends the canonical shifts / shift_coverage_events / authorization
-- reservation model (0003, 0011, 0013, 0014); it does NOT add a second
-- scheduler. Care Request shifts (0011) keep their own workflow: the staff
-- functions below refuse to change a shift that belongs to a Care Request.
--
--   * shifts.manage (Administrator, manager, scheduler).
--   * create_shift: client, service, agency-local date and start/end time
--     (an end at or before the start means the next day), optional caregiver.
--     The server converts the times with the agency's time zone. A current
--     authorization must cover the client and service on that date; the
--     shift's minutes are RESERVED against that authorization's month under
--     the same advisory lock and the same arithmetic as Care Requests
--     (billable usage + unreleased reservations + this shift <= authorized).
--     A shift with no caregiver is OPEN (uncovered). A caregiver must be Ready
--     to work or Active and must not have an overlapping shift. A caregiver
--     without a sign-in can be scheduled; the shift gives access only once
--     they have one (unchanged 0014 rule).
--   * record_shift_callout (staff) and call_out_my_shift (the caregiver,
--     before the shift starts): the shift stays reserved and becomes
--     "needs coverage"; the called-out caregiver can no longer start a visit
--     from it (0014 already ignores called-out shifts).
--   * assign_shift_caregiver: fills an open or called-out shift (or swaps the
--     caregiver), with the same status and overlap checks; history is kept.
--   * cancel_shift: refused once a visit is linked; releases the reservation.
--   * list_shifts / list_shift_coverage: schedule and history. Client names
--     only with clients.names.read; caregivers see only their own shifts
--     through list_my_shifts (codes, no names).
-- Every change is audited; create/call-out/assign/cancel are idempotent.

insert into ogevia.permissions (key, description) values
  ('shifts.manage', 'Schedule shifts, record call-outs and assign replacement caregivers');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'shifts.manage'),
  ('manager', 'shifts.manage'),
  ('scheduler', 'shifts.manage');

-- Staff-created shifts reserve time without a Care Request. The shift remains
-- the reservation's identity (shift_id is NOT NULL UNIQUE since 0011).
alter table ogevia.authorization_reservations alter column care_request_id drop not null;

alter table ogevia.shifts
  add column authorization_lineage_id uuid references ogevia.client_authorizations(id),
  add column created_by uuid references ogevia.app_users(id),
  add column cancel_reason text;
create index shifts_org_start_idx on ogevia.shifts (organization_id, starts_at);
create index shifts_caregiver_record_idx on ogevia.shifts (organization_id, caregiver_record_id, starts_at) where status = 'scheduled';

-- Every unreleased reservation in the service date's month, Care Request or
-- staff shift alike. (care_request_reserved_usage cannot be used with no
-- request to exclude: "null is distinct from null" is false, so it would skip
-- every staff-shift reservation.)
create function ogevia.authorization_month_reserved(p_lineage_id uuid, p_service_date date)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(sum(r.reserved_minutes), 0)::bigint
  from ogevia.authorization_reservations r
  where r.authorization_lineage_id = p_lineage_id
    and r.released_at is null
    and r.service_date >= date_trunc('month', p_service_date::timestamp)::date
    and r.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date;
$$;

create function ogevia.shift_admin_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'shifts.manage') then
    raise exception 'You do not have permission to manage the schedule' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

-- Coverage state, one place: covered / needs_coverage / completed / cancelled / no_show.
create function ogevia.shift_coverage_state(p_shift ogevia.shifts)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when p_shift.status <> 'scheduled' then p_shift.status::text
    when p_shift.caregiver_record_id is null and p_shift.caregiver_user_id is null then 'needs_coverage'
    when ogevia.shift_is_called_out(p_shift.id) then 'needs_coverage'
    else 'covered' end;
$$;

create function ogevia.shift_is_care_request(p_shift_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (select 1 from ogevia.care_requests r where r.assigned_shift_id = p_shift_id);
$$;

-- A caregiver who may be scheduled at these times: Ready or Active and free.
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

create function ogevia_api.create_shift(
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
    raise exception 'Not enough authorized time remains this month for this shift (% minutes left)',
      greatest(v_auth.monthly_authorized_minutes - v_used - v_reserved, 0) using errcode = 'OGC09';
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

-- Loads a staff-managed shift for change, locked.
create function ogevia.lock_staff_shift(p_organization_id uuid, p_shift_id uuid)
returns ogevia.shifts
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare v_s ogevia.shifts%rowtype;
begin
  select * into v_s from ogevia.shifts s where s.id = p_shift_id and s.organization_id = p_organization_id for update;
  if v_s.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  if ogevia.shift_is_care_request(v_s.id) then
    raise exception 'This shift came from a Care Request; manage it on the Care Requests page' using errcode = 'OGC09';
  end if;
  if v_s.status <> 'scheduled' then raise exception 'This shift is no longer scheduled' using errcode = 'OGC09'; end if;
  return v_s;
end;
$$;

create function ogevia.callout_shift(p_organization_id uuid, p_s ogevia.shifts, p_actor uuid, p_reason text, p_by text)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
begin
  if p_s.caregiver_record_id is null and p_s.caregiver_user_id is null then
    raise exception 'This shift has no caregiver to call out' using errcode = 'OGC09';
  end if;
  if ogevia.shift_is_called_out(p_s.id) then raise exception 'This call-out is already recorded' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = p_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type, actor_user_id, original_caregiver_record_id, reason, before_snapshot, after_snapshot)
  values (p_organization_id, p_s.id, 'called_out', p_actor, p_s.caregiver_record_id, p_reason,
          jsonb_build_object('caregiver_record_id', p_s.caregiver_record_id), jsonb_build_object('coverage_needed', true, 'recorded_by', p_by));
  perform ogevia.write_audit(p_organization_id, 'shift.called_out', 'shifts', p_s.id,
    jsonb_build_object('caregiver_record_id', p_s.caregiver_record_id), jsonb_build_object('coverage_needed', true, 'recorded_by', p_by), p_reason);
end;
$$;

create function ogevia_api.record_shift_callout(p_organization_id uuid, p_shift_id uuid, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_shift_id);
  v_prior jsonb;
  v_s ogevia.shifts%rowtype;
begin
  v_prior := ogevia.idempotency_begin('record_shift_callout', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for the call-out' using errcode = 'OGV22'; end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;
  perform ogevia.callout_shift(p_organization_id, v_s, v_actor, v_reason, 'staff');
  perform ogevia.idempotency_finish('record_shift_callout', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'needs_coverage'));
  return 'needs_coverage';
end;
$$;

-- The caregiver reports they cannot work their own upcoming shift.
create function ogevia_api.call_out_my_shift(p_organization_id uuid, p_shift_id uuid, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_shift_id);
  v_prior jsonb;
  v_s ogevia.shifts%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_prior := ogevia.idempotency_begin('call_out_my_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Tell the office why you cannot come' using errcode = 'OGV22'; end if;
  select s.* into v_s from ogevia.shifts s
  left join ogevia.caregiver_records cr on cr.id = s.caregiver_record_id and cr.organization_id = s.organization_id and cr.deleted_at is null
  where s.id = p_shift_id and s.organization_id = p_organization_id
    and (s.caregiver_user_id = v_actor or cr.linked_user_id = v_actor)
  for update of s;
  if v_s.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  if ogevia.shift_is_care_request(v_s.id) then
    raise exception 'Use the link in your Care Request message to cancel this assignment' using errcode = 'OGC09';
  end if;
  if v_s.status <> 'scheduled' then raise exception 'This shift is no longer scheduled' using errcode = 'OGC09'; end if;
  if v_s.starts_at <= now() then
    raise exception 'This shift has already started; call the office' using errcode = 'OGC09';
  end if;
  perform ogevia.callout_shift(p_organization_id, v_s, v_actor, v_reason, 'caregiver');
  perform ogevia.idempotency_finish('call_out_my_shift', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'needs_coverage'));
  return 'needs_coverage';
end;
$$;

create function ogevia_api.assign_shift_caregiver(
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

create function ogevia_api.cancel_shift(p_organization_id uuid, p_shift_id uuid, p_reason text, p_idempotency_key uuid default null)
returns integer
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_shift_id);
  v_prior jsonb;
  v_s ogevia.shifts%rowtype;
  v_released integer;
begin
  v_prior := ogevia.idempotency_begin('cancel_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'released_minutes')::integer; end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for cancelling' using errcode = 'OGV22'; end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit is linked to this shift; it cannot be cancelled' using errcode = 'OGC09';
  end if;
  update ogevia.shifts set status = 'cancelled', cancel_reason = v_reason, updated_at = now() where id = v_s.id;
  update ogevia.authorization_reservations r set released_at = now(), release_reason = 'shift_cancelled'
   where r.shift_id = v_s.id and r.released_at is null
  returning r.reserved_minutes into v_released;
  perform ogevia.write_audit(p_organization_id, 'shift.cancelled', 'shifts', v_s.id,
    jsonb_build_object('status', 'scheduled'), jsonb_build_object('status', 'cancelled', 'released_minutes', coalesce(v_released, 0)), v_reason);
  perform ogevia.idempotency_finish('cancel_shift', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('released_minutes', coalesce(v_released, 0)));
  return coalesce(v_released, 0);
end;
$$;

create function ogevia_api.list_shifts(p_organization_id uuid, p_from date, p_to date, p_client_id uuid default null)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, local_date date, coverage_state text, shift_status text,
  client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text,
  caregiver_record_id uuid, caregiver_code text, caregiver_name text, has_sign_in boolean,
  reserved_minutes integer, from_care_request boolean, has_visit boolean, last_callout_reason text
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
         (select e.reason from ogevia.shift_coverage_events e where e.shift_id = s.id and e.event_type = 'called_out' order by e.created_at desc limit 1)
  from ctx
  join ogevia.shifts s on s.organization_id = p_organization_id
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = s.organization_id and cr.deleted_at is null
    and (cr.id = s.caregiver_record_id or (s.caregiver_record_id is null and cr.linked_user_id = s.caregiver_user_id))
  left join ogevia.client_private_names n on n.client_id = c.id
  left join ogevia.authorization_reservations r on r.shift_id = s.id
  where ctx.actor is not null and ctx.can_list
    and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62
    and (s.starts_at at time zone ctx.tz)::date between p_from and p_to
    and (p_client_id is null or s.client_id = p_client_id)
  order by s.starts_at, c.client_code;
$$;

create function ogevia_api.list_shift_coverage(p_organization_id uuid, p_shift_id uuid)
returns table (event_type text, created_at timestamptz, reason text, original_caregiver_name text, replacement_caregiver_name text, recorded_by text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select e.event_type::text, e.created_at, e.reason,
         case when o.id is not null then coalesce(o.preferred_name, o.first_name) || ' ' || o.last_name end,
         case when p.id is not null then coalesce(p.preferred_name, p.first_name) || ' ' || p.last_name end,
         coalesce(e.after_snapshot ->> 'recorded_by', case when e.actor_user_id is null then 'caregiver link' else 'staff' end)
  from ogevia.shift_coverage_events e
  left join ogevia.caregiver_records o on o.id = e.original_caregiver_record_id
  left join ogevia.caregiver_records p on p.id = e.replacement_caregiver_record_id
  where ogevia.require_actor() is not null and e.organization_id = p_organization_id and e.shift_id = p_shift_id
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage'))
  order by e.created_at;
$$;

-- A caregiver's own upcoming shifts (codes only; no client names or payer data).
create function ogevia_api.list_my_shifts(p_organization_id uuid)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, client_code text, service_name text, coverage_state text, can_call_out boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.id, s.starts_at, s.ends_at, coalesce(c.caregiver_display_code, c.client_code), sv.name,
         case when ogevia.shift_is_called_out(s.id) then 'called_out' else ogevia.shift_coverage_state(s) end,
         s.status = 'scheduled' and s.starts_at > now() and not ogevia.shift_is_called_out(s.id) and not ogevia.shift_is_care_request(s.id)
  from ogevia.shifts s
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.id = s.caregiver_record_id and cr.organization_id = s.organization_id and cr.deleted_at is null
  where s.organization_id = p_organization_id and ogevia.is_active_member(p_organization_id)
    and (s.caregiver_user_id = ogevia.require_actor() or cr.linked_user_id = ogevia.require_actor())
    and s.status = 'scheduled' and s.ends_at > now() and s.starts_at < now() + interval '14 days'
  order by s.starts_at;
$$;

revoke all on function ogevia.authorization_month_reserved(uuid, date) from public;
revoke all on function ogevia.shift_admin_guard(uuid) from public;
revoke all on function ogevia.shift_coverage_state(ogevia.shifts) from public;
revoke all on function ogevia.shift_is_care_request(uuid) from public;
revoke all on function ogevia.check_shift_caregiver(uuid, uuid, timestamptz, timestamptz, uuid) from public;
revoke all on function ogevia.lock_staff_shift(uuid, uuid) from public;
revoke all on function ogevia.callout_shift(uuid, ogevia.shifts, uuid, text, text) from public;
revoke all on function ogevia_api.create_shift(uuid, uuid, uuid, date, time, time, uuid, uuid) from public;
revoke all on function ogevia_api.record_shift_callout(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.call_out_my_shift(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.assign_shift_caregiver(uuid, uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.cancel_shift(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.list_shifts(uuid, date, date, uuid) from public;
revoke all on function ogevia_api.list_shift_coverage(uuid, uuid) from public;
revoke all on function ogevia_api.list_my_shifts(uuid) from public;
grant execute on function ogevia_api.create_shift(uuid, uuid, uuid, date, time, time, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.record_shift_callout(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.call_out_my_shift(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.assign_shift_caregiver(uuid, uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.cancel_shift(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_shifts(uuid, date, date, uuid) to ogevia_app;
grant execute on function ogevia_api.list_shift_coverage(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_my_shifts(uuid) to ogevia_app;
