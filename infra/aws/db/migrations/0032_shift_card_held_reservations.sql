-- 0032 Shift card shows only reservations still held; shift refusal in hours and minutes.
--
-- Owner test 2026-10-05: a cancelled shift released its hour (the balance went
-- back up) but its card still said "1h reserved". list_shifts (0026) joined
-- authorization_reservations without released_at is null, so it showed the
-- released reservation. Same return type; only the join changes. Balances and
-- the reservation rows themselves were already correct and are not touched.
create or replace function ogevia_api.list_shifts(p_organization_id uuid, p_from date, p_to date, p_client_id uuid default null)
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
  -- 0032: only a reservation still held (a cancelled shift, or one whose visit was signed, holds nothing).
  left join ogevia.authorization_reservations r on r.shift_id = s.id and r.released_at is null
  where ctx.actor is not null and ctx.can_list
    and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62
    and (s.starts_at at time zone ctx.tz)::date between p_from and p_to
    and (p_client_id is null or s.client_id = p_client_id)
  order by s.starts_at, c.client_code;
$$;

-- "2 hr 59 min", "3 hr", "1 min", "0 min" (messages only; never used in calculations).
create function ogevia.format_duration(p_minutes integer)
returns text
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select case
    when p_minutes is null then null
    when p_minutes < 60 then p_minutes || ' min'
    when p_minutes % 60 = 0 then (p_minutes / 60) || ' hr'
    else (p_minutes / 60) || ' hr ' || (p_minutes % 60) || ' min'
  end;
$$;
revoke all on function ogevia.format_duration(integer) from public;

-- Owner test 2026-10-05: "179 minutes" left should read "2 hr 59 min available".
-- Same rule and limit as 0026; only the refusal wording changes.
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
