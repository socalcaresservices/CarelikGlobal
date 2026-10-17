-- 0060 Work-hour limits that the agency fixes and nobody overrides (owner directive 2026-10-17, requirement 6).
--
-- POLICY. SoCal Care Services' approved limits are 8 hours a day and 40 hours a week. They are data in an APPEND-ONLY, versioned table keyed by the
-- agency's slug (agency_work_hour_policies), not a setting a manager can edit: there is no API, role or screen that writes it. A change is a new
-- version added by a reviewed migration. The policy is scoped by slug 'socal-care-services' (the production tenant, db/deploy/12_prd_bootstrap_tenant.sql);
-- another agency has no row and keeps the optional manager-set limits exactly as before. The synthetic pilot tenant (slug scs-pilot-synthetic) is
-- deliberately NOT given the policy here: that is an owner decision (README section 15).
--
-- HOW IT IS ENFORCED (no new gate: the existing one gets the stricter limit).
--   * effective_hour_limit() now returns the STRICTER of the caregiver's / agency-default row and the policy, always in 'block' mode. A manager who
--     sets a looser limit, switches it to 'report', or deletes it changes nothing for this agency. A per-caregiver row with only a daily value no longer
--     drops the weekly limit.
--   * That limit already feeds readiness_checks ('hours'), assert_ready_for_work / check_shift_caregiver (create, reschedule, reassign, call-out replacement,
--     open-shift pickup, care-request assignment, make-up) and series_evaluate (a series skips or refuses dates as over_hour_limit). No path has an override
--     parameter for hours, and none is added.
--   * NEW database backstop: a BEFORE INSERT/UPDATE trigger on shifts takes the caregiver lock and re-checks, so a writer that skips the API functions
--     (a future function, a script run with a privileged role) is refused with OGR30 and two concurrent requests for one caregiver cannot both pass.
--
-- HOW HOURS ARE COUNTED (fixes three gaps found in the audit).
--   * A shift is split at agency-local midnight and at the Monday 00:00 week boundary: an 22:00-06:00 shift counts 2 h on its first day and 6 h on the next.
--     (0053 attributed the whole shift to its start date.)
--   * Earlier dates of a series being evaluated are counted exactly (as ranges), not as start-date tallies.
--   * A reschedule no longer counts the shift's own old time against its new time (assert_ready_for_work gets the excluded shift).
--   Still NOT counted: unscheduled visits (no shift) and time worked beyond the scheduled end. A visit already started is never stopped by this rule.
-- Rollback restores the 0053/0055/0047/0042 definitions and removes the new objects (the policy table, with its rows, is dropped).

create function ogevia.overlap_minutes(p_a_lo timestamptz, p_a_hi timestamptz, p_b_lo timestamptz, p_b_hi timestamptz)
returns bigint
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select greatest(0, floor(extract(epoch from (least(p_a_hi, p_b_hi) - greatest(p_a_lo, p_b_lo))) / 60))::bigint;
$$;
revoke all on function ogevia.overlap_minutes(timestamptz, timestamptz, timestamptz, timestamptz) from public;

create table ogevia.agency_work_hour_policies (
  organization_slug text not null check (organization_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  version integer not null check (version >= 1),
  max_daily_minutes integer not null check (max_daily_minutes between 60 and 1440),
  max_weekly_minutes integer not null check (max_weekly_minutes between 60 and 10080),
  effective_from timestamptz not null default now(),
  basis text not null check (length(btrim(basis)) between 10 and 1000),
  recorded_at timestamptz not null default now(),
  primary key (organization_slug, version),
  constraint agency_work_hour_policies_week_ge_day check (max_weekly_minutes >= max_daily_minutes)
);
create trigger agency_work_hour_policies_no_update before update on ogevia.agency_work_hour_policies for each row execute function ogevia.forbid_update();
create trigger agency_work_hour_policies_no_delete before delete on ogevia.agency_work_hour_policies for each row execute function ogevia.forbid_delete();
alter table ogevia.agency_work_hour_policies enable row level security;
create policy readonly_select on ogevia.agency_work_hour_policies for select to ogevia_readonly using (true);
grant select on ogevia.agency_work_hour_policies to ogevia_readonly;

insert into ogevia.agency_work_hour_policies (organization_slug, version, max_daily_minutes, max_weekly_minutes, effective_from, basis)
values ('socal-care-services', 1, 480, 2400, now(),
        'Owner-approved SoCal Care Services limits: 8 hours a day and 40 hours a week, no manager override (owner directive 2026-10-17, requirement 6).');

-- The policy in force for an agency, or no row. Matching is by slug, so it follows the agency whatever its generated id is.
create function ogevia.work_hour_policy(p_organization_id uuid)
returns table (max_daily_minutes integer, max_weekly_minutes integer, version integer, basis text)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select p.max_daily_minutes, p.max_weekly_minutes, p.version, p.basis
  from ogevia.agency_work_hour_policies p
  join ogevia.organizations o on o.slug = p.organization_slug
  where o.id = p_organization_id and p.effective_from <= now()
  order by p.version desc
  limit 1;
$$;
revoke all on function ogevia.work_hour_policy(uuid) from public;

create or replace function ogevia.effective_hour_limit(p_organization_id uuid, p_caregiver_record_id uuid)
returns ogevia.caregiver_hour_limits
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  r ogevia.caregiver_hour_limits%rowtype;
  pol record;
begin
  select l.* into r from ogevia.caregiver_hour_limits l
  where l.organization_id = p_organization_id and (l.caregiver_record_id = p_caregiver_record_id or l.caregiver_record_id is null)
  order by (l.caregiver_record_id is null)
  limit 1;
  select * into pol from ogevia.work_hour_policy(p_organization_id);
  if pol.version is null then return r; end if;
  -- the agency's fixed policy: the stricter of it and any manager-set limit, always blocking
  r.id := coalesce(r.id, '00000000-0000-4000-8000-000000000060'::uuid);
  r.organization_id := p_organization_id;
  r.max_daily_minutes := least(coalesce(r.max_daily_minutes, pol.max_daily_minutes), pol.max_daily_minutes);
  r.max_weekly_minutes := least(coalesce(r.max_weekly_minutes, pol.max_weekly_minutes), pol.max_weekly_minutes);
  r.mode := 'block';
  return r;
end;
$$;

-- Scheduled and completed minutes of one caregiver on an agency-local date and in that date's Monday-Sunday week, split at midnight, not counting
-- cancelled shifts, called-out shifts or p_exclude_shift.
create or replace function ogevia.caregiver_hour_load(p_organization_id uuid, p_caregiver_record_id uuid, p_local_date date, p_exclude_shift uuid default null)
returns table (day_minutes bigint, week_minutes bigint)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with tz as (select o.timezone as z from ogevia.organizations o where o.id = p_organization_id),
  b as (
    select (p_local_date::timestamp at time zone tz.z) as d_lo,
           ((p_local_date + 1)::timestamp at time zone tz.z) as d_hi,
           (date_trunc('week', p_local_date::timestamp) at time zone tz.z) as w_lo,
           ((date_trunc('week', p_local_date::timestamp) + interval '7 days') at time zone tz.z) as w_hi
    from tz
  )
  select coalesce(sum(ogevia.overlap_minutes(s.starts_at, s.ends_at, b.d_lo, b.d_hi)), 0)::bigint,
         coalesce(sum(ogevia.overlap_minutes(s.starts_at, s.ends_at, b.w_lo, b.w_hi)), 0)::bigint
  from ogevia.shifts s, b
  where s.organization_id = p_organization_id and s.caregiver_record_id = p_caregiver_record_id
    and s.status in ('scheduled', 'completed') and s.id is distinct from p_exclude_shift
    and not ogevia.shift_is_called_out(s.id)
    and s.starts_at < b.w_hi and s.ends_at > b.w_lo;
$$;

-- null when [p_starts, p_ends) fits every local day and week it touches; otherwise 'daily' or 'weekly'. p_extra are ranges not yet stored (the earlier
-- dates of a series being evaluated). p_exclude_series/p_exclude_from leave out the future shifts of a series that is being replaced.
create function ogevia.hour_limit_issue_range(
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
revoke all on function ogevia.hour_limit_issue_range(uuid, uuid, timestamptz, timestamptz, uuid, tstzrange[], uuid, date) from public;

-- The gate now forwards the shift being moved, so a reschedule does not count its own old time.
drop function ogevia.assert_ready_for_work(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid);
create function ogevia.assert_ready_for_work(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz,
  p_context text default 'shift', p_client_id uuid default null, p_exclude_shift uuid default null
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
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, p_context, p_exclude_shift, p_client_id, false) c
  where c.status = 'blocked' and c.enforced;
  if v_msgs is not null then
    raise exception '%', v_msgs using errcode = 'OGR30', detail = v_codes;
  end if;
  -- An availability override is for ONE shift: using it records the use, marks it consumed (it cannot be used again),
  -- and writes the audit event with the client and the match result it was approved against.
  if exists (select 1 from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, p_context, p_exclude_shift, p_client_id, false) c
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
revoke all on function ogevia.assert_ready_for_work(uuid, uuid, uuid, timestamptz, timestamptz, text, uuid, uuid) from public;

-- readiness_checks (0055 definition): the 'hours' check now measures the real range, split at midnight and week boundaries.
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

-- series_evaluate (0053 definition): earlier dates are counted exactly; the replaced series' future shifts are left out of the load.
create or replace function ogevia.series_evaluate(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_from date, p_through date, p_exclude_series uuid DEFAULT NULL::uuid, p_exclude_from date DEFAULT NULL::date, p_pattern jsonb DEFAULT NULL::jsonb)
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
  v_extra tstzrange[] := '{}';
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
        v_issue := ogevia.hour_limit_issue_range(p_organization_id, v_rec.id, o.starts_at, o.ends_at, null, v_extra, p_exclude_series, p_exclude_from);
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
        v_extra := v_extra || tstzrange(o.starts_at, o.ends_at);
      end if;
    end if;
    return query select o.local_date, o.starts_at, o.ends_at, o.minutes,
      date_trunc('month', o.local_date)::date, v_auth.lineage_id, v_auth.monthly_authorized_minutes,
      v_used, v_reserved, v_series, v_outcome;
  end loop;
end;
$$;

-- check_shift_caregiver (0042 definition): forwards the excluded shift.
create or replace function ogevia.check_shift_caregiver(
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
    case when p_exclude_shift is null then 'shift' else 'reschedule' end, null, p_exclude_shift);
  return v_rec;
end;
$$;

-- BACKSTOP: whatever writes a scheduled shift for a caregiver, the limit is checked under the caregiver lock. Only when the caregiver, the times or the
-- status change into 'scheduled', so an unrelated update of an old over-limit shift is not blocked.
create function ogevia.shifts_work_hours_guard()
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
revoke all on function ogevia.shifts_work_hours_guard() from public;
create trigger shifts_work_hours before insert or update on ogevia.shifts
for each row execute function ogevia.shifts_work_hours_guard();

-- Read-only: what limit applies to this agency, for the screen. Any active member may read it; nothing here can change it.
create function ogevia_api.get_work_hour_policy(p_organization_id uuid)
returns table (applies boolean, max_daily_minutes integer, max_weekly_minutes integer, version integer, basis text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select p.version is not null, p.max_daily_minutes, p.max_weekly_minutes, p.version, p.basis
  from (select ogevia.require_actor() as a) x
  left join lateral ogevia.work_hour_policy(p_organization_id) p on true
  where ogevia.is_active_member(p_organization_id);
$$;
revoke all on function ogevia_api.get_work_hour_policy(uuid) from public;
grant execute on function ogevia_api.get_work_hour_policy(uuid) to ogevia_app;
