begin;

-- Caregiver scheduling: clients (the people receiving care) and shifts
-- (a caregiver assigned to a client for a time window). Follows the same
-- shape as every other org-scoped table so far - uuid id, organization_id
-- FK, created_by/updated_by, RLS gated by has_permission(), audited by
-- the existing generic write_audit_log() trigger (both tables have a
-- single uuid id and a real organization_id column, so they fit the
-- trigger's assumptions without any special-casing).

create type public.client_status as enum ('active', 'inactive', 'discharged');
create type public.shift_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  phone text,
  email text,
  address text,
  care_notes text,
  status public.client_status not null default 'active',
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  caregiver_user_id uuid not null references auth.users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.shift_status not null default 'scheduled',
  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shifts_time_check check (starts_at < ends_at)
);

create index clients_org_idx on public.clients (organization_id) where deleted_at is null;
create index shifts_org_starts_at_idx on public.shifts (organization_id, starts_at);
create index shifts_caregiver_starts_at_idx on public.shifts (caregiver_user_id, starts_at);
create index shifts_client_idx on public.shifts (client_id);

create trigger clients_set_updated_at
before update on public.clients
for each row execute function public.set_updated_at();

create trigger shifts_set_updated_at
before update on public.shifts
for each row execute function public.set_updated_at();

create trigger clients_audit
after insert or update or delete on public.clients
for each row execute function public.write_audit_log();

create trigger shifts_audit
after insert or update or delete on public.shifts
for each row execute function public.write_audit_log();

alter table public.clients enable row level security;
alter table public.shifts enable row level security;

create policy "members_read_clients"
on public.clients for select
to authenticated
using (deleted_at is null and public.has_permission(organization_id, 'clients.read'));

create policy "authorized_manage_clients"
on public.clients for all
to authenticated
using (public.has_permission(organization_id, 'clients.update'))
with check (public.has_permission(organization_id, 'clients.update'));

-- Staff can always see a shift they're assigned to, even without the
-- org-wide shifts.read permission - that's deliberate: caregivers need
-- to see their own schedule without being able to browse everyone else's.
create policy "members_read_shifts"
on public.shifts for select
to authenticated
using (
  public.has_permission(organization_id, 'shifts.read')
  or caregiver_user_id = auth.uid()
);

create policy "authorized_manage_shifts"
on public.shifts for all
to authenticated
using (public.has_permission(organization_id, 'shifts.update'))
with check (public.has_permission(organization_id, 'shifts.update'));

insert into public.permissions (key, description) values
  ('clients.read', 'View client records'),
  ('clients.update', 'Create, edit, and remove client records'),
  ('shifts.read', 'View every caregiver shift in the organization'),
  ('shifts.update', 'Create, edit, and cancel caregiver shifts');

insert into public.role_permissions (role, permission_key)
select role_value, new_permissions.key
from (
  values
    ('organization_owner'::public.system_role),
    ('organization_admin'::public.system_role)
) roles(role_value)
cross join (
  select key from public.permissions
  where key in ('clients.read', 'clients.update', 'shifts.read', 'shifts.update')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('manager', 'clients.read'),
  ('manager', 'clients.update'),
  ('manager', 'shifts.read'),
  ('manager', 'shifts.update'),
  ('coordinator', 'clients.read'),
  ('coordinator', 'clients.update'),
  ('coordinator', 'shifts.read'),
  ('coordinator', 'shifts.update'),
  ('staff', 'clients.read'),
  ('read_only', 'clients.read');

commit;
