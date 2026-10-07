-- 0037 Overnight caregiver availability.
--
-- Before this migration (verified in the repository, 2026-10-06): an availability
-- window had to satisfy start_local < end_local (constraint availability_time,
-- 0011), so 22:00 to 06:00 could not be saved, and list_available_caregivers
-- compared a care request's start and end time of day with ONE day's window, so
-- an overnight care request (for example 22:00 to 06:00) matched nobody, or
-- matched only a caregiver whose single window covered the whole day without
-- looking at the hours after midnight.
--
-- After:
--   * A window whose end is earlier than its start runs past midnight into the
--     NEXT day: weekday 6 (Saturday) 22:00 to 06:00 covers Saturday 22:00 to
--     Sunday 06:00; a date-specific window does the same from that date. This is
--     the rule shifts already use (an end at or before the start is the next
--     day, 0035). A window may not start and end at the same time.
--   * Matching works on real instants. Every window that could touch the request
--     is turned into a start and end instant in the agency's own time zone
--     (daylight saving is honored because the request's start and end are
--     instants), overlapping or touching windows are merged, and the caregiver
--     matches only if the merged availability covers the whole request.
--     Windows on different days that together cover a request therefore count.
--   * A date marked unavailable blocks every local date the request touches (for a
--     daytime request that is the one date, exactly as before).
--   * Everything else in matching is unchanged: caregiver status, shift conflicts,
--     declined offers, current-client first, source label, permission.
--
-- Daytime and weekend availability behave as before: a request inside one
-- day's window still matches, and weekends are weekday 0 and 6 as before. The
-- only requests that match differently are ones that touch two days or sit in
-- adjacent or overlapping windows (which now match when the union covers them).

alter table ogevia.caregiver_availability_windows drop constraint availability_time;
alter table ogevia.caregiver_availability_windows
  add constraint availability_time check (start_local <> end_local);

comment on constraint availability_time on ogevia.caregiver_availability_windows is
  'end_local earlier than start_local means the window ends the next day (overnight); equal times are refused';

-- True when the caregiver's availability windows (recurring by weekday, or for
-- one date) together cover the whole of [p_starts, p_ends) in the agency time zone.
-- p_first_date .. p_last_date are the agency-local dates the request touches; the
-- day before p_first_date is also read, because an overnight window that began
-- the evening before can still be running when the request starts.
create function ogevia.availability_covers(
  p_organization_id uuid, p_caregiver_record_id uuid, p_timezone text,
  p_starts timestamptz, p_ends timestamptz, p_first_date date, p_last_date date
)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(
    (
      select range_agg(tstzrange(inst.s, inst.e, '[)'))
      from (
        select (d.day + w.start_local) at time zone p_timezone as s,
               (d.day + case when w.end_local < w.start_local then 1 else 0 end + w.end_local) at time zone p_timezone as e
        from (select g::date as day from generate_series((p_first_date - 1)::timestamp, p_last_date::timestamp, interval '1 day') g) d
        join ogevia.caregiver_availability_windows w
          on w.organization_id = p_organization_id
         and w.caregiver_record_id = p_caregiver_record_id
         and (w.specific_date = d.day or (w.specific_date is null and w.weekday = extract(dow from d.day)))
      ) inst
    ) @> tstzrange(p_starts, p_ends, '[)'),
    false);
$$;

revoke all on function ogevia.availability_covers(uuid, uuid, text, timestamptz, timestamptz, date, date) from public;

create or replace function ogevia_api.list_available_caregivers(p_organization_id uuid, p_request_id uuid)
returns table(caregiver_record_id uuid, caregiver_name text, current_client_match boolean, availability_source text)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  with req as(
    select r.*, o.timezone,
      (r.starts_at at time zone o.timezone)::date local_date,
      ((r.ends_at - interval '1 microsecond') at time zone o.timezone)::date local_end_date
    from ogevia.care_requests r join ogevia.organizations o on o.id=r.organization_id
    where r.id=p_request_id and r.organization_id=p_organization_id
  ), candidates as(
    select cr.id caregiver_record_id,cr.linked_user_id,cr.first_name,cr.last_name,cr.preferred_name,
      q.client_id,q.service_id,q.local_date
    from req q join ogevia.caregiver_records cr on cr.organization_id=q.organization_id and cr.status in('ready','active') and cr.deleted_at is null
    where not exists(select 1 from ogevia.caregiver_unavailable_dates u where u.organization_id=q.organization_id and u.caregiver_record_id=cr.id and u.unavailable_date between q.local_date and q.local_end_date)
      and ogevia.availability_covers(q.organization_id, cr.id, q.timezone, q.starts_at, q.ends_at, q.local_date, q.local_end_date)
      and not exists(select 1 from ogevia.shifts sh where sh.organization_id=q.organization_id and sh.caregiver_record_id=cr.id and sh.id is distinct from q.assigned_shift_id and sh.status in('scheduled','completed') and sh.starts_at<q.ends_at and sh.ends_at>q.starts_at)
      and not exists(select 1 from ogevia.care_request_offers oo where oo.care_request_id=q.id and oo.caregiver_record_id=cr.id and oo.status in('not_available','cancelled'))
  )
  select c.caregiver_record_id,coalesce(c.preferred_name,c.first_name)||' '||c.last_name,
    exists(select 1 from ogevia.caregiver_assignments a where a.organization_id=p_organization_id and a.caregiver_user_id=c.linked_user_id and a.client_id=c.client_id and a.service_id=c.service_id and a.is_active),
    case when exists(select 1 from ogevia.caregiver_availability_windows w where w.caregiver_record_id=c.caregiver_record_id and w.specific_date=c.local_date) then 'date-specific' else 'recurring' end
  from candidates c where ogevia.has_permission(p_organization_id,'care_requests.manage')
  order by 3 desc,2;
$$;
