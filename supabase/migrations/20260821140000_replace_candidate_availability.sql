-- Candidate Detail showed job_applicant_availability read-only - a
-- candidate could submit availability through their own secure portal
-- link (replace_candidate_portal_availability), but staff had no way to
-- add, edit, or correct it directly (e.g. after a phone screen, or to
-- fix something the candidate got wrong). Adds the staff-side
-- equivalent, mirroring replace_caregiver_record_availability's
-- replace-the-full-set shape and permission-check style, but without
-- that function's 2-slots/day cap - job_applicant_availability already
-- supports unlimited rows per day via the portal RPC, so this doesn't
-- introduce a new limit that didn't exist before.
create or replace function public.replace_candidate_availability(target_organization_id uuid, target_applicant_id uuid, availability_slots jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to update candidate availability';
  end if;
  if not exists (
    select 1 from public.job_applicants
    where id = target_applicant_id and organization_id = target_organization_id
  ) then
    raise exception 'Candidate not found';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
      as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference)
    where start_time is null or end_time is null or end_time <= start_time
  ) then
    raise exception 'Every availability window must have a valid start and end time';
  end if;

  delete from public.job_applicant_availability
  where organization_id = target_organization_id and applicant_id = target_applicant_id;

  insert into public.job_applicant_availability
    (organization_id, applicant_id, day_of_week, start_time, end_time, preference)
  select target_organization_id, target_applicant_id, day_of_week, start_time, end_time,
    coalesce(preference, 'available'::public.availability_preference)
  from jsonb_to_recordset(coalesce(availability_slots, '[]'::jsonb))
    as x(day_of_week public.weekday, start_time time, end_time time, preference public.availability_preference);
end;
$$;

revoke all on function public.replace_candidate_availability(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_candidate_availability(uuid, uuid, jsonb) to authenticated;
