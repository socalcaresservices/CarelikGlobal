-- ROLLBACK 0078 | CLASS: SAFE AUTOMATED (functions only; no table or data change). Restores the 0042 evaluation (no outcome/summary), the 0055 readiness messages, the 0060 hour-limit checks and backstop trigger function, and drops the two helpers.
-- All checks for one caregiver, client/service and interval, for the assignment screens. Nothing is changed.
create or replace function ogevia_api.evaluate_assignment_readiness(
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
    'startsAt', p_starts, 'endsAt', p_ends, 'context', p_context,
    'checks', v_rows,
    'ready', not exists (select 1 from jsonb_array_elements(v_rows) e where (e ->> 'blocking')::boolean),
    'wouldBlockAfterActivation', exists (select 1 from jsonb_array_elements(v_rows) e where e ->> 'status' = 'blocked' and not (e ->> 'enforced')::boolean));
end;
$$;


create or replace function ogevia.shifts_work_hours_guard()
returns trigger
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_issue text;
  v_mode text;
begin
  if new.status <> 'scheduled' or new.caregiver_record_id is null or new.ends_at <= now() then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'scheduled' and new.caregiver_record_id is not distinct from old.caregiver_record_id
     and new.starts_at = old.starts_at and new.ends_at = old.ends_at then
    return new;
  end if;
  perform ogevia.lock_caregiver(new.caregiver_record_id);
  select (ogevia.effective_hour_limit(new.organization_id, new.caregiver_record_id)).mode into v_mode;
  if v_mode is distinct from 'block' then return new; end if;
  v_issue := ogevia.hour_limit_issue_range(new.organization_id, new.caregiver_record_id, new.starts_at, new.ends_at, new.id);
  if v_issue is not null then
    raise exception '%', ogevia.readiness_message('hours', v_issue || '_hour_limit') using errcode = 'OGR30', detail = 'hours:' || v_issue || '_hour_limit';
  end if;
  return new;
end;
$$;

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
  g record;
  v_bg text;
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

  if p_context <> 'visit_start' and v_rec.id is not null and v_rec.onboarding_required then
    declare v_open text[];
    begin
      v_open := ogevia.onboarding_outstanding(p_organization_id, v_rec.id, false);
      if cardinality(v_open) > 0 then
        return query select 'onboarding'::text, 'blocked'::text, 'onboarding_incomplete'::text,
          ('Onboarding incomplete: ' || array_to_string(v_open, ', ') || '.')::text, true;
      else
        return query select 'onboarding'::text, 'ok'::text, null::text, null::text, true;
      end if;
    end;
  end if;

  -- Background-check clearance (0055): only a VERIFIED APPROVED result qualifies. "Completed" alone never does.
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg = 'approved' then
    return query select 'background'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'background', p_context);
  else
    return query select 'background'::text, 'blocked'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg),
                        ogevia.readiness_enforced(p_organization_id, 'background', p_context);
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

  -- CPR / TB (0055): inside the 14-day period from the hire date, a record that is MISSING or only uploaded (awaiting review) is PENDING,
  -- not blocking. Everything else keeps its existing behaviour: rejected, expired, expiring before the work ends, expiry date missing,
  -- and an agency whose CPR/TB type or rule is not set up still block at once. The period is judged at the moment of the check.
  select * into g from ogevia.compliance_grace(p_organization_id, p_caregiver_record_id);
  for d in select * from ogevia.document_readiness(p_organization_id, p_caregiver_record_id, p_starts, p_ends) loop
    if g.in_grace and d.status in ('missing', 'awaiting_review') then
      return query select d.requirement, 'pending'::text, d.status,
                          ogevia.readiness_message(d.requirement, d.status) || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.',
                          ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
      continue;
    end if;
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
        v_issue := ogevia.hour_limit_issue_range(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_exclude_shift);
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
    when p_check = 'background' then
      case p_code
        when 'background_not_approved' then 'Background check result is not approved.'
        when 'background_completed_not_approved' then 'Background check is completed but clearance is not verified as approved.'
        when 'background_not_recorded' then 'Background check clearance has not been verified.'
        else 'Background check clearance has not been verified as approved.' end
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

create or replace function ogevia.hour_limit_issue_range(
  p_organization_id uuid, p_caregiver_record_id uuid, p_starts timestamptz, p_ends timestamptz, p_exclude_shift uuid default null,
  p_extra tstzrange[] default '{}', p_exclude_series uuid default null, p_exclude_from date default null
)
returns text
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  l ogevia.caregiver_hour_limits%rowtype;
  v_tz text;
  d date;
  w date;
  v_lo timestamptz;
  v_hi timestamptz;
  v_total bigint;
begin
  l := ogevia.effective_hour_limit(p_organization_id, p_caregiver_record_id);
  if l.id is null then return null; end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  if l.max_daily_minutes is not null then
    for d in select g::date from generate_series((p_starts at time zone v_tz)::date, ((p_ends - interval '1 microsecond') at time zone v_tz)::date, interval '1 day') g loop
      v_lo := d::timestamp at time zone v_tz; v_hi := (d + 1)::timestamp at time zone v_tz;
      v_total := ogevia.overlap_minutes(p_starts, p_ends, v_lo, v_hi)
        + coalesce((select sum(ogevia.overlap_minutes(lower(x), upper(x), v_lo, v_hi)) from unnest(p_extra) x), 0)
        + coalesce((select sum(ogevia.overlap_minutes(s.starts_at, s.ends_at, v_lo, v_hi)) from ogevia.shifts s
                    where s.organization_id = p_organization_id and s.caregiver_record_id = p_caregiver_record_id
                      and s.status in ('scheduled', 'completed') and s.id is distinct from p_exclude_shift and not ogevia.shift_is_called_out(s.id)
                      and s.starts_at < v_hi and s.ends_at > v_lo
                      and not (p_exclude_series is not null and s.series_id = p_exclude_series and s.status = 'scheduled'
                               and (s.starts_at at time zone v_tz)::date >= p_exclude_from)), 0);
      if v_total > l.max_daily_minutes then return 'daily'; end if;
    end loop;
  end if;
  if l.max_weekly_minutes is not null then
    for w in select g::date from generate_series(date_trunc('week', (p_starts at time zone v_tz)::timestamp)::date,
                                                 date_trunc('week', ((p_ends - interval '1 microsecond') at time zone v_tz)::timestamp)::date, interval '7 days') g loop
      v_lo := w::timestamp at time zone v_tz; v_hi := (w + 7)::timestamp at time zone v_tz;
      v_total := ogevia.overlap_minutes(p_starts, p_ends, v_lo, v_hi)
        + coalesce((select sum(ogevia.overlap_minutes(lower(x), upper(x), v_lo, v_hi)) from unnest(p_extra) x), 0)
        + coalesce((select sum(ogevia.overlap_minutes(s.starts_at, s.ends_at, v_lo, v_hi)) from ogevia.shifts s
                    where s.organization_id = p_organization_id and s.caregiver_record_id = p_caregiver_record_id
                      and s.status in ('scheduled', 'completed') and s.id is distinct from p_exclude_shift and not ogevia.shift_is_called_out(s.id)
                      and s.starts_at < v_hi and s.ends_at > v_lo
                      and not (p_exclude_series is not null and s.series_id = p_exclude_series and s.status = 'scheduled'
                               and (s.starts_at at time zone v_tz)::date >= p_exclude_from)), 0);
      if v_total > l.max_weekly_minutes then return 'weekly'; end if;
    end loop;
  end if;
  return null;
end;
$$;

drop function ogevia.hour_limit_message(text, bigint, integer);
drop function ogevia.hour_limit_detail(uuid, uuid, timestamptz, timestamptz, uuid, tstzrange[], uuid, date);
