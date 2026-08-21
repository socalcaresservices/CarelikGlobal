-- list_care_team_records() never returned caregiver_records.position,
-- so the Care Team list page had nowhere to show or filter by it even
-- though the Candidates page (and Care Team detail, since the earlier
-- migration in this session) already display it. Adds it for parity.
-- Dropped first: adding a column changes RETURNS TABLE's OUT-parameter
-- list, which CREATE OR REPLACE refuses.

drop function if exists public.list_care_team_records(uuid);

create or replace function public.list_care_team_records(target_organization_id uuid)
 returns table(id uuid, linked_user_id uuid, applicant_id uuid, caregiver_code text, display_name text, "position" text, email citext, phone text, status text, desired_weekly_hours numeric, available_start_date date, created_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    cr.id,
    cr.linked_user_id,
    cr.applicant_id,
    cr.caregiver_code,
    concat_ws(' ', coalesce(cr.preferred_name, cr.first_name), cr.last_name),
    cr.position,
    cr.email,
    cr.phone,
    cr.status,
    cr.desired_weekly_hours,
    cr.available_start_date,
    cr.created_at
  from public.caregiver_records cr
  where cr.organization_id = target_organization_id
    and cr.deleted_at is null
    and public.has_permission(target_organization_id, 'membership.read')
  order by cr.last_name, cr.first_name;
$function$;
