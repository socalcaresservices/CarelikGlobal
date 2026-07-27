begin;

-- Job applicants: the public-facing intake this app didn't have before.
-- Anyone can submit an application at /apply/:orgSlug without an
-- account (anon insert) - staff review, decide, and (if hired) convert
-- the applicant's answers straight onto the resulting caregiver's
-- profile, so nobody re-types availability or desired hours a second
-- time. See docs/phase-2-modernization.md for why this didn't exist
-- until now: a prior branch explicitly scoped applicant tracking out as
-- new feature work, not modernization, "until asked for." This is that
-- ask.

create type public.applicant_status as enum ('new', 'reviewing', 'hired', 'rejected', 'withdrawn');
create type public.availability_preference as enum ('available', 'preferred');

create table public.job_applicants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email citext not null,
  phone text,
  status public.applicant_status not null default 'new',
  desired_weekly_hours numeric,
  min_weekly_hours numeric,
  max_weekly_hours numeric,
  min_shift_hours numeric,
  max_shift_hours numeric,
  preferred_cities text[] not null default '{}',
  max_travel_minutes integer,
  transportation_method text,
  willing_to_transport_clients boolean,
  languages text[] not null default '{}',
  notes text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  hired_caregiver_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_applicants_hours_check check (
    (desired_weekly_hours is null or (desired_weekly_hours >= 0 and desired_weekly_hours <= 168))
    and (min_weekly_hours is null or (min_weekly_hours >= 0 and min_weekly_hours <= 168))
    and (max_weekly_hours is null or (max_weekly_hours >= 0 and max_weekly_hours <= 168))
    and (min_shift_hours is null or min_shift_hours >= 0)
    and (max_shift_hours is null or max_shift_hours >= 0)
  )
);

create index job_applicants_org_idx on public.job_applicants (organization_id);
create index job_applicants_status_idx on public.job_applicants (organization_id, status);
create index job_applicants_email_idx on public.job_applicants (organization_id, email);

create trigger job_applicants_set_updated_at
before update on public.job_applicants
for each row execute function public.set_updated_at();

create trigger job_applicants_audit
after insert or update or delete on public.job_applicants
for each row execute function public.write_audit_log();

-- Same shape as caregiver_availability: one row per available window,
-- a preference tier (available vs preferred) instead of a third
-- "unavailable" state - same convention as caregiver_availability,
-- where the absence of a row for a day already means unavailable.
create table public.job_applicant_availability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid not null references public.job_applicants(id) on delete cascade,
  day_of_week public.weekday not null,
  start_time time not null,
  end_time time not null,
  preference public.availability_preference not null default 'available',
  created_at timestamptz not null default now(),
  constraint job_applicant_availability_time_order check (end_time > start_time)
);

create index job_applicant_availability_applicant_idx on public.job_applicant_availability (applicant_id);
create index job_applicant_availability_org_idx on public.job_applicant_availability (organization_id);

alter table public.job_applicants enable row level security;
alter table public.job_applicant_availability enable row level security;

-- Anyone - anon or a logged-in user applying on someone else's behalf -
-- can submit an application, but only as a fresh 'new' record with no
-- review fields set. Column-level tampering (e.g. posting status =
-- 'hired' directly) is blocked by the with-check, not by column grants,
-- matching how the rest of this schema enforces field-level rules.
create policy "public_submit_applications"
on public.job_applicants for insert
to anon, authenticated
with check (
  status = 'new'
  and reviewed_by is null
  and reviewed_at is null
  and hired_caregiver_user_id is null
  and exists (
    select 1 from public.organizations o
    where o.id = organization_id and o.status = 'active' and o.deleted_at is null
  )
);

create policy "authorized_read_applicants"
on public.job_applicants for select
to authenticated
using (public.has_permission(organization_id, 'applicants.read'));

create policy "authorized_manage_applicants"
on public.job_applicants for update
to authenticated
using (public.has_permission(organization_id, 'applicants.update'))
with check (public.has_permission(organization_id, 'applicants.update'));

-- Availability rows can only be attached to an applicant's own
-- still-'new' record - once staff start reviewing (status moves past
-- 'new'), the public insert path closes for that applicant, so a
-- reviewed application's availability can't be silently altered by
-- someone re-submitting against the same id.
create policy "public_submit_application_availability"
on public.job_applicant_availability for insert
to anon, authenticated
with check (
  exists (
    select 1 from public.job_applicants ja
    where ja.id = applicant_id
      and ja.organization_id = job_applicant_availability.organization_id
      and ja.status = 'new'
  )
);

create policy "authorized_read_applicant_availability"
on public.job_applicant_availability for select
to authenticated
using (public.has_permission(organization_id, 'applicants.read'));

create policy "authorized_manage_applicant_availability"
on public.job_applicant_availability for all
to authenticated
using (public.has_permission(organization_id, 'applicants.update'))
with check (public.has_permission(organization_id, 'applicants.update'));

insert into public.permissions (key, description) values
  ('applicants.read', 'View job applicants and their submitted availability'),
  ('applicants.update', 'Review, decide on, and convert job applicants into caregivers');

insert into public.role_permissions (role, permission_key)
select role_value, new_permissions.key
from (
  values
    ('organization_owner'::public.system_role),
    ('organization_admin'::public.system_role),
    ('manager'::public.system_role),
    ('coordinator'::public.system_role)
) roles(role_value)
cross join (
  select key from public.permissions
  where key in ('applicants.read', 'applicants.update')
) new_permissions;

-- Lets the public apply page resolve an org slug to an id without
-- needing an authenticated session - deliberately narrow (id + display
-- name only, active orgs only) rather than opening organizations SELECT
-- to anon generally.
create or replace function public.get_organization_by_slug(target_slug text)
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.display_name
  from public.organizations o
  where o.slug = target_slug and o.status = 'active' and o.deleted_at is null;
$$;

revoke all on function public.get_organization_by_slug(text) from public;
grant execute on function public.get_organization_by_slug(text) to anon, authenticated;

-- List view for staff review, joining reviewer name - same shape as
-- list_incidents(). Visibility mirrors the table RLS (applicants.read).
create or replace function public.list_applicants(target_organization_id uuid)
returns table (
  id uuid,
  first_name text,
  last_name text,
  email citext,
  phone text,
  status public.applicant_status,
  desired_weekly_hours numeric,
  created_at timestamptz,
  reviewed_by uuid,
  reviewed_by_name text,
  hired_caregiver_user_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.first_name,
    a.last_name,
    a.email,
    a.phone,
    a.status,
    a.desired_weekly_hours,
    a.created_at,
    a.reviewed_by,
    rp.display_name,
    a.hired_caregiver_user_id
  from public.job_applicants a
  left join public.user_profiles rp on rp.id = a.reviewed_by
  where a.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'applicants.read')
  order by a.created_at desc;
$$;

revoke all on function public.list_applicants(uuid) from public;
grant execute on function public.list_applicants(uuid) to authenticated;
revoke execute on function public.list_applicants(uuid) from anon;

-- Converts a reviewed applicant into a caregiver's profile: copies
-- their submitted availability onto caregiver_availability (replacing
-- whatever's there, since this is now their availability of record)
-- and their desired hours onto the membership's weekly target - the
-- "convert without duplicate entry" requirement. target_user_id must
-- already be an active member of the organization (i.e. they accepted
-- an invitation through the existing membership flow); this function
-- doesn't create accounts or send invitations itself, since that's a
-- separate, already-solved problem (see accept_organization_invitation
-- / the invite-member edge function) and duplicating it here would be
-- a second, divergent way to add a member to an org.
create or replace function public.convert_applicant_to_caregiver(
  target_organization_id uuid,
  target_applicant_id uuid,
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  applicant_row public.job_applicants;
begin
  if not public.has_permission(target_organization_id, 'applicants.update') then
    raise exception 'You do not have permission to convert applicants for this organization';
  end if;

  select * into applicant_row
  from public.job_applicants
  where id = target_applicant_id and organization_id = target_organization_id;

  if not found then
    raise exception 'No applicant found for that organization';
  end if;

  if not exists (
    select 1 from public.organization_memberships
    where organization_id = target_organization_id
      and user_id = target_user_id
      and status = 'active'
  ) then
    raise exception 'That person must accept a membership invitation before their application can be converted';
  end if;

  delete from public.caregiver_availability
  where organization_id = target_organization_id and caregiver_user_id = target_user_id;

  insert into public.caregiver_availability (organization_id, caregiver_user_id, day_of_week, start_time, end_time)
  select target_organization_id, target_user_id, av.day_of_week, av.start_time, av.end_time
  from public.job_applicant_availability av
  where av.applicant_id = target_applicant_id;

  if applicant_row.desired_weekly_hours is not null then
    update public.organization_memberships
    set target_hours_per_week = applicant_row.desired_weekly_hours
    where organization_id = target_organization_id and user_id = target_user_id;
  end if;

  update public.job_applicants
  set status = 'hired',
      hired_caregiver_user_id = target_user_id,
      reviewed_by = auth.uid(),
      reviewed_at = now()
  where id = target_applicant_id;
end;
$$;

revoke all on function public.convert_applicant_to_caregiver(uuid, uuid, uuid) from public;
grant execute on function public.convert_applicant_to_caregiver(uuid, uuid, uuid) to authenticated;
revoke execute on function public.convert_applicant_to_caregiver(uuid, uuid, uuid) from anon;

commit;
