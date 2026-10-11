-- 0047 Availability override: ONE shift, ONE use, with the match result it was approved against.
--
-- Owner decision (2026-10-11): an Admin (organization owner) may override a No Match and assign a caregiver outside their recorded
-- availability for a legitimate operational reason. This repairs the 0042 mechanism; it adds no second system.
--   * Before: an override was tied to a caregiver and a time RANGE (up to 400 days, 30 minutes), usable any number of times, with no
--     client, no shift and no record of the original result.
--   * Now: an override is for one caregiver, ONE client and ONE exact shift time (at most 24 hours); it records the availability result it
--     lifted ("outside" or "not provided", shown as No Match); it is consumed by the first assignment that uses it (it cannot cover a second
--     shift, a similar future shift, or a shift for another client) and is linked to that shift, which then shows "assigned with Admin
--     override". It expires after 30 minutes if unused.
--   * It NEVER changes the caregiver's stored availability and lifts the availability check only (CPR/TB, service approval, status,
--     overlap, client authorisation and mandatory client requirements stay mandatory). Only an administrator can grant it (availability.override).
--   * Recurring series: an override is NOT honoured in the series context, so a series cannot be built on a single override. Create the one
--     date as an ordinary shift with an override and skip that date in the series.
--   * Visit start keeps its covering rule (the interval is "now"), but is also single-use and bound to the client.
--   * Existing override rows made under the old rule have no client and are inert; they expired within 30 minutes of being made.
-- Changes: availability_overrides (new nullable columns), ogevia.availability_override_for, ogevia.readiness_checks and
-- ogevia.assert_ready_for_work (CREATE OR REPLACE, same signatures), a trigger that links the consumed override to the shift,
-- ogevia_api.authorize_availability_override (new 6-argument form; the 5-argument form is removed), ogevia_api.list_shifts (two new columns).

alter table ogevia.availability_overrides
  add column if not exists client_id uuid,
  add column if not exists original_status text,
  add column if not exists consumed_at timestamptz,
  add column if not exists consumed_context text,
  add column if not exists shift_id uuid references ogevia.shifts(id) on delete set null;
alter table ogevia.availability_overrides
  drop constraint if exists availability_overrides_client_fk,
  drop constraint if exists availability_overrides_original_status,
  drop constraint if exists availability_overrides_one_shift,
  drop constraint if exists availability_overrides_consumed_shape;
alter table ogevia.availability_overrides
  add constraint availability_overrides_client_fk foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  add constraint availability_overrides_original_status check (original_status is null or original_status in ('outside', 'not_provided')),
  add constraint availability_overrides_one_shift check (client_id is null or range_end - range_start <= interval '24 hours'),
  add constraint availability_overrides_consumed_shape check (consumed_at is not null or shift_id is null);
create index if not exists availability_overrides_shift_idx on ogevia.availability_overrides (shift_id) where shift_id is not null;

-- The unused, unexpired override that applies to this exact check, or null. Series checks never use one.
create function ogevia.availability_override_for(
  p_organization_id uuid, p_caregiver_record_id uuid, p_starts timestamptz, p_ends timestamptz, p_context text, p_client_id uuid
)
returns uuid
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select o.id
  from ogevia.availability_overrides o
  where o.organization_id = p_organization_id and o.caregiver_record_id = p_caregiver_record_id
    and o.client_id is not null
    and ((o.consumed_at is null and o.expires_at > now())
         -- A visit start is checked twice in one transaction (the start function, then the new-visit trigger): the override used by the
         -- first check, in this same transaction, still applies to the second. It is never reusable by a later transaction.
         or (p_context = 'visit_start' and o.consumed_context = 'visit_start' and o.consumed_at = now()))
    and p_context in ('shift', 'reschedule', 'care_request', 'visit_start')
    and (p_client_id is null or o.client_id = p_client_id)
    and case when p_context = 'visit_start' then o.range_start <= p_starts and o.range_end >= p_ends
             else o.range_start = p_starts and o.range_end = p_ends end
  order by (o.consumed_at is null) desc, o.created_at desc
  limit 1;
$$;

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
  v_used uuid;
begin
  select string_agg(c.message, ' ' order by c.check_name), string_agg(c.check_name || ':' || c.code, ',' order by c.check_name)
    into v_msgs, v_codes
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, p_context, null, p_client_id, false) c
  where c.status = 'blocked' and c.enforced;
  if v_msgs is not null then
    raise exception '%', v_msgs using errcode = 'OGR30', detail = v_codes;
  end if;
  -- An availability override is for ONE shift: using it records the use, marks it consumed (it cannot be used again),
  -- and writes the audit event with the client and the match result it was approved against.
  if exists (select 1 from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, p_context, null, p_client_id, false) c
             where c.check_name = 'availability' and c.status = 'overridden') then
    v_ov := ogevia.availability_override_for(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_context, p_client_id);
    if v_ov is not null then
      update ogevia.availability_overrides o
         set used_count = o.used_count + 1, last_used_at = now(), consumed_at = now(), consumed_context = p_context
       where o.id = v_ov and o.consumed_at is null
      returning o.id into v_used;
      if v_used is null then
        -- Already consumed. Only the second check of the same visit start, in this same transaction, may pass.
        if not exists (select 1 from ogevia.availability_overrides o where o.id = v_ov and o.consumed_at = now() and o.consumed_context = 'visit_start') then
          raise exception 'This availability override has already been used. Ask an administrator for a new one.' using errcode = 'OGR30';
        end if;
      else
        perform ogevia.write_audit(p_organization_id, 'availability.override_used', 'availability_overrides', v_used, null,
          jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'client_id', p_client_id, 'starts_at', p_starts, 'ends_at', p_ends,
                             'context', p_context), null);
      end if;
    end if;
  end if;
end;
$$;

-- Grant: administrator only; one caregiver, one client, one exact shift time. Refuses when there is nothing to override.
drop function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text);
create function ogevia_api.authorize_availability_override(
  p_organization_id uuid, p_caregiver_record_id uuid, p_range_start timestamptz, p_range_end timestamptz, p_reason text, p_client_id uuid
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
  v_status text;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'availability.override') then
    raise exception 'Only an administrator can override availability' using errcode = 'OGA03';
  end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the override' using errcode = 'OGV22'; end if;
  if p_range_start is null or p_range_end is null or p_range_end <= p_range_start or p_range_end - p_range_start > interval '24 hours' then
    raise exception 'An override covers one shift: enter its start and end (at most 24 hours)' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id
                 and r.deleted_at is null and r.status in ('ready', 'active')) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  if p_client_id is null or not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id
                                        and c.deleted_at is null and c.status = 'active') then
    raise exception 'Choose the client this shift is for' using errcode = 'OGV22';
  end if;
  v_status := ogevia.availability_status(p_organization_id, p_caregiver_record_id, p_range_start, p_range_end);
  if v_status = 'covered' then
    raise exception 'This caregiver is already available for that time; there is nothing to override' using errcode = 'OGV22';
  end if;
  insert into ogevia.availability_overrides (id, organization_id, caregiver_record_id, client_id, range_start, range_end, reason,
                                             authorised_by, expires_at, original_status)
  values (v_id, p_organization_id, p_caregiver_record_id, p_client_id, p_range_start, p_range_end, v_reason, v_actor,
          now() + interval '30 minutes', v_status);
  perform ogevia.write_audit(p_organization_id, 'availability.override_authorized', 'availability_overrides', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'client_id', p_client_id, 'range_start', p_range_start,
                       'range_end', p_range_end, 'original_result', case v_status when 'outside' then 'no_match' else 'no_match_not_provided' end),
    v_reason);
  return v_id;
end;
$$;
revoke all on function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text, uuid) from public;
grant execute on function ogevia_api.authorize_availability_override(uuid, uuid, timestamptz, timestamptz, text, uuid) to ogevia_app;

-- Links the override consumed in THIS transaction to the shift it was used for (insert, caregiver change or reschedule), and refuses
-- the whole change if that shift is for a different client than the override was approved for.
create function ogevia.link_availability_override_to_shift()
returns trigger
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_ov ogevia.availability_overrides%rowtype;
begin
  if new.caregiver_record_id is null then return new; end if;
  select * into v_ov from ogevia.availability_overrides o
   where o.organization_id = new.organization_id and o.caregiver_record_id = new.caregiver_record_id
     and o.consumed_at = now() and o.shift_id is null and o.consumed_context in ('shift', 'reschedule', 'care_request')
     and o.range_start = new.starts_at and o.range_end = new.ends_at
   order by o.consumed_at desc, o.created_at desc
   limit 1
   for update;
  if v_ov.id is null then return new; end if;
  if v_ov.client_id is distinct from new.client_id then
    raise exception 'This availability override was approved for a different client' using errcode = 'OGR30';
  end if;
  update ogevia.availability_overrides set shift_id = new.id where id = v_ov.id;
  perform ogevia.write_audit(new.organization_id, 'availability.override_linked', 'shifts', new.id, null,
    jsonb_build_object('override_id', v_ov.id, 'caregiver_record_id', new.caregiver_record_id, 'client_id', new.client_id), v_ov.reason);
  return new;
end;
$$;
create trigger shifts_link_availability_override
after insert or update of caregiver_record_id, starts_at, ends_at on ogevia.shifts
for each row execute function ogevia.link_availability_override_to_shift();

-- list_shifts gains availability_override / availability_override_reason.
drop function ogevia_api.list_shifts(uuid, date, date, uuid);
create function ogevia_api.list_shifts(p_organization_id uuid, p_from date, p_to date, p_client_id uuid default null)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, local_date date, coverage_state text, shift_status text,
  client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text,
  caregiver_record_id uuid, caregiver_code text, caregiver_name text, has_sign_in boolean,
  reserved_minutes integer, from_care_request boolean, has_visit boolean, last_callout_reason text,
  series_id uuid, availability_override boolean, availability_override_reason text
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
         s.series_id, (ov.id is not null), ov.reason
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

revoke all on function ogevia_api.list_shifts(uuid, date, date, uuid) from public;
grant execute on function ogevia_api.list_shifts(uuid, date, date, uuid) to ogevia_app;
