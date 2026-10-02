begin;

-- Caregivers without a login could not have skills at all: skills lived only
-- on user_profiles (one row per auth user), so every caregiver_records row
-- with linked_user_id = null had none. Since
-- 20260826010000_matching_no_credit_for_missing_caregiver_data.sql, missing
-- skills score 0 when a client has care needs, so these caregivers could
-- never earn skills credit.
--
-- 1. caregiver_records.skills (text[] of the organization's skill catalog
--    names, the same name-based convention as clients.care_needs and
--    caregiver_records.languages). Edited on the Workforce profile, which
--    already writes caregiver_records under the existing
--    authorized_update_caregiver_records policy (membership.update); the
--    table-level UPDATE grant covers the new column.
-- 2. Backfill: a linked record with no skills of its own takes its login's
--    profile skills (non-destructive, re-runnable).
-- 3. CareScore reads the union of record skills and any linked profile
--    skills. Only that one expression changes; scoring, return type and
--    grants are those of 20260826010000.

alter table public.caregiver_records
  add column if not exists skills text[] not null default '{}';

update public.caregiver_records cr
   set skills = up.skills
  from public.user_profiles up
 where up.id = cr.linked_user_id
   and cardinality(cr.skills) = 0
   and cardinality(up.skills) > 0;

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

commit;
