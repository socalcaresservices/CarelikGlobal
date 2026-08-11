begin;

-- Real CareScore on a caregiver's own detail page. The scoring formula
-- already exists and is already real (list_caregiver_matches(), see
-- 20260719280000_caregiver_client_matching.sql) - it just only ever ran
-- client-first (rank every caregiver against one client, for the
-- Schedule page's assignment dropdown). This is the same formula run
-- caregiver-first (rank every active client against one caregiver), so
-- caregiver-detail-page.tsx can show a caregiver's real top matches
-- instead of the hash-based previewScoreFromId() placeholder it used
-- before. Same weights (proximity 30 / language 25 / availability 20 /
-- skills 10 / history 15), same data sources, same
-- has_permission(org, 'shifts.update') gate as the original - this is
-- the same manager-facing "who should I match this caregiver with"
-- question, just entered from the other side.
create or replace function public.list_client_matches_for_caregiver(
  target_organization_id uuid,
  target_caregiver_user_id uuid
)
returns table (
  client_id uuid,
  client_name text,
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
  caregiver_zip text;
  caregiver_city text;
  caregiver_state text;
  caregiver_languages text[];
  caregiver_skills text[];
  caregiver_target_hours numeric;
  caregiver_scheduled_hours numeric;
  week_start timestamptz := date_trunc('week', now());
  week_end timestamptz := date_trunc('week', now()) + interval '7 days';
begin
  if not public.has_permission(target_organization_id, 'shifts.update') then
    raise exception 'You do not have permission to view caregiver matches for this organization';
  end if;

  select p.address_zip, p.address_city, p.address_state, p.languages, p.skills, m.target_hours_per_week
  into caregiver_zip, caregiver_city, caregiver_state, caregiver_languages, caregiver_skills, caregiver_target_hours
  from public.organization_memberships m
  join public.user_profiles p on p.id = m.user_id
  where m.user_id = target_caregiver_user_id
    and m.organization_id = target_organization_id
    and m.status = 'active';

  if not found then
    raise exception 'Caregiver not found in this organization';
  end if;

  select coalesce(
    sum(extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0),
    0
  )
  into caregiver_scheduled_hours
  from public.shifts s
  where s.caregiver_user_id = target_caregiver_user_id
    and s.organization_id = target_organization_id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < week_end
    and s.ends_at > week_start;

  return query
  with client_base as (
    select
      c.id,
      coalesce(c.first_name || ' ' || c.last_name, 'Unknown client') as display_name,
      c.address_zip,
      c.address_city,
      c.address_state,
      c.language_needs,
      c.care_needs,
      (
        select count(*)::int
        from public.shifts s
        where s.caregiver_user_id = target_caregiver_user_id
          and s.client_id = c.id
          and s.status = 'completed'
      ) as completed_together,
      exists (
        select 1
        from public.incidents i
        where i.caregiver_user_id = target_caregiver_user_id
          and i.client_id = c.id
          and i.status != 'resolved'
      ) as has_open_incident_together
    from public.clients c
    where c.organization_id = target_organization_id
      and c.status = 'active'
      and c.deleted_at is null
  ),
  scored as (
    select
      cb.id,
      cb.display_name,
      (case
        when caregiver_zip is not null and cb.address_zip is not null and caregiver_zip = cb.address_zip then 30
        when caregiver_city is not null and cb.address_city is not null and caregiver_state is not null and cb.address_state is not null
          and lower(caregiver_city) = lower(cb.address_city) and lower(caregiver_state) = lower(cb.address_state) then 18
        when caregiver_state is not null and cb.address_state is not null and lower(caregiver_state) = lower(cb.address_state) then 6
        else 0
      end)::integer as proximity_score,
      (case
        when cb.language_needs is null or array_length(cb.language_needs, 1) is null then 25
        else round(25.0 * (
          select count(*) from unnest(cb.language_needs) lang where lang = any(caregiver_languages)
        ) / array_length(cb.language_needs, 1))
      end)::integer as language_score,
      (case
        when caregiver_target_hours is null then 15
        when caregiver_target_hours - caregiver_scheduled_hours <= 0 then 0
        when caregiver_target_hours - caregiver_scheduled_hours >= 10 then 20
        else round(20.0 * (caregiver_target_hours - caregiver_scheduled_hours) / 10.0)
      end)::integer as availability_score,
      (case
        when cb.care_needs is null or array_length(cb.care_needs, 1) is null then 10
        else round(10.0 * (
          select count(*) from unnest(cb.care_needs) need where need = any(caregiver_skills)
        ) / array_length(cb.care_needs, 1))
      end)::integer as skills_score,
      greatest(0,
        least(15, round(15.0 * least(cb.completed_together, 3) / 3.0))
        - (case when cb.has_open_incident_together then 10 else 0 end)
      )::integer as history_score
    from client_base cb
  )
  select
    s.id,
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

revoke all on function public.list_client_matches_for_caregiver(uuid, uuid) from public;
grant execute on function public.list_client_matches_for_caregiver(uuid, uuid) to authenticated;
revoke execute on function public.list_client_matches_for_caregiver(uuid, uuid) from anon;

-- Public pricing page RPC. Same anon-callable pattern as
-- get_organization_by_slug() (20260728090000_apply_page_branding.sql) -
-- marketing-safe columns only (no created_by/internal versioning),
-- filtered to plans the platform owner has explicitly marked public,
-- active, and current. is_public/is_active/is_current are the same
-- flags plan_definitions' own RLS policy already trusts for
-- authenticated non-owner reads (20260809161000_billing_plans_and_subscribers.sql)
-- - this just extends that same trust to anon.
create or replace function public.list_public_plan_versions()
returns table (
  plan_key text,
  name text,
  description text,
  monthly_price_cents integer,
  annual_price_cents integer,
  max_active_clients integer,
  max_active_caregivers integer,
  max_administrators integer,
  support_level text,
  features text[],
  is_trial boolean,
  trial_duration_days integer,
  is_introductory boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    plan_key, name, description, monthly_price_cents, annual_price_cents,
    max_active_clients, max_active_caregivers, max_administrators,
    support_level, features, is_trial, trial_duration_days, is_introductory
  from public.plan_definitions
  where is_public = true and is_active = true and is_current = true
  order by monthly_price_cents;
$$;

revoke all on function public.list_public_plan_versions() from public;
grant execute on function public.list_public_plan_versions() to anon, authenticated;

commit;
