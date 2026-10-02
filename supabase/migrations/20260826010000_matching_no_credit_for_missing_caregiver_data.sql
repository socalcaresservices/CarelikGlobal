begin;

-- CareScore audit: missing CAREGIVER data must not earn match credit.
--
-- 20260823080000 gave "unknown, don't penalize" full credit in two places
-- and partial credit in a third. When the CLIENT has recorded a need, that
-- default rewarded the caregiver whose profile is incomplete over one who
-- recorded data that only partly matches:
--   - availability windows: client has requested windows, caregiver has
--     recorded none -> full 8/8 (a caregiver who recorded windows matching
--     half of them got 4/8);
--   - skills: client has care needs, caregiver has no skills on record
--     (every caregiver without a login: skills live on user_profiles) ->
--     full 10/10 (a login caregiver with an empty skills list got 0/10);
--   - capacity: no desired weekly hours recorded -> 9/12 regardless of
--     how much the caregiver is already scheduled.
-- The ranking also drives call_out_shift's automatic replacement offers,
-- so an incomplete profile could be texted ahead of a verified fit.
--
-- New rule (same 0-100 scale, same weights, same columns + one new one):
--   - client has NOT recorded the need -> everyone gets the same neutral
--     credit (unchanged; it cannot change the order);
--   - client HAS recorded the need and the caregiver has no data for it ->
--     0 for that component, and the gap is listed in missing_data so the
--     office sees "not recorded" instead of a silent low score.
-- missing_data values: availability_windows, skills, weekly_hours_target,
-- languages, location. Proximity and language already scored 0 for
-- missing data; they are only flagged now.
--
-- Return type changes (new trailing column), so both functions are dropped
-- and recreated with their previous grants. Callers that select named
-- columns (client operations dashboard, call_out_shift) are unaffected.

drop function if exists public.list_caregiver_matches(uuid, uuid);
drop function if exists public._score_caregiver_matches(uuid, uuid);

create function public._score_caregiver_matches(target_organization_id uuid, target_client_id uuid)
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
      up.skills,
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
            and cra.day_of_week = cr_req.day_of_week
            and cra.start_time < cr_req.end_time
            and cra.end_time > cr_req.start_time
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

create function public.list_caregiver_matches(target_organization_id uuid, target_client_id uuid)
returns table(caregiver_record_id uuid, caregiver_name text, match_score integer, proximity_score integer, language_score integer, availability_score integer, skills_score integer, history_score integer, missing_data text[])
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'shifts.update') then
    raise exception 'You do not have permission to view caregiver matches for this organization';
  end if;
  return query select * from public._score_caregiver_matches(target_organization_id, target_client_id);
end;
$$;

revoke all on function public.list_caregiver_matches(uuid, uuid) from public;
grant execute on function public.list_caregiver_matches(uuid, uuid) to authenticated;
revoke execute on function public.list_caregiver_matches(uuid, uuid) from anon;

commit;
