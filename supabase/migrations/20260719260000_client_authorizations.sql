begin;

-- Client authorizations: how many hours a payer has authorized for a
-- client over a period, so scheduling can be checked against it. payer
-- is free text (Medicaid, private pay, LTC insurance, a specific case
-- manager...) for the same reason credential_type is free text -
-- payer/program names vary too much to guess a fixed list. A client can
-- have multiple authorization rows over time (one per period), so this
-- doubles as a history, not just a single current value.

create table public.client_authorizations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  payer text not null,
  authorized_hours numeric not null,
  period_start date not null,
  period_end date not null,
  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint client_authorizations_period_check check (period_start < period_end),
  constraint client_authorizations_hours_check check (authorized_hours >= 0)
);

create index client_authorizations_org_idx on public.client_authorizations (organization_id) where deleted_at is null;
create index client_authorizations_client_idx on public.client_authorizations (client_id) where deleted_at is null;
create index client_authorizations_period_idx on public.client_authorizations (period_start, period_end);

create trigger client_authorizations_set_updated_at
before update on public.client_authorizations
for each row execute function public.set_updated_at();

create trigger client_authorizations_audit
after insert or update or delete on public.client_authorizations
for each row execute function public.write_audit_log();

alter table public.client_authorizations enable row level security;

-- No own-row carve-out here, unlike shifts/credentials - an authorization
-- isn't tied to a specific staff member the way a shift or credential is,
-- so visibility is a straight permission check, same shape as clients.
create policy "members_read_authorizations"
on public.client_authorizations for select
to authenticated
using (deleted_at is null and public.has_permission(organization_id, 'authorizations.read'));

create policy "authorized_manage_authorizations"
on public.client_authorizations for all
to authenticated
using (public.has_permission(organization_id, 'authorizations.update'))
with check (public.has_permission(organization_id, 'authorizations.update'));

insert into public.permissions (key, description) values
  ('authorizations.read', 'View client authorization hours and utilization'),
  ('authorizations.update', 'Add, edit, and remove client authorizations');

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
  where key in ('authorizations.read', 'authorizations.update')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('read_only', 'authorizations.read');

-- Joins client name and computes scheduled+completed shift hours that
-- fall within each authorization's own period, so utilization (gap
-- between authorized and actually scheduled) can be shown without a
-- second round trip. Same overlap-aware hour math as get_caregiver_hours.
create or replace function public.list_client_authorizations(target_organization_id uuid)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  payer text,
  authorized_hours numeric,
  period_start date,
  period_end date,
  notes text,
  scheduled_hours numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.client_id,
    c.first_name || ' ' || c.last_name,
    a.payer,
    a.authorized_hours,
    a.period_start,
    a.period_end,
    a.notes,
    coalesce(
      sum(
        extract(epoch from (
          least(s.ends_at, a.period_end::timestamptz + interval '1 day')
          - greatest(s.starts_at, a.period_start::timestamptz)
        )) / 3600.0
      ) filter (
        where s.id is not null
          and s.status in ('scheduled', 'completed')
          and s.starts_at < (a.period_end::timestamptz + interval '1 day')
          and s.ends_at > a.period_start::timestamptz
      ),
      0
    )
  from public.client_authorizations a
  join public.clients c on c.id = a.client_id
  left join public.shifts s
    on s.client_id = a.client_id
   and s.organization_id = a.organization_id
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and public.has_permission(target_organization_id, 'authorizations.read')
  group by a.id, c.first_name, c.last_name
  order by a.period_start desc;
$$;

revoke all on function public.list_client_authorizations(uuid) from public;
grant execute on function public.list_client_authorizations(uuid) to authenticated;
revoke execute on function public.list_client_authorizations(uuid) from anon;

commit;
