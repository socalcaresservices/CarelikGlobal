begin;

-- Stage 3: incidents.category has always been free text ("Fall" vs
-- "fall" vs "Client fall" all reading as distinct values to any future
-- reporting/filtering), the same typo-vocabulary problem
-- 20260727070000_skills_and_languages_catalog.sql solved for skills and
-- languages. Same shape, same fix: an org-scoped catalog with a picker
-- sourced from it, reusing the existing incidents.read/incidents.update
-- permissions rather than adding new ones - a settings area for
-- something the audit specifically flagged as missing.
create table public.incident_types (
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

create unique index incident_types_org_name_unique
  on public.incident_types (organization_id, lower(name))
  where deleted_at is null;

create index incident_types_org_idx on public.incident_types (organization_id) where deleted_at is null;

create trigger incident_types_set_updated_at
before update on public.incident_types
for each row execute function public.set_updated_at();

create trigger incident_types_audit
after insert or update or delete on public.incident_types
for each row execute function public.write_audit_log();

alter table public.incident_types enable row level security;

-- Read is gated on incidents.read OR incidents.create, not read alone -
-- a plain caregiver (streamlined_access_model grants them
-- incidents.create only, never incidents.read) still needs to read this
-- catalog to populate their own "File an incident" category picker.
create policy "members_read_incident_types"
on public.incident_types for select
to authenticated
using (
  deleted_at is null
  and (
    public.has_permission(organization_id, 'incidents.read')
    or public.has_permission(organization_id, 'incidents.create')
  )
);

create policy "authorized_manage_incident_types"
on public.incident_types for all
to authenticated
using (public.has_permission(organization_id, 'incidents.update'))
with check (public.has_permission(organization_id, 'incidents.update'));

-- Backfill: every distinct category string already in use gets a real
-- row, per organization, so existing incidents' categories show up as
-- real picker options going forward instead of the catalog starting
-- empty under orgs that already have incident history.
insert into public.incident_types (organization_id, name)
select distinct i.organization_id, i.category
from public.incidents i
where i.deleted_at is null
on conflict do nothing;

commit;
