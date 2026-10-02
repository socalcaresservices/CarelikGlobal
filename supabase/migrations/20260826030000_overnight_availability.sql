begin;

-- Overnight availability and requested shifts.
--
-- caregiver_record_availability and client_requested_schedule required
-- end_time > start_time, so a night window (e.g. 22:00-06:00) could not be
-- entered, and every time comparison assumed a window stays inside one day.
--
-- New rule: a window whose end_time is earlier than (or equal to midnight
-- relative to) its start_time ENDS THE NEXT DAY. It is stored as one row on
-- the day it starts, so "at most two windows per day" still means two
-- windows that START that day. end_time = start_time stays invalid.
--
-- Comparisons use a weekly minute timeline (Monday 00:00 = 0, length 10080):
--   public.weekly_window(day, start, end)  -> int4range [start, end)
--   public.weekly_windows_overlap(a, b)    -> overlap, including the
--                                             Sunday-night -> Monday wrap.
-- Applied to: CareScore's requested-window match, and the shift ->
-- requested-schedule link trigger. The trigger now also reads the shift's
-- day and time in the ORGANIZATION's timezone (organizations.timezone);
-- previously it used starts_at::time / isodow in the session timezone.
--
-- Existing rows are unaffected: every stored window already ends after it
-- starts, which is the same-day case under the new rule.

create or replace function public.weekly_window(day public.weekday, start_time time, end_time time)
returns int4range
language sql
immutable
set search_path = public
as $$
  select int4range(
    s,
    s + case
          when end_time > start_time then (extract(epoch from end_time - start_time) / 60)::int
          else 1440 - (extract(epoch from start_time - end_time) / 60)::int
        end
  )
  from (
    select (array_position(enum_range(null::public.weekday), day) - 1) * 1440
           + (extract(epoch from start_time) / 60)::int as s
  ) x
$$;

create or replace function public.weekly_windows_overlap(a int4range, b int4range)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- Windows live on [0, 10080 + 1440): shift one by a week to catch a
  -- Sunday-night window that runs into Monday.
  select a && b
      or a && int4range(lower(b) + 10080, upper(b) + 10080)
      or int4range(lower(a) + 10080, upper(a) + 10080) && b
$$;

alter table public.caregiver_record_availability
  drop constraint if exists caregiver_record_availability_order;
alter table public.caregiver_record_availability
  add constraint caregiver_record_availability_order check (end_time <> start_time);

alter table public.client_requested_schedule
  drop constraint if exists client_requested_schedule_time_order;
alter table public.client_requested_schedule
  add constraint client_requested_schedule_time_order check (end_time <> start_time);

create or replace function public.replace_caregiver_record_availability(
  target_organization_id uuid,
  target_caregiver_record_id uuid,
  availability_slots jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to update Care Team availability';
  end if;
  if not exists (
    select 1 from public.caregiver_records
    where id = target_caregiver_record_id and organization_id = target_organization_id and deleted_at is null
  ) then
    raise exception 'Care Team record not found';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference)
    group by day_of_week having count(*) > 2
  ) then
    raise exception 'Availability supports at most two time windows per day';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference)
    where start_time is null or end_time is null or end_time = start_time
  ) then
    raise exception 'Every availability window must have a start and end time, and they cannot be equal';
  end if;

  delete from public.caregiver_record_availability
  where organization_id = target_organization_id and caregiver_record_id = target_caregiver_record_id;

  insert into public.caregiver_record_availability
    (organization_id, caregiver_record_id, day_of_week, start_time, end_time, preference)
  select target_organization_id, target_caregiver_record_id, day_of_week, start_time, end_time,
    coalesce(preference, 'available'::public.availability_preference)
  from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
    as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference);
end;
$$;

create or replace function public.replace_client_requested_schedule(
  target_organization_id uuid,
  target_client_id uuid,
  requested_slots jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_permission(target_organization_id, 'clients.update') then
    raise exception 'You do not have permission to update this client';
  end if;

  if not exists (
    select 1 from public.clients
    where id = target_client_id
      and organization_id = target_organization_id
      and deleted_at is null
  ) then
    raise exception 'Client not found';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time,
           service_id uuid, notes text)
    group by day_of_week having count(*) > 2
  ) then
    raise exception 'A client may request at most two shifts per day';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time,
           service_id uuid, notes text)
    where start_time is null or end_time is null or end_time = start_time
  ) then
    raise exception 'Every requested shift must have a start and end time, and they cannot be equal';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time,
           service_id uuid, notes text)
    where service_id is not null and not exists (
      select 1 from public.services s
      where s.id = x.service_id
        and s.organization_id = target_organization_id
        and s.deleted_at is null
    )
  ) then
    raise exception 'A requested shift contains an invalid service';
  end if;

  delete from public.client_requested_schedule
  where organization_id = target_organization_id
    and client_id = target_client_id;

  insert into public.client_requested_schedule
    (organization_id, client_id, day_of_week, start_time, end_time,
     service_id, notes, created_by)
  select target_organization_id, target_client_id, day_of_week, start_time,
    end_time, service_id, nullif(trim(notes), ''), (select auth.uid())
  from jsonb_to_recordset(coalesce(requested_slots, '[]'::jsonb))
    as x(day_of_week public.weekday, start_time time, end_time time,
         service_id uuid, notes text);
end;
$$;

create or replace function public._score_caregiver_matches(target_organization_id uuid, target_client_id uuid)
returns table (
  caregiver_record_id uuid,
  caregiver_name text,
  match_score integer,
  proximity_score integer,
  language_score integer,
  availability_score integer,
  skills_score integer,
  history_score integer,
  missing_data text[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  client_zip text;
  client_city text;
  client_state text;
  client_language_needs text[];
  client_care_needs text[];
  week_start timestamptz := date_trunc('week', now());
  week_end timestamptz := date_trunc('week', now()) + interval '7 days';
begin
  select c.address_zip, c.address_city, c.address_state, c.language_needs, c.care_needs
  into client_zip, client_city, client_state, client_language_needs, client_care_needs
  from public.clients c
  where c.id = target_client_id and c.organization_id = target_organization_id;

  if not found then
    raise exception 'Client not found in this organization';
  end if;

  return query
  with client_requested as (
    select crs.id, crs.day_of_week, crs.start_time, crs.end_time
    from public.client_requested_schedule crs
    where crs.client_id = target_client_id and crs.organization_id = target_organization_id
  ),
  caregiver_base as (
    select
      cr.id as caregiver_record_id,
      coalesce(nullif(trim(cr.preferred_name), ''), cr.first_name || ' ' || cr.last_name) as display_name,
      cr.address_zip,
      cr.address_city,
      cr.address_state,
      cr.languages,
      -- Skills now live on the workforce record (any caregiver, login or not);
      -- a linked login's profile skills still count, so nothing recorded is lost.
      (select coalesce(array_agg(distinct sk order by sk), '{}')
         from unnest(cr.skills || coalesce(up.skills, '{}')) sk
        where btrim(sk) <> '') as skills,
      cr.desired_weekly_hours as target_hours_per_week,
      coalesce(
        (
          select sum(extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0)
          from public.shifts s
          where s.caregiver_record_id = cr.id
            and s.organization_id = target_organization_id
            and s.status in ('scheduled', 'completed')
            and s.starts_at < week_end
            and s.ends_at > week_start
        ),
        0
      ) as scheduled_hours_this_week,
      (
        select count(*)::int
        from public.shifts s
        where s.caregiver_record_id = cr.id
          and s.client_id = target_client_id
          and s.status = 'completed'
      ) as completed_together,
      (
        cr.linked_user_id is not null and exists (
          select 1
          from public.incidents i
          where i.caregiver_user_id = cr.linked_user_id
            and i.client_id = target_client_id
            and i.status != 'resolved'
        )
      ) as has_open_incident_together,
      not exists (
        select 1 from public.caregiver_record_availability cra
        where cra.caregiver_record_id = cr.id
      ) as no_recorded_availability,
      (
        select count(distinct cr_req.id)
        from client_requested cr_req
        where exists (
          select 1 from public.caregiver_record_availability cra
          where cra.caregiver_record_id = cr.id
            and public.weekly_windows_overlap(
              public.weekly_window(cra.day_of_week, cra.start_time, cra.end_time),
              public.weekly_window(cr_req.day_of_week, cr_req.start_time, cr_req.end_time))
        )
      ) as matched_requested_windows
    from public.caregiver_records cr
    left join public.user_profiles up on up.id = cr.linked_user_id
    where cr.organization_id = target_organization_id
      and cr.deleted_at is null
      and cr.status = 'active'
  ),
  needs as (
    select
      (select count(*) from client_requested) as requested_windows,
      coalesce(array_length(client_language_needs, 1), 0) as language_need_count,
      coalesce(array_length(client_care_needs, 1), 0) as care_need_count,
      (client_zip is not null or client_city is not null or client_state is not null) as client_has_location
  ),
  scored as (
    select
      cb.caregiver_record_id,
      cb.display_name,
      (case
        when client_zip is not null and cb.address_zip is not null and client_zip = cb.address_zip then 30
        when client_city is not null and cb.address_city is not null and client_state is not null and cb.address_state is not null
          and lower(client_city) = lower(cb.address_city) and lower(client_state) = lower(cb.address_state) then 18
        when client_state is not null and cb.address_state is not null and lower(client_state) = lower(cb.address_state) then 6
        else 0
      end)::integer as proximity_score,
      (case
        when n.language_need_count = 0 then 25
        else round(25.0 * (
          select count(*) from unnest(client_language_needs) lang where lang = any(cb.languages)
        ) / n.language_need_count)
      end)::integer as language_score,
      (
        (case
          -- No weekly hours target recorded: capacity is unknown, not "mostly free".
          when cb.target_hours_per_week is null then 0
          when cb.target_hours_per_week - cb.scheduled_hours_this_week <= 0 then 0
          when cb.target_hours_per_week - cb.scheduled_hours_this_week >= 10 then 12
          else round(12.0 * (cb.target_hours_per_week - cb.scheduled_hours_this_week) / 10.0)
        end)
        +
        (case
          when n.requested_windows = 0 then 8               -- client recorded no windows: same for everyone
          when cb.no_recorded_availability then 0           -- caregiver recorded none: no credit
          else round(8.0 * cb.matched_requested_windows::numeric / n.requested_windows)
        end)
      )::integer as availability_score,
      (case
        when n.care_need_count = 0 then 10                  -- client recorded no needs: same for everyone
        when cb.skills is null or coalesce(array_length(cb.skills, 1), 0) = 0 then 0
        else round(10.0 * (
          select count(*) from unnest(client_care_needs) need where need = any(cb.skills)
        ) / n.care_need_count)
      end)::integer as skills_score,
      greatest(0,
        least(15, round(15.0 * least(cb.completed_together, 3) / 3.0))
        - (case when cb.has_open_incident_together then 10 else 0 end)
      )::integer as history_score,
      array_remove(array[
        case when n.requested_windows > 0 and cb.no_recorded_availability then 'availability_windows' end,
        case when n.care_need_count > 0 and coalesce(array_length(cb.skills, 1), 0) = 0 then 'skills' end,
        case when cb.target_hours_per_week is null then 'weekly_hours_target' end,
        case when n.language_need_count > 0 and coalesce(array_length(cb.languages, 1), 0) = 0 then 'languages' end,
        case when n.client_has_location and cb.address_zip is null and cb.address_city is null and cb.address_state is null then 'location' end
      ], null) as missing_data
    from caregiver_base cb
    cross join needs n
  )
  select
    s.caregiver_record_id,
    s.display_name,
    least(100, greatest(0,
      s.proximity_score + s.language_score + s.availability_score + s.skills_score + s.history_score
    ))::integer,
    s.proximity_score,
    s.language_score,
    s.availability_score,
    s.skills_score,
    s.history_score,
    s.missing_data
  from scored s
  order by 3 desc, cardinality(s.missing_data), s.display_name;
end;
$$;

revoke all on function public._score_caregiver_matches(uuid, uuid) from public, anon, authenticated;

create or replace function public.link_shift_to_requested_schedule()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  matched_id uuid;
  matched_count integer;
  org_tz text;
  local_start timestamp;
  shift_window int4range;
begin
  if new.source_requested_schedule_id is not null then
    return new;
  end if;

  select coalesce(o.timezone, 'America/Los_Angeles') into org_tz
  from public.organizations o where o.id = new.organization_id;

  -- The shift's start as the agency's wall-clock time; its length as-is.
  local_start := new.starts_at at time zone coalesce(org_tz, 'America/Los_Angeles');
  shift_window := int4range(
    (extract(isodow from local_start)::int - 1) * 1440
      + (extract(hour from local_start)::int * 60 + extract(minute from local_start)::int),
    (extract(isodow from local_start)::int - 1) * 1440
      + (extract(hour from local_start)::int * 60 + extract(minute from local_start)::int)
      + greatest(1, (extract(epoch from new.ends_at - new.starts_at) / 60)::int)
  );

  select crs.id, count(*) over ()
  into matched_id, matched_count
  from public.client_requested_schedule crs
  where crs.organization_id = new.organization_id
    and crs.client_id = new.client_id
    and public.weekly_windows_overlap(
      public.weekly_window(crs.day_of_week, crs.start_time, crs.end_time),
      shift_window)
  limit 1;

  if matched_count = 1 then
    new.source_requested_schedule_id := matched_id;
  end if;

  return new;
end;
$function$;

commit;
