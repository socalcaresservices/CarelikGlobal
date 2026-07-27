begin;

-- Applicant profile expansion: the public application form was too thin
-- (name/contact/hours/one free-text transportation field) to actually
-- support matching or compliance later. This migration adds the fields
-- agencies need at intake time without touching anything that only
-- matters after hire (credentials, documents, capacity/compliance
-- calculations stay out of scope here - those are staff-side concerns
-- tracked as separate follow-up builds, not application-form fields).
--
-- Two fields from the original request are deliberately NOT added here:
--   - Photo: needs storage-bucket wiring for an unauthenticated upload
--     path (anon-writable bucket policy, virus/type checks) - a real
--     subsystem, not a column. Tracked as follow-up, not silently
--     dropped.
--   - Multi-shift-per-day availability: job_applicant_availability's
--     schema already allows more than one row per (applicant, day), but
--     the form UI only exposes one window per day today, matching the
--     same scope decision caregiver_availability's UI already made.
--     Widening the UI is follow-up work, not a schema change.
--
-- preferred_cities and transportation_method (from the original Build
-- 002 schema) are left in place - not dropped, just no longer populated
-- by the form - because the new spec explicitly replaces "which cities"
-- with "home address + travel-time radius" and replaces a free-text
-- transportation description with structured yes/no fields below.

alter table public.job_applicants
  add column middle_name text,
  add column preferred_name text,
  add column date_of_birth date,
  add column alternate_phone text,
  add column emergency_contact_name text,
  add column emergency_contact_phone text,
  add column address_street text,
  add column address_line2 text,
  add column address_city text,
  add column address_state text,
  add column address_zip text,
  add column address_country text not null default 'US',
  add column desired_monthly_hours numeric,
  add column min_monthly_hours numeric,
  add column max_monthly_hours numeric,
  add column reliable_transportation boolean,
  add column valid_drivers_license boolean,
  add column vehicle_available boolean,
  add column auto_insurance boolean;

alter table public.job_applicants
  add constraint job_applicants_monthly_hours_check check (
    (desired_monthly_hours is null or (desired_monthly_hours >= 0 and desired_monthly_hours <= 744))
    and (min_monthly_hours is null or (min_monthly_hours >= 0 and min_monthly_hours <= 744))
    and (max_monthly_hours is null or (max_monthly_hours >= 0 and max_monthly_hours <= 744))
  );

-- Which of the agency's configured services (public.services - already
-- built and already has a Settings UI on the Authorizations page) an
-- applicant says they're qualified/willing to provide. Junction table
-- rather than a column so the set of choices always reflects whatever
-- the agency currently has configured, with no hardcoded list anywhere
-- in this schema or the form.
create table public.job_applicant_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid not null references public.job_applicants(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (applicant_id, service_id)
);

create index job_applicant_services_applicant_idx on public.job_applicant_services (applicant_id);
create index job_applicant_services_org_idx on public.job_applicant_services (organization_id);

alter table public.job_applicant_services enable row level security;

-- Same guard as job_applicant_availability's insert policy: only while
-- the parent applicant record is still 'new'. Reuses
-- applicant_open_for_submission() (from the RLS fix migration) rather
-- than repeating the EXISTS subquery, since that helper already exists
-- for exactly this check and a raw EXISTS against job_applicants would
-- hit the same anon-can't-see-the-row problem that function was written
-- to fix.
create policy "public_submit_application_services"
on public.job_applicant_services for insert
to anon, authenticated
with check (public.applicant_open_for_submission(applicant_id, organization_id));

create policy "authorized_read_applicant_services"
on public.job_applicant_services for select
to authenticated
using (public.has_permission(organization_id, 'applicants.read'));

create policy "authorized_manage_applicant_services"
on public.job_applicant_services for all
to authenticated
using (public.has_permission(organization_id, 'applicants.update'))
with check (public.has_permission(organization_id, 'applicants.update'));

-- Lets the public application form render the agency's actual
-- configured services as checkboxes without opening the services
-- table's SELECT policy to anon generally (that policy requires
-- services.read, which anon never has). Narrow and read-only: id + name
-- of active services for one active org, same pattern as
-- get_organization_by_slug and organization_accepts_applications.
create or replace function public.list_public_organization_services(target_organization_id uuid)
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name
  from public.services s
  where s.organization_id = target_organization_id
    and s.is_active
    and s.deleted_at is null
    and public.organization_accepts_applications(target_organization_id)
  order by s.name;
$$;

revoke all on function public.list_public_organization_services(uuid) from public;
grant execute on function public.list_public_organization_services(uuid) to anon, authenticated;

commit;
