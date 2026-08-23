begin;

-- Scheduling audit's second-to-last item: _score_caregiver_matches()'s
-- availability_score was entirely a capacity proxy (desired_weekly_hours
-- minus hours already scheduled this week) - it never looked at either
-- caregiver_record_availability (day/time windows a caregiver actually
-- says they can work, editable via replace_caregiver_record_availability)
-- or client_requested_schedule (the day/time windows a client says they
-- need care, editable via replace_client_requested_schedule). A caregiver
-- with plenty of open capacity but who has explicitly marked themselves
-- unavailable on the exact days/times a client needs care scored no
-- differently than one who is actually free then.
--
-- Rebalanced the existing 0-20 availability_score into two additive
-- components so the total range and meaning ("Availability x/20" on the
-- Client Detail Matches tab) is unchanged:
--   - capacity (0-12): the same formula as before, scaled down from 20.
--   - real_availability (0-8): fraction of the client's requested-schedule
--     windows that overlap a recorded caregiver_record_availability window
--     on the same day_of_week. Neither side having data recorded is
--     treated as "unknown, don't penalize" (full credit) rather than a
--     mismatch - consistent with how language_score/skills_score already
--     default to full credit when the client hasn't recorded needs, and
--     avoids scoring every caregiver 0 for a client whose office simply
--     hasn't entered requested_schedule yet, or a caregiver who hasn't
--     entered availability yet.
create or replace function public._score_caregiver_matches(target_organization_id uuid, target_client_id uuid)
returns table (
  caregiver_record_id uuid,
  caregiver_name text,
  match_score integer,
  proximity_score integer,
  language_score integer,
  availability_score integer,
  skills_score integer,
  history_score integer
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
        when client_language_needs is null or array_length(client_language_needs, 1) is null then 25
        else round(25.0 * (
          select count(*) from unnest(client_language_needs) lang where lang = any(cb.languages)
        ) / array_length(client_language_needs, 1))
      end)::integer as language_score,
      (
        (case
          when cb.target_hours_per_week is null then 9
          when cb.target_hours_per_week - cb.scheduled_hours_this_week <= 0 then 0
          when cb.target_hours_per_week - cb.scheduled_hours_this_week >= 10 then 12
          else round(12.0 * (cb.target_hours_per_week - cb.scheduled_hours_this_week) / 10.0)
        end)
        +
        (case
          when (select count(*) from client_requested) = 0 then 8
          when cb.no_recorded_availability then 8
          else round(8.0 * cb.matched_requested_windows::numeric / (select count(*) from client_requested))
        end)
      )::integer as availability_score,
      (case
        when cb.skills is null or client_care_needs is null or array_length(client_care_needs, 1) is null then 10
        else round(10.0 * (
          select count(*) from unnest(client_care_needs) need where need = any(cb.skills)
        ) / array_length(client_care_needs, 1))
      end)::integer as skills_score,
      greatest(0,
        least(15, round(15.0 * least(cb.completed_together, 3) / 3.0))
        - (case when cb.has_open_incident_together then 10 else 0 end)
      )::integer as history_score
    from caregiver_base cb
  )
  select
    s.caregiver_record_id,
    s.display_name,
    least(100, greatest(0,
      s.proximity_score + s.language_score + s.availability_score + s.skills_score + s.history_score
    )),
    s.proximity_score,
    s.language_score,
    s.availability_score,
    s.skills_score,
    s.history_score
  from scored s
  order by 3 desc, s.display_name;
end;
$$;

commit;
