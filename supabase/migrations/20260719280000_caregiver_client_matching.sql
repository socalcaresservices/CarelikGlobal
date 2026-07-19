begin;

-- CareScore: a match/fit score between a specific client and a specific
-- caregiver, per the user's definition (not a general caregiver rating).
-- Weighted from real fields only - proximity, language, availability,
-- skills, and shared history - never a placeholder number. Confirmed
-- with the user: proximity, language, and availability matter most;
-- skills and history are smaller factors. No real geocoding exists yet,
-- so proximity is a zip/city/state text match, not drive time - that's
-- an explicit, documented simplification, not a guess.

alter table public.user_profiles
  add column address_city text,
  add column address_state text,
  add column address_zip text,
  add column languages text[] not null default '{}',
  add column skills text[] not null default '{}';

alter table public.clients
  add column address_city text,
  add column address_state text,
  add column address_zip text,
  add column language_needs text[] not null default '{}',
  add column care_needs text[] not null default '{}';

-- user_profiles RLS only lets someone edit their own row (or a platform
-- owner). A manager needs to be able to fill this in on a caregiver's
-- behalf too (onboarding, etc.), so this mirrors the
-- set_caregiver_weekly_target() pattern: self-edit OR membership.update
-- within the organization context passed in.
create or replace function public.set_caregiver_profile(
  target_organization_id uuid,
  target_user_id uuid,
  new_address_city text,
  new_address_state text,
  new_address_zip text,
  new_languages text[],
  new_skills text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_user_id != auth.uid() and not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to edit this caregiver''s profile';
  end if;

  update public.user_profiles
  set address_city = new_address_city,
      address_state = new_address_state,
      address_zip = new_address_zip,
      languages = coalesce(new_languages, '{}'),
      skills = coalesce(new_skills, '{}')
  where id = target_user_id;

  if not found then
    raise exception 'No profile found for that user';
  end if;
end;
$$;

revoke all on function public.set_caregiver_profile(uuid, uuid, text, text, text, text[], text[]) from public;
grant execute on function public.set_caregiver_profile(uuid, uuid, text, text, text, text[], text[]) to authenticated;
revoke execute on function public.set_caregiver_profile(uuid, uuid, text, text, text, text[], text[]) from anon;

-- Ranks every active caregiver in the org against one client on a 0-100
-- CareScore, computed entirely from columns that already exist - nothing
-- fabricated. Weights (documented here, not hidden): proximity 30,
-- language 25, availability 20, skills 10, history 15.
--
-- Proximity: zip match = full 30; else city+state match = 18; else
-- state-only match = 6; else (including missing address on either side)
-- 0 - never assume a match without at least a state in common.
--
-- Language: if the client has no language_needs on file, there's no
-- requirement to fail, so full 25. Otherwise 25 * (overlap / needs).
--
-- Availability: proxy for "has room in their week" since there's no
-- availability-calendar feature yet, only actual scheduled hours. If no
-- weekly target is set, a neutral 15/20 (unknown, not penalized).
-- Otherwise scales from 0 (fully booked or over target) to 20 (10+
-- hours of headroom).
--
-- Skills: same overlap logic as language, out of 10, full 10 if the
-- client has no care_needs on file.
--
-- History: up to 15 for prior completed shifts together (capped at 3
-- shifts = full 15), minus 10 (floored at 0) if there's an unresolved
-- incident involving both this caregiver and this client - a completed
-- history is a positive signal, an open incident is a real caution flag.
create or replace function public.list_caregiver_matches(
  target_organization_id uuid,
  target_client_id uuid
)
returns table (
  caregiver_user_id uuid,
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
  if not public.has_permission(target_organization_id, 'shifts.update') then
    raise exception 'You do not have permission to view caregiver matches for this organization';
  end if;

  select c.address_zip, c.address_city, c.address_state, c.language_needs, c.care_needs
  into client_zip, client_city, client_state, client_language_needs, client_care_needs
  from public.clients c
  where c.id = target_client_id and c.organization_id = target_organization_id;

  if not found then
    raise exception 'Client not found in this organization';
  end if;

  return query
  with caregiver_base as (
    select
      m.user_id,
      coalesce(p.display_name, 'Unknown member') as display_name,
      p.address_zip,
      p.address_city,
      p.address_state,
      p.languages,
      p.skills,
      m.target_hours_per_week,
      coalesce(
        (
          select sum(extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0)
          from public.shifts s
          where s.caregiver_user_id = m.user_id
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
        where s.caregiver_user_id = m.user_id
          and s.client_id = target_client_id
          and s.status = 'completed'
      ) as completed_together,
      exists (
        select 1
        from public.incidents i
        where i.caregiver_user_id = m.user_id
          and i.client_id = target_client_id
          and i.status != 'resolved'
      ) as has_open_incident_together
    from public.organization_memberships m
    join public.user_profiles p on p.id = m.user_id
    where m.organization_id = target_organization_id
      and m.status = 'active'
  ),
  scored as (
    select
      cb.user_id,
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
      (case
        when cb.target_hours_per_week is null then 15
        when cb.target_hours_per_week - cb.scheduled_hours_this_week <= 0 then 0
        when cb.target_hours_per_week - cb.scheduled_hours_this_week >= 10 then 20
        else round(20.0 * (cb.target_hours_per_week - cb.scheduled_hours_this_week) / 10.0)
      end)::integer as availability_score,
      (case
        when client_care_needs is null or array_length(client_care_needs, 1) is null then 10
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
    s.user_id,
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

revoke all on function public.list_caregiver_matches(uuid, uuid) from public;
grant execute on function public.list_caregiver_matches(uuid, uuid) to authenticated;
revoke execute on function public.list_caregiver_matches(uuid, uuid) from anon;

commit;
