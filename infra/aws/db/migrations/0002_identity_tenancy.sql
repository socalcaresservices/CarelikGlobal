-- 0002 - Identity, organizations, memberships, permissions, request context.
--
-- Replaces Supabase auth.users / auth.uid(). The API (Phase 4) verifies the
-- Cognito JWT, then opens a transaction and calls
--   select ogevia_api.begin_request(<cognito sub>, <request uuid>);
-- which resolves the sub to an app_users row and stores the actor in
-- transaction-local settings. ogevia.current_user_id() reads it back. A
-- missing or unknown identity yields NULL and every API function rejects it.

create type ogevia.organization_status as enum ('active', 'suspended', 'closed');
create type ogevia.membership_status as enum ('invited', 'active', 'suspended', 'revoked');
-- Mirrors public.system_role (platform_foundation + add_caregiver_role +
-- add_scheduler_system_role). Legacy values are kept so migrated rows load.
create type ogevia.system_role as enum (
  'platform_owner', 'organization_owner', 'organization_admin', 'manager',
  'scheduler', 'coordinator', 'staff', 'caregiver', 'read_only'
);

create table ogevia.app_users (
  id uuid primary key default gen_random_uuid(),
  -- Cognito `sub` (UUID string). NULL until the user is linked in Phase 3.
  cognito_sub text unique,
  display_name text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_users_cognito_sub_format check (
    cognito_sub is null or cognito_sub ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);

create table ogevia.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name text not null,
  status ogevia.organization_status not null default 'active',
  timezone text not null default 'America/Los_Angeles',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ogevia.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  user_id uuid not null references ogevia.app_users(id),
  role ogevia.system_role not null check (role <> 'platform_owner'),
  status ogevia.membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_memberships_user_idx on ogevia.organization_memberships (user_id);

create table ogevia.permissions (
  key text primary key,
  description text not null
);

create table ogevia.role_permissions (
  role ogevia.system_role not null,
  permission_key text not null references ogevia.permissions(key),
  primary key (role, permission_key)
);

-- Service Verification permissions and their FINAL current-main grants
-- (streamlined_access_model 20260817054716, billing_visits_permission_split,
-- separate_manager_operational_access_from_financial_data,
-- grant_owner_operational_billing_visit_access). Other permission keys are
-- migrated with the rest of role_permissions (PHASE_2_DATA_MIGRATION_PLAN.md).
insert into ogevia.permissions (key, description) values
  ('visits.read', 'View service verification records'),
  ('visits.manage', 'Review, correct, and manage service verification records'),
  ('authorizations.read', 'View client authorizations'),
  ('authorizations.update', 'Create and amend client authorizations'),
  ('billing.visits.read', 'View billing-ready visits'),
  ('billing.approve', 'Approve visits for billing');

insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'visits.read'),
  ('organization_owner', 'visits.manage'),
  ('organization_owner', 'authorizations.read'),
  ('organization_owner', 'authorizations.update'),
  ('organization_owner', 'billing.visits.read'),
  ('organization_owner', 'billing.approve'),
  ('manager', 'visits.read'),
  ('manager', 'visits.manage'),
  ('manager', 'authorizations.read'),
  ('manager', 'authorizations.update'),
  ('manager', 'billing.visits.read'),
  ('manager', 'billing.approve'),
  ('scheduler', 'visits.read'),
  ('scheduler', 'authorizations.read');

-- ---------------------------------------------------------------------------
-- Request context
-- ---------------------------------------------------------------------------

create function ogevia.current_user_id()
returns uuid
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select nullif(current_setting('ogevia.actor_user_id', true), '')::uuid;
$$;

create function ogevia.current_request_id()
returns uuid
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select nullif(current_setting('ogevia.request_id', true), '')::uuid;
$$;

create function ogevia_api.begin_request(p_cognito_sub text, p_request_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  actor uuid;
begin
  if p_cognito_sub is null or btrim(p_cognito_sub) = '' then
    raise exception 'Not authenticated' using errcode = 'OGA01';
  end if;
  select u.id into actor
  from ogevia.app_users u
  where u.cognito_sub = p_cognito_sub and u.status = 'active';
  if actor is null then
    raise exception 'Not authenticated' using errcode = 'OGA01';
  end if;
  -- is_local = true: the context ends with the transaction, so a pooled
  -- connection can never carry one caller's identity into another request.
  perform set_config('ogevia.actor_user_id', actor::text, true);
  perform set_config('ogevia.request_id', coalesce(p_request_id, gen_random_uuid())::text, true);
  return actor;
end;
$$;

create function ogevia.require_actor()
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  actor uuid := ogevia.current_user_id();
begin
  if actor is null then
    raise exception 'Not authenticated' using errcode = 'OGA01';
  end if;
  return actor;
end;
$$;

create function ogevia.organization_is_active(p_organization_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1 from ogevia.organizations
    where id = p_organization_id and status = 'active'
  );
$$;

-- Active member of an ACTIVE organization. Unlike current main, there is no
-- platform-owner bypass: cross-tenant support access is a separate, later,
-- explicitly audited design (PHASE_2_RPC_PARITY_MATRIX.md).
create function ogevia.is_active_member(p_organization_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1
    from ogevia.organization_memberships m
    join ogevia.organizations o on o.id = m.organization_id
    where m.organization_id = p_organization_id
      and m.user_id = ogevia.current_user_id()
      and m.status = 'active'
      and o.status = 'active'
  );
$$;

create function ogevia.has_permission(p_organization_id uuid, p_permission text)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1
    from ogevia.organization_memberships m
    join ogevia.role_permissions rp on rp.role = m.role
    join ogevia.organizations o on o.id = m.organization_id
    where m.organization_id = p_organization_id
      and m.user_id = ogevia.current_user_id()
      and m.status = 'active'
      and o.status = 'active'
      and rp.permission_key = p_permission
  );
$$;

create function ogevia.is_active_caregiver(p_organization_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1
    from ogevia.organization_memberships m
    join ogevia.organizations o on o.id = m.organization_id
    where m.organization_id = p_organization_id
      and m.user_id = ogevia.current_user_id()
      and m.status = 'active'
      and m.role = 'caregiver'
      and o.status = 'active'
  );
$$;

create function ogevia.organization_local_date(p_organization_id uuid, p_at timestamptz)
returns date
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select (p_at at time zone coalesce(
    (select timezone from ogevia.organizations where id = p_organization_id),
    'America/Los_Angeles'
  ))::date;
$$;
