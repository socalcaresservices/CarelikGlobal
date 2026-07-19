begin;

-- Caregiver credentials: certifications, background checks, licenses -
-- whatever an agency needs to track expiration on for a caregiver.
-- credential_type is free text rather than an enum because compliance
-- requirements vary a lot by state/agency and inventing a fixed list
-- would be guessing at business rules nobody has confirmed. expires_at
-- is nullable because not every credential expires (e.g. a one-time
-- background check some agencies never re-run).
--
-- Status (active / expiring soon / expired / no expiration) is derived
-- at read time, not stored - storing it would drift out of date the
-- moment nobody looks at the row.

create table public.caregiver_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_user_id uuid not null references auth.users(id),
  credential_type text not null,
  issued_date date,
  expires_at date,
  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index caregiver_credentials_org_idx on public.caregiver_credentials (organization_id) where deleted_at is null;
create index caregiver_credentials_caregiver_idx on public.caregiver_credentials (caregiver_user_id) where deleted_at is null;
create index caregiver_credentials_expires_at_idx on public.caregiver_credentials (expires_at) where deleted_at is null;

create trigger caregiver_credentials_set_updated_at
before update on public.caregiver_credentials
for each row execute function public.set_updated_at();

create trigger caregiver_credentials_audit
after insert or update or delete on public.caregiver_credentials
for each row execute function public.write_audit_log();

alter table public.caregiver_credentials enable row level security;

-- Same own-row carve-out as shifts: a caregiver can always see their own
-- credentials even without the org-wide credentials.read permission.
create policy "members_read_credentials"
on public.caregiver_credentials for select
to authenticated
using (
  deleted_at is null
  and (
    public.has_permission(organization_id, 'credentials.read')
    or caregiver_user_id = auth.uid()
  )
);

create policy "authorized_manage_credentials"
on public.caregiver_credentials for all
to authenticated
using (public.has_permission(organization_id, 'credentials.update'))
with check (public.has_permission(organization_id, 'credentials.update'));

insert into public.permissions (key, description) values
  ('credentials.read', 'View every caregiver credential in the organization'),
  ('credentials.update', 'Add, edit, and remove caregiver credentials');

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
  where key in ('credentials.read', 'credentials.update')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('read_only', 'credentials.read');

-- Joins caregiver_name for display, same shape as list_shifts()/
-- list_audit_logs() - user_profiles RLS only allows reading your own
-- row, so a plain client-side join can't show other caregivers' names.
-- Visibility mirrors the table RLS: org-wide with credentials.read, or
-- just your own credentials.
create or replace function public.list_caregiver_credentials(target_organization_id uuid)
returns table (
  id uuid,
  caregiver_user_id uuid,
  caregiver_name text,
  credential_type text,
  issued_date date,
  expires_at date,
  notes text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.caregiver_user_id,
    coalesce(p.display_name, 'Unknown member'),
    c.credential_type,
    c.issued_date,
    c.expires_at,
    c.notes,
    c.created_at
  from public.caregiver_credentials c
  join public.user_profiles p on p.id = c.caregiver_user_id
  where c.organization_id = target_organization_id
    and c.deleted_at is null
    and (
      public.has_permission(target_organization_id, 'credentials.read')
      or c.caregiver_user_id = auth.uid()
    )
  order by c.expires_at nulls last, c.credential_type;
$$;

revoke all on function public.list_caregiver_credentials(uuid) from public;
grant execute on function public.list_caregiver_credentials(uuid) to authenticated;
revoke execute on function public.list_caregiver_credentials(uuid) from anon;

commit;
