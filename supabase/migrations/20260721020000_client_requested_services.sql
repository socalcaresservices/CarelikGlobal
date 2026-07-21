begin;

-- Client requested services: a lightweight many-to-many between clients
-- and services, distinct from client_authorizations - this records
-- "the client has asked for / needs this service" with no hours or
-- payer attached, versus an authorization which is a payer's approval
-- for a specific number of hours per month. A client can request a
-- service before (or without ever having) an authorization for it.
-- Rows are pure add/remove, never edited in place, so there's no
-- updated_at/updated_by - only who requested it and when. Access
-- reuses clients.read/clients.update rather than new permission keys,
-- since this is part of the client record, not a separate concept.
create table public.client_requested_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create unique index client_requested_services_unique
  on public.client_requested_services (client_id, service_id);
create index client_requested_services_client_idx on public.client_requested_services (client_id);
create index client_requested_services_org_idx on public.client_requested_services (organization_id);

create trigger client_requested_services_audit
after insert or update or delete on public.client_requested_services
for each row execute function public.write_audit_log();

alter table public.client_requested_services enable row level security;

create policy "members_read_client_requested_services"
on public.client_requested_services for select
to authenticated
using (public.has_permission(organization_id, 'clients.read'));

create policy "authorized_manage_client_requested_services"
on public.client_requested_services for all
to authenticated
using (public.has_permission(organization_id, 'clients.update'))
with check (public.has_permission(organization_id, 'clients.update'));

commit;
