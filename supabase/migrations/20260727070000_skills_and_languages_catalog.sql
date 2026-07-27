begin;

-- Skills and languages catalog: same problem services.sql (Build 003)
-- solved for the service catalog, applied here. Today caregiver skills
-- (user_profiles.skills), client care needs (clients.care_needs),
-- caregiver languages (user_profiles.languages), and client language
-- needs (clients.language_needs) are all free-typed text[] with no
-- shared vocabulary - "CPR" vs "cpr certified" vs "CPR Certified" all
-- read as different values to list_caregiver_matches()'s exact-string
-- overlap, silently costing a caregiver CareScore points for a typo.
--
-- Deliberately NOT converting those four columns to foreign keys or
-- uuid[] - list_caregiver_matches() (20260719280000) already works
-- correctly on text overlap, and converting both the caregiver side and
-- the client side to referential integrity at once is exactly the
-- "two-sided design problem" flagged in docs/PRODUCT_CONSTITUTION.md's
-- audit section as needing its own scoped build. This build solves the
-- actual reported problem - no canonical vocabulary, so no way to stop
-- typos - by giving every organization a picker sourced from its own
-- configured list. The four text[] columns keep storing names (now
-- names chosen from a picker instead of hand-typed), so
-- list_caregiver_matches() needs zero changes and keeps working exactly
-- as before, just with cleaner input going forward.
create table public.skills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index skills_org_name_unique
  on public.skills (organization_id, lower(name))
  where deleted_at is null;

create index skills_org_idx on public.skills (organization_id) where deleted_at is null;

create table public.languages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index languages_org_name_unique
  on public.languages (organization_id, lower(name))
  where deleted_at is null;

create index languages_org_idx on public.languages (organization_id) where deleted_at is null;

create trigger skills_set_updated_at
before update on public.skills
for each row execute function public.set_updated_at();

create trigger skills_audit
after insert or update or delete on public.skills
for each row execute function public.write_audit_log();

create trigger languages_set_updated_at
before update on public.languages
for each row execute function public.set_updated_at();

create trigger languages_audit
after insert or update or delete on public.languages
for each row execute function public.write_audit_log();

alter table public.skills enable row level security;
alter table public.languages enable row level security;

create policy "members_read_skills"
on public.skills for select
to authenticated
using (deleted_at is null and public.has_permission(organization_id, 'skills.read'));

create policy "authorized_manage_skills"
on public.skills for all
to authenticated
using (public.has_permission(organization_id, 'skills.update'))
with check (public.has_permission(organization_id, 'skills.update'));

create policy "members_read_languages"
on public.languages for select
to authenticated
using (deleted_at is null and public.has_permission(organization_id, 'languages.read'));

create policy "authorized_manage_languages"
on public.languages for all
to authenticated
using (public.has_permission(organization_id, 'languages.update'))
with check (public.has_permission(organization_id, 'languages.update'));

insert into public.permissions (key, description) values
  ('skills.read', 'View the organization''s configured skills'),
  ('skills.update', 'Add, edit, and remove configured skills'),
  ('languages.read', 'View the organization''s configured languages'),
  ('languages.update', 'Add, edit, and remove configured languages');

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
  where key in ('skills.read', 'skills.update', 'languages.read', 'languages.update')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('read_only', 'skills.read'),
  ('read_only', 'languages.read'),
  -- Caregivers pick their own skills/languages on their profile (same
  -- self-edit carve-out set_caregiver_profile already grants), so they
  -- need read access to the catalog to populate the picker.
  ('caregiver', 'skills.read'),
  ('caregiver', 'languages.read');

-- Backfill: every distinct skill/language string already in use gets a
-- real row, per organization, so existing data shows up correctly in
-- the new pickers instead of looking like it vanished. Caregiver values
-- are backfilled per organization the caregiver is an active member of
-- (skills are org-scoped, and a caregiver can belong to more than one
-- organization); client values are backfilled to the client's own
-- organization.
insert into public.skills (organization_id, name)
select distinct m.organization_id, skill_name
from public.organization_memberships m
join public.user_profiles p on p.id = m.user_id
cross join lateral unnest(p.skills) as skill_name
where m.status = 'active'
on conflict do nothing;

insert into public.skills (organization_id, name)
select distinct c.organization_id, need_name
from public.clients c
cross join lateral unnest(c.care_needs) as need_name
on conflict do nothing;

insert into public.languages (organization_id, name)
select distinct m.organization_id, language_name
from public.organization_memberships m
join public.user_profiles p on p.id = m.user_id
cross join lateral unnest(p.languages) as language_name
where m.status = 'active'
on conflict do nothing;

insert into public.languages (organization_id, name)
select distinct c.organization_id, need_name
from public.clients c
cross join lateral unnest(c.language_needs) as need_name
on conflict do nothing;

commit;
