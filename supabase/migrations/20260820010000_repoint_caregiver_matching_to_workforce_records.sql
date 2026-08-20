begin;

-- Stage 2, item 2: list_caregiver_matches() (the CareScore matcher shown
-- on the client detail page's "Matches" tab) scored candidates purely
-- from organization_memberships/user_profiles - the login-based model.
-- A workforce member with no login account (caregiver_records with
-- linked_user_id null, which the admin scheduling screen explicitly
-- supports) was never a candidate, however good a match they might be.
--
-- Rebuilt on caregiver_records: proximity/languages come from the
-- workforce record's own address/languages fields (it already carries
-- both), availability compares against desired_weekly_hours (the
-- workforce-record equivalent of the old target_hours_per_week), and
-- shift history (scheduled hours this week, visits completed with this
-- client) is queried by shifts.caregiver_record_id - present on every
-- shift regardless of whether the caregiver has a login, unlike
-- caregiver_user_id.
--
-- Two fields have no clean equivalent yet and are handled by falling
-- back to the existing "absent requirement = full credit" convention
-- this function already uses elsewhere (client_care_needs is null):
-- skills (caregiver_records has no skills column at all - only
-- user_profiles.skills does, so a workforce-only caregiver has none to
-- compare) and incident history (incidents.caregiver_user_id is the
-- only column on that table - no caregiver_record_id - so a
-- workforce-only caregiver's open-incident check can never match and
-- always contributes 0 penalty). Both are real, narrower schema gaps
-- worth closing later; the fallback here means a workforce-only
-- caregiver is never unfairly penalized for a gap in our own data model
-- rather than blocked from matching at all, which is what happened
-- before this migration.
--
-- Return shape changes: caregiver_user_id -> caregiver_record_id. The
-- only live caller (client-detail-page.tsx's read-only "Matches" tab)
-- only ever used that column as a list key and a link target it doesn't
-- currently personalize - not as an argument to any write path - so this
-- is a safe rename, updated alongside this migration.
-- Postgres won't let create-or-replace change a function's return-column
-- list (dropping/renaming caregiver_user_id counts as that), so this has
-- to be a real drop + recreate, with grants reasserted afterward since
-- dropping a function drops its grants too.
drop function if exists public.list_caregiver_matches(uuid, uuid);

create function public.list_caregiver_matches(target_organization_id uuid, target_client_id uuid)
returns table(caregiver_record_id uuid, caregiver_name text, match_score integer, proximity_score integer, language_score integer, availability_score integer, skills_score integer, history_score integer)
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
      ) as has_open_incident_together
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
      (case
        when cb.target_hours_per_week is null then 15
        when cb.target_hours_per_week - cb.scheduled_hours_this_week <= 0 then 0
        when cb.target_hours_per_week - cb.scheduled_hours_this_week >= 10 then 20
        else round(20.0 * (cb.target_hours_per_week - cb.scheduled_hours_this_week) / 10.0)
      end)::integer as availability_score,
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

revoke all on function public.list_caregiver_matches(uuid, uuid) from public;
grant execute on function public.list_caregiver_matches(uuid, uuid) to authenticated;
revoke execute on function public.list_caregiver_matches(uuid, uuid) from anon;

commit;
