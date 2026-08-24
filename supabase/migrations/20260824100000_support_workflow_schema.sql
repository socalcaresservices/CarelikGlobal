begin;

-- Support workflow MVP: separate support requests (tickets) from access grants.
-- This migration adds:
-- 1. support_requests table (describes problem, doesn't grant access)
-- 2. support_access_audit_log table (immutable log of all support access events)
-- 3. Updates to support_access_grants to add access_level and link to requests

-- 1. Create support_requests table
create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  description text,
  status text not null default 'open'
    check (status in ('open', 'in_review', 'resolved', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_support_requests_org
  on public.support_requests(organization_id, created_at desc);
create index idx_support_requests_creator
  on public.support_requests(created_by);

create trigger support_requests_set_updated_at
  before update on public.support_requests
  for each row execute function public.set_updated_at();

alter table public.support_requests enable row level security;

create policy "support_requests_readable_by_org_members"
  on public.support_requests for select
  to authenticated
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and status = 'active'
    )
    or (
      public.is_platform_owner() and exists (
        select 1 from public.support_access_grants
        where organization_id = support_requests.organization_id
          and grantee_user_id = auth.uid()
          and status in ('active', 'pending_approval')
      )
    )
  );

create policy "support_requests_creatable_by_org_members"
  on public.support_requests for insert
  to authenticated
  with check (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and status = 'active'
    )
  );

-- 2. Create support_access_audit_log table (immutable)
create table public.support_access_audit_log (
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references public.support_access_grants(id) on delete cascade,
  organization_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null
    check (event_type in ('login', 'write', 'revoke', 'expire', 'emergency')),
  resource_type text,
  action text check (action in ('INSERT', 'UPDATE', 'DELETE')),
  resource_id uuid,
  changes jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index idx_support_access_audit_grant
  on public.support_access_audit_log(grant_id);
create index idx_support_access_audit_org
  on public.support_access_audit_log(organization_id, created_at desc);
create index idx_support_access_audit_event
  on public.support_access_audit_log(event_type, created_at desc);

alter table public.support_access_audit_log enable row level security;

create policy "audit_log_readable_by_org_and_grantee"
  on public.support_access_audit_log for select
  to authenticated
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and status = 'active'
    )
    or user_id = auth.uid()
  );

-- Immutable: no insert/update/delete policies (only via triggers/RPCs)

-- 3. Update support_access_grants table
-- Add fields for MVP workflow
alter table public.support_access_grants
  add column if not exists access_level text
    default 'read_only'
    check (access_level in ('read_only', 'edit')),
  add column if not exists request_id uuid references public.support_requests(id) on delete set null,
  add column if not exists emergency boolean default false;

-- Update enum if needed (add new statuses)
-- Note: This changes the existing enum; migrations must maintain backward compat
-- For now, we treat old 'requested'→'pending_approval', old 'denied'→'rejected'
-- But since we're already live, we add new statuses via CHECK constraint validation

-- Drop old policies and recreate with new logic
drop policy if exists "read_support_access_grants" on public.support_access_grants;

create policy "support_access_grants_readable"
  on public.support_access_grants for select
  to authenticated
  using (
    grantee_user_id = auth.uid()
    or public.is_platform_owner()
    or public.has_permission(organization_id, 'settings.read')
  );

-- Maintain existing RLS for insert (unchanged—only via RPCs)

commit;
