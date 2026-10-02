begin;

-- Client operations: separate the month's hours by source instead of one
-- "delivered" number and a straight-line forecast.
--
-- New trailing columns of list_client_operations (minutes, per client +
-- service, agency-local month):
--   requested_minutes           requested windows (service-specific or all
--                               services) x matching weekdays in the month;
--                               overnight windows count on their start day
--   scheduled_minutes           scheduled + completed shifts, clamped to the month
--   upcoming_scheduled_minutes  still-scheduled shift time from now to month end
--   worked_minutes              = delivered_minutes (signed + administrator review)
--   confirmed_minutes           verified minutes on signed visits
--   billable_minutes            billable minutes on signed visits
--   remaining_minutes           authorized - worked - upcoming scheduled (can go
--                               negative: the plan exceeds the authorization);
--                               null without an authorization
--   projected_minutes           worked + upcoming scheduled (the plan, not an
--                               extrapolation of past days)
-- Existing columns keep their names, order and meaning. Permission
-- (clients.read), search_path and grants are unchanged; billable/confirmed
-- are minutes, not money (rates stay behind billing.read elsewhere).
-- Return type changes, so the function is dropped and recreated.

drop function if exists public.list_client_operations(uuid, date);

create function public.list_client_operations(
  target_organization_id uuid,
  target_month_start date default date_trunc('month', current_date)::date
)
returns table (
  client_id uuid,
  client_name text,
  client_code text,
  caregiver_display_code text,
  client_status public.client_status,
  location text,
  service_id uuid,
  service_name text,
  max_monthly_hours numeric,
  authorization_period_end date,
  delivered_minutes bigint,
  assigned_caregivers text[],
  requested_windows jsonb,
  top_match_name text,
  top_match_score integer,
  gap_reason text,
  gap_notes text,
  gap_resolved boolean,
  -- Month breakdown (minutes), each from its own source; see header.
  requested_minutes bigint,
  scheduled_minutes bigint,
  upcoming_scheduled_minutes bigint,
  worked_minutes bigint,
  confirmed_minutes bigint,
  billable_minutes bigint,
  remaining_minutes bigint,
  projected_minutes bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org_tz text;
  month_end date := (target_month_start + interval '1 month')::date;
  month_start_ts timestamptz;
  month_end_ts timestamptz;
begin
  if not public.has_permission(target_organization_id, 'clients.read') then
    raise exception 'You do not have permission to view client operations';
  end if;

  select coalesce(o.timezone, 'America/Los_Angeles') into org_tz
  from public.organizations o where o.id = target_organization_id;
  org_tz := coalesce(org_tz, 'America/Los_Angeles');
  -- The month as the agency's wall-clock month.
  month_start_ts := target_month_start::timestamp at time zone org_tz;
  month_end_ts := month_end::timestamp at time zone org_tz;

  return query
  with service_scope as (
    select a.client_id, a.service_id
    from public.client_authorizations a
    where a.organization_id = target_organization_id
      and a.deleted_at is null
      and a.is_current = true
      and a.period_start < (target_month_start + interval '1 month')::date
      and a.period_end >= target_month_start
    union
    select rs.client_id, rs.service_id
    from public.client_requested_services rs
    where rs.organization_id = target_organization_id
  ),
  active_auth as (
    select distinct on (a.client_id, a.service_id)
      a.client_id, a.service_id, a.max_monthly_hours, a.period_end
    from public.client_authorizations a
    where a.organization_id = target_organization_id
      and a.deleted_at is null
      and a.is_current = true
      and a.period_start < (target_month_start + interval '1 month')::date
      and a.period_end >= target_month_start
    order by a.client_id, a.service_id, a.period_end desc, a.version_number desc
  ),
  delivered as (
    -- worked: signed + in administrator review (as before); corrected
    -- originals, drafts and voided visits are excluded.
    -- confirmed / billable: signed visits only.
    select v.client_id, v.service_id,
      coalesce(sum(v.worked_minutes), 0)::bigint as minutes,
      coalesce(sum(v.verified_minutes) filter (where v.status = 'signed'), 0)::bigint as confirmed,
      coalesce(sum(v.billable_minutes) filter (where v.status = 'signed'), 0)::bigint as billable
    from public.service_visits v
    where v.organization_id = target_organization_id
      and v.service_date >= target_month_start
      and v.service_date < month_end
      and v.status in ('signed', 'administrator_review')
    group by v.client_id, v.service_id
  ),
  shift_time as (
    -- Shift minutes inside the agency-local month. upcoming = still-scheduled
    -- time from now to month end (the part of the plan not yet delivered).
    select s.client_id, s.service_id,
      coalesce(sum(extract(epoch from (least(s.ends_at, month_end_ts) - greatest(s.starts_at, month_start_ts))) / 60), 0)::bigint as scheduled,
      coalesce(sum(extract(epoch from (least(s.ends_at, month_end_ts) - greatest(s.starts_at, month_start_ts, now()))) / 60)
        filter (where s.status = 'scheduled' and s.ends_at > now() and now() < month_end_ts), 0)::bigint as upcoming
    from public.shifts s
    where s.organization_id = target_organization_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < month_end_ts
      and s.ends_at > month_start_ts
    group by s.client_id, s.service_id
  ),
  month_days as (
    select d::date as day, (array['monday','tuesday','wednesday','thursday','friday','saturday','sunday'])[extract(isodow from d)::int]::public.weekday as weekday
    from generate_series(target_month_start::timestamp, (month_end - 1)::timestamp, interval '1 day') d
  )
  select
    c.id,
    concat_ws(' ', c.first_name, c.last_name),
    c.client_code,
    c.caregiver_display_code,
    c.status,
    nullif(concat_ws(', ', nullif(c.address_city, ''), nullif(c.address_state, '')), ''),
    ss.service_id,
    s.name,
    aa.max_monthly_hours,
    aa.period_end,
    coalesce(d.minutes, 0),
    coalesce(assignments.names, array[]::text[]),
    coalesce(windows.items, '[]'::jsonb),
    top_match.caregiver_name,
    top_match.match_score,
    gr.reason,
    gr.notes,
    coalesce(gr.resolved, false),
    coalesce(req.minutes, 0)::bigint,
    coalesce(st.scheduled, 0)::bigint,
    coalesce(st.upcoming, 0)::bigint,
    coalesce(d.minutes, 0)::bigint,
    coalesce(d.confirmed, 0)::bigint,
    coalesce(d.billable, 0)::bigint,
    case when aa.max_monthly_hours is null then null
      else round(aa.max_monthly_hours * 60)::bigint - coalesce(d.minutes, 0) - coalesce(st.upcoming, 0) end,
    case when ss.service_id is null then null
      else coalesce(d.minutes, 0) + coalesce(st.upcoming, 0) end
  from public.clients c
  left join service_scope ss on ss.client_id = c.id
  left join public.services s on s.id = ss.service_id
  left join active_auth aa
    on aa.client_id = c.id and aa.service_id = ss.service_id
  left join delivered d
    on d.client_id = c.id and d.service_id = ss.service_id
  left join shift_time st
    on st.client_id = c.id and st.service_id = ss.service_id
  left join lateral (
    -- Requested windows for this service (or for all services) times the
    -- number of matching weekdays in the month; an overnight window counts
    -- in full on the day it starts.
    select sum(upper(public.weekly_window(r.day_of_week, r.start_time, r.end_time))
               - lower(public.weekly_window(r.day_of_week, r.start_time, r.end_time))) as minutes
    from public.client_requested_schedule r
    join month_days md on md.weekday = r.day_of_week
    where r.organization_id = target_organization_id
      and r.client_id = c.id
      and ss.service_id is not null
      and (r.service_id is null or r.service_id = ss.service_id)
  ) req on true
  left join lateral (
    select array_agg(distinct coalesce(p.display_name, 'Caregiver') order by coalesce(p.display_name, 'Caregiver')) as names
    from public.caregiver_assignments ca
    left join public.user_profiles p on p.id = ca.caregiver_user_id
    where ca.organization_id = target_organization_id
      and ca.client_id = c.id
      and ca.service_id = ss.service_id
      and ca.is_active = true
      and ca.effective_start <= (target_month_start + interval '1 month - 1 day')::date
      and (ca.effective_end is null or ca.effective_end >= target_month_start)
  ) assignments on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'day', r.day_of_week,
      'start', r.start_time,
      'end', r.end_time,
      'notes', r.notes
    ) order by r.day_of_week, r.start_time) as items
    from public.client_requested_schedule r
    where r.organization_id = target_organization_id
      and r.client_id = c.id
      and (r.service_id is null or r.service_id = ss.service_id)
  ) windows on true
  left join lateral (
    select m.caregiver_name, m.match_score
    from public.list_caregiver_matches(target_organization_id, c.id) m
    where public.has_permission(target_organization_id, 'shifts.update')
    order by m.match_score desc, m.caregiver_name
    limit 1
  ) top_match on true
  left join public.client_service_gap_reviews gr
    on gr.organization_id = target_organization_id
    and gr.client_id = c.id
    and gr.service_id = ss.service_id
    and gr.month_start = target_month_start
  where c.organization_id = target_organization_id
    and c.deleted_at is null
  order by c.last_name, c.first_name, s.name;
end;
$$;

revoke all on function public.list_client_operations(uuid, date)
  from public, anon;
grant execute on function public.list_client_operations(uuid, date)
  to authenticated;

commit;
