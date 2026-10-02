begin;

-- Caregiver supported services and preferred service areas.
--
-- Applicants could record the services they provide (job_applicant_services)
-- and preferred cities (job_applicants.preferred_cities), but the workforce
-- record kept neither, so after hire the office could not see or match on
-- them.
--
-- 1. caregiver_records.preferred_cities text[] (same convention as the
--    applicant field). Edited through the existing caregiver_records update
--    (authorized_update_caregiver_records, membership.update).
-- 2. caregiver_record_services (organization-scoped join table, FK to the
--    record and to services). Read like caregiver_record_availability;
--    written only through replace_caregiver_record_services (membership.update;
--    the record and every service must belong to the organization).
-- 3. Backfill from the originating applicant where the record has none, and
--    transfer_candidate_to_care_team now carries both over (body copied from
--    20260821080000 with only the two additions).
-- 4. CareScore: score and weights unchanged. New output:
--      missing_data += 'services' (client requested services, caregiver has
--                      none recorded);
--      match_notes:  'service_not_supported' (supports none of the client's
--                    requested services), 'some_services_not_supported',
--                    'outside_preferred_area' (client city not among the
--                    caregiver's preferred cities). Ties sort the caregiver
--                    with fewer notes first.
--    The return type changes, so the scorer and list_caregiver_matches are
--    dropped and recreated with their previous grants.

alter table public.caregiver_records
  add column if not exists preferred_cities text[] not null default '{}';

create table if not exists public.caregiver_record_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_record_id uuid not null references public.caregiver_records(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (caregiver_record_id, service_id)
);
create index if not exists caregiver_record_services_org_idx on public.caregiver_record_services (organization_id);
create index if not exists caregiver_record_services_service_idx on public.caregiver_record_services (service_id);

alter table public.caregiver_record_services enable row level security;
drop policy if exists "authorized_read_caregiver_record_services" on public.caregiver_record_services;
create policy "authorized_read_caregiver_record_services" on public.caregiver_record_services
for select to authenticated
using (
  public.has_permission(organization_id, 'membership.read')
  or public.has_permission(organization_id, 'membership.update')
  or (public.organization_is_active(organization_id) and exists (
    select 1 from public.caregiver_records cr
    where cr.id = caregiver_record_services.caregiver_record_id and cr.linked_user_id = (select auth.uid())
  ))
);
revoke all on table public.caregiver_record_services from public, anon, authenticated;
grant select on table public.caregiver_record_services to authenticated;

create or replace function public.replace_caregiver_record_services(
  target_organization_id uuid,
  target_caregiver_record_id uuid,
  service_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to update Care Team services';
  end if;
  if not exists (
    select 1 from public.caregiver_records
    where id = target_caregiver_record_id and organization_id = target_organization_id and deleted_at is null
  ) then
    raise exception 'Care Team record not found';
  end if;
  if exists (
    select 1 from unnest(coalesce(service_ids, '{}')) sid
    where not exists (
      select 1 from public.services s
      where s.id = sid and s.organization_id = target_organization_id and s.deleted_at is null
    )
  ) then
    raise exception 'A selected service is not valid for this organization';
  end if;

  delete from public.caregiver_record_services
  where organization_id = target_organization_id and caregiver_record_id = target_caregiver_record_id;

  insert into public.caregiver_record_services (organization_id, caregiver_record_id, service_id)
  select distinct target_organization_id, target_caregiver_record_id, sid
  from unnest(coalesce(service_ids, '{}')) sid;
end;
$$;
revoke all on function public.replace_caregiver_record_services(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.replace_caregiver_record_services(uuid, uuid, uuid[]) to authenticated;

-- Backfill from the originating applicant (records with nothing recorded yet).
insert into public.caregiver_record_services (organization_id, caregiver_record_id, service_id)
select cr.organization_id, cr.id, s.service_id
from public.caregiver_records cr
join public.job_applicant_services s on s.applicant_id = cr.applicant_id and s.organization_id = cr.organization_id
join public.services sv on sv.id = s.service_id and sv.organization_id = cr.organization_id and sv.deleted_at is null
where cr.applicant_id is not null
  and not exists (select 1 from public.caregiver_record_services x where x.caregiver_record_id = cr.id)
on conflict do nothing;

update public.caregiver_records cr
   set preferred_cities = a.preferred_cities
  from public.job_applicants a
 where a.id = cr.applicant_id
   and a.organization_id = cr.organization_id
   and cardinality(cr.preferred_cities) = 0
   and cardinality(coalesce(a.preferred_cities, '{}')) > 0;

create or replace function public.transfer_candidate_to_care_team(target_organization_id uuid, target_applicant_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  a public.job_applicants;
  o public.candidate_onboarding;
  record_id uuid;
begin
  if not public.has_permission(target_organization_id, 'applicants.update')
     or not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to transfer candidates for this organization';
  end if;
  select * into a from public.job_applicants
    where id = target_applicant_id and organization_id = target_organization_id;
  if not found then raise exception 'Candidate not found'; end if;
  select * into o from public.candidate_onboarding
    where applicant_id = target_applicant_id and organization_id = target_organization_id;

  insert into public.caregiver_records (
    organization_id, applicant_id, first_name, middle_name, last_name, preferred_name,
    email, phone, alternate_phone, address_street, address_line2, address_city,
    address_state, address_zip, address_country, employment_type, available_start_date,
    desired_weekly_hours, min_weekly_hours, max_weekly_hours, min_shift_hours,
    max_shift_hours, max_travel_minutes, transportation_method, reliable_transportation,
    willing_to_transport_clients, valid_drivers_license, vehicle_available, auto_insurance,
    languages, preferred_cities, status, position, onboarding_status, onboarding_scheduled_at, onboarding_method,
    onboarding_location, onboarding_instructions, onboarding_notes,
    background_check_status, compliance_status, onboarding_completed_at
  ) values (
    target_organization_id, a.id, a.first_name, a.middle_name, a.last_name, a.preferred_name,
    a.email, a.phone, a.alternate_phone, a.address_street, a.address_line2, a.address_city,
    a.address_state, a.address_zip, a.address_country, a.employment_type::text, a.available_start_date,
    a.desired_weekly_hours, a.min_weekly_hours, a.max_weekly_hours, a.min_shift_hours,
    a.max_shift_hours, a.max_travel_minutes, a.transportation_method, a.reliable_transportation,
    a.willing_to_transport_clients, a.valid_drivers_license, a.vehicle_available, a.auto_insurance,
    a.languages, coalesce(a.preferred_cities, '{}'), 'onboarding', a.position_applied_for, o.status, o.scheduled_at, o.method, o.location,
    o.instructions, o.notes, o.background_check_status, o.compliance_status, o.completed_at
  )
  on conflict (organization_id, applicant_id) where applicant_id is not null and deleted_at is null
  do update set
    first_name = excluded.first_name, last_name = excluded.last_name,
    preferred_name = excluded.preferred_name, email = excluded.email, phone = excluded.phone,
    position = excluded.position,
    onboarding_status = excluded.onboarding_status,
    onboarding_scheduled_at = excluded.onboarding_scheduled_at,
    onboarding_method = excluded.onboarding_method,
    onboarding_location = excluded.onboarding_location,
    onboarding_instructions = excluded.onboarding_instructions,
    onboarding_notes = excluded.onboarding_notes,
    background_check_status = excluded.background_check_status,
    compliance_status = excluded.compliance_status,
    onboarding_completed_at = excluded.onboarding_completed_at
  returning id into record_id;

  delete from public.caregiver_record_availability where caregiver_record_id = record_id;
  insert into public.caregiver_record_availability
    (organization_id, caregiver_record_id, day_of_week, start_time, end_time, preference)
  select target_organization_id, record_id, day_of_week, start_time, end_time, preference
  from public.job_applicant_availability where applicant_id = target_applicant_id;

  -- Services the candidate said they can provide carry over like availability.
  delete from public.caregiver_record_services where caregiver_record_id = record_id;
  insert into public.caregiver_record_services (organization_id, caregiver_record_id, service_id)
  select target_organization_id, record_id, s.service_id
  from public.job_applicant_services s
  join public.services sv on sv.id = s.service_id and sv.organization_id = target_organization_id and sv.deleted_at is null
  where s.applicant_id = target_applicant_id and s.organization_id = target_organization_id
  on conflict do nothing;

  delete from public.caregiver_record_credentials where caregiver_record_id = record_id;
  insert into public.caregiver_record_credentials (
    organization_id, caregiver_record_id, source_candidate_credential_id, credential_type,
    issue_date, expiration_date, does_not_expire, issuing_organization, credential_number,
    verification_status, verified_by, verified_at, notes
  ) select target_organization_id, record_id, id, credential_type, issue_date,
    expiration_date, does_not_expire, issuing_organization, credential_number,
    verification_status, verified_by, verified_at, notes
  from public.candidate_credentials
  where applicant_id = target_applicant_id and deleted_at is null;

  perform public.set_candidate_stage(target_organization_id, target_applicant_id, 'care_team', 'Transferred to Care Team');
  perform public.revoke_candidate_portal_links_for_applicant(target_organization_id, target_applicant_id);
  return record_id;
end;
$function$;

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
  missing_data text[],
  match_notes text[]
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
  client_service_ids uuid[];
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

  select coalesce(array_agg(rs.service_id), '{}') into client_service_ids
  from public.client_requested_services rs
  where rs.client_id = target_client_id and rs.organization_id = target_organization_id;

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
      cr.preferred_cities,
      (select coalesce(array_agg(crs.service_id), '{}') from public.caregiver_record_services crs
        where crs.caregiver_record_id = cr.id and crs.organization_id = target_organization_id) as supported_service_ids,
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
        case when n.client_has_location and cb.address_zip is null and cb.address_city is null and cb.address_state is null then 'location' end,
        case when cardinality(client_service_ids) > 0 and cardinality(cb.supported_service_ids) = 0 then 'services' end
      ], null) as missing_data,
      -- Informational only: these do not change the score.
      array_remove(array[
        case when cardinality(client_service_ids) > 0 and cardinality(cb.supported_service_ids) > 0
              and not (cb.supported_service_ids && client_service_ids) then 'service_not_supported'
             when cardinality(client_service_ids) > 0 and cardinality(cb.supported_service_ids) > 0
              and not (cb.supported_service_ids @> client_service_ids) then 'some_services_not_supported' end,
        case when client_city is not null and cardinality(cb.preferred_cities) > 0
              and not exists (select 1 from unnest(cb.preferred_cities) pc where lower(btrim(pc)) = lower(btrim(client_city)))
             then 'outside_preferred_area' end
      ], null) as match_notes
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
    s.missing_data,
    s.match_notes
  from scored s
  order by 3 desc, cardinality(s.missing_data), cardinality(s.match_notes), s.display_name;
end;
$$;

revoke all on function public._score_caregiver_matches(uuid, uuid) from public, anon, authenticated;

create function public.list_caregiver_matches(target_organization_id uuid, target_client_id uuid)
returns table(caregiver_record_id uuid, caregiver_name text, match_score integer, proximity_score integer, language_score integer, availability_score integer, skills_score integer, history_score integer, missing_data text[], match_notes text[])
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
