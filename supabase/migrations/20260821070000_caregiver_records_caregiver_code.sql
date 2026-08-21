begin;

-- clients has had a short, trackable client_code ('CL-XXXXXX', auto-
-- generated from the row's own id) since service_verification.sql -
-- caregivers type it in to find a client and start a visit
-- (start_service_visit_by_client_code), and it's shown throughout the
-- Service Verification flow. caregiver_records never got the equivalent:
-- no short code at all, anywhere - the Care Team list and detail pages
-- identify a caregiver only by name, and the record's own UUID leaks
-- into the URL (/team/<uuid>). Adding caregiver_code with the exact
-- same generation/uniqueness pattern as client_code closes that gap for
-- tracking/reference purposes (payroll, incident reports, support
-- conversations) - this is a display/reference identifier, not a new
-- lookup flow like start_service_visit_by_client_code; caregivers are
-- already identified by their own session when they check in, so
-- nothing here plugs into visit verification.
alter table public.caregiver_records add column caregiver_code text;

create or replace function public.set_default_caregiver_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.caregiver_code is null or trim(new.caregiver_code) = '' then
    new.caregiver_code := 'CG-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;
  return new;
end;
$$;

revoke all on function public.set_default_caregiver_code() from public, anon, authenticated;

create trigger caregiver_records_set_default_code
before insert on public.caregiver_records
for each row execute function public.set_default_caregiver_code();

-- Backfill existing rows the same way the trigger generates new ones,
-- then make the column authoritative like client_code's.
update public.caregiver_records
set caregiver_code = 'CG-' || upper(substr(replace(id::text, '-', ''), 1, 6))
where caregiver_code is null;

alter table public.caregiver_records alter column caregiver_code set not null;

create unique index caregiver_records_org_caregiver_code_unique
on public.caregiver_records (organization_id, lower(caregiver_code))
where deleted_at is null;

-- list_care_team_records is the only RPC the Care Team list page reads
-- from (the detail page selects caregiver_records directly with
-- select("*"), which already picks up the new column with no RPC
-- change needed). Dropped and recreated, not just replaced - adding a
-- column to the middle of a RETURNS TABLE list changes the function's
-- OUT-parameter signature, which CREATE OR REPLACE refuses.
drop function if exists public.list_care_team_records(uuid);

create function public.list_care_team_records(target_organization_id uuid)
returns table (
  id uuid,
  linked_user_id uuid,
  applicant_id uuid,
  caregiver_code text,
  display_name text,
  email citext,
  phone text,
  status text,
  desired_weekly_hours numeric,
  available_start_date date,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    cr.id,
    cr.linked_user_id,
    cr.applicant_id,
    cr.caregiver_code,
    concat_ws(' ', coalesce(cr.preferred_name, cr.first_name), cr.last_name),
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
$$;

revoke all on function public.list_care_team_records(uuid) from public, anon;
grant execute on function public.list_care_team_records(uuid) to authenticated;

commit;
