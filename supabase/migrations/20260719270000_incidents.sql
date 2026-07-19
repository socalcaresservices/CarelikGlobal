begin;

-- Incident tracking: falls, medication errors, injuries, and anything
-- else that needs a record and a review. category is free text for the
-- same reason credential_type/payer are - agencies categorize incidents
-- differently. severity and status are workflow concepts (not business
-- content an agency defines for itself), so those stay as enums.

create type public.incident_severity as enum ('low', 'medium', 'high');
create type public.incident_status as enum ('open', 'under_review', 'resolved');

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  caregiver_user_id uuid references auth.users(id),
  shift_id uuid references public.shifts(id) on delete set null,
  occurred_at timestamptz not null default now(),
  category text not null,
  severity public.incident_severity not null default 'medium',
  status public.incident_status not null default 'open',
  description text not null,
  reported_by uuid references auth.users(id),
  resolution_notes text,
  resolved_at timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index incidents_org_idx on public.incidents (organization_id) where deleted_at is null;
create index incidents_status_idx on public.incidents (organization_id, status) where deleted_at is null;
create index incidents_reported_by_idx on public.incidents (reported_by);
create index incidents_client_idx on public.incidents (client_id);
create index incidents_caregiver_idx on public.incidents (caregiver_user_id);

create trigger incidents_set_updated_at
before update on public.incidents
for each row execute function public.set_updated_at();

create trigger incidents_audit
after insert or update or delete on public.incidents
for each row execute function public.write_audit_log();

alter table public.incidents enable row level security;

-- A caregiver can always see an incident they filed, even without
-- org-wide incidents.read - same own-row shape used by shifts/credentials.
create policy "members_read_incidents"
on public.incidents for select
to authenticated
using (
  deleted_at is null
  and (
    public.has_permission(organization_id, 'incidents.read')
    or reported_by = auth.uid()
  )
);

-- Filing an incident is a lower bar than managing them: incidents.create
-- lets any authorized staff member report something, but they can only
-- file it as themselves. incidents.update (checked via the OR below)
-- covers the manager/coordinator case of logging an incident on behalf
-- of someone else.
create policy "authorized_create_incidents"
on public.incidents for insert
to authenticated
with check (
  (
    public.has_permission(organization_id, 'incidents.create')
    and reported_by = auth.uid()
  )
  or public.has_permission(organization_id, 'incidents.update')
);

create policy "authorized_manage_incidents"
on public.incidents for update
to authenticated
using (public.has_permission(organization_id, 'incidents.update'))
with check (public.has_permission(organization_id, 'incidents.update'));

create policy "authorized_delete_incidents"
on public.incidents for delete
to authenticated
using (public.has_permission(organization_id, 'incidents.update'));

insert into public.permissions (key, description) values
  ('incidents.read', 'View every incident report in the organization'),
  ('incidents.create', 'File a new incident report'),
  ('incidents.update', 'Edit, resolve, and remove incident reports');

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
  where key in ('incidents.read', 'incidents.create', 'incidents.update')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('staff', 'incidents.create'),
  ('read_only', 'incidents.read');

-- Joins client/caregiver/reporter names, same shape as list_shifts() -
-- user_profiles RLS only allows reading your own row. Visibility mirrors
-- the table RLS: org-wide with incidents.read, or just what you reported.
create or replace function public.list_incidents(target_organization_id uuid)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  caregiver_user_id uuid,
  caregiver_name text,
  occurred_at timestamptz,
  category text,
  severity public.incident_severity,
  status public.incident_status,
  description text,
  reported_by uuid,
  reported_by_name text,
  resolution_notes text,
  resolved_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.client_id,
    c.first_name || ' ' || c.last_name,
    i.caregiver_user_id,
    cg.display_name,
    i.occurred_at,
    i.category,
    i.severity,
    i.status,
    i.description,
    i.reported_by,
    coalesce(rp.display_name, 'Unknown member'),
    i.resolution_notes,
    i.resolved_at
  from public.incidents i
  left join public.clients c on c.id = i.client_id
  left join public.user_profiles cg on cg.id = i.caregiver_user_id
  left join public.user_profiles rp on rp.id = i.reported_by
  where i.organization_id = target_organization_id
    and i.deleted_at is null
    and (
      public.has_permission(target_organization_id, 'incidents.read')
      or i.reported_by = auth.uid()
    )
  order by i.occurred_at desc;
$$;

revoke all on function public.list_incidents(uuid) from public;
grant execute on function public.list_incidents(uuid) to authenticated;
revoke execute on function public.list_incidents(uuid) from anon;

commit;
