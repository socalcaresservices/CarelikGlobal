-- ROLLBACK 0047 | CLASS: SAFE AUTOMATED (no tables or records removed). Restores the 0042/0046 override behaviour: readiness_checks and
-- assert_ready_for_work as before, the 5-argument authorize_availability_override, and list_shifts without the override columns.
-- The columns and constraints 0047 added to availability_overrides are KEPT (nullable, harmless) so override history is not lost, and
-- a re-application of 0047 is idempotent. Overrides made under 0047 (exact shift time, one client) still satisfy the old range rule.
drop trigger if exists shifts_link_availability_override on ogevia.shifts;
drop function if exists ogevia.link_availability_override_to_shift();

drop function if exists ogevia_api.list_shifts(uuid, date, date, uuid);
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

drop function if exists ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text, uuid);
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

revoke all on function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text) from public;
grant execute on function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text) to ogevia_app;

create or replace function ogevia.readiness_checks(
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

  if p_context in ('shift', 'care_request', 'reschedule', 'series', 'visit_start') then
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

create or replace function ogevia.assert_ready_for_work(
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

drop function if exists ogevia.availability_override_for(uuid, uuid, timestamptz, timestamptz, text, uuid);
