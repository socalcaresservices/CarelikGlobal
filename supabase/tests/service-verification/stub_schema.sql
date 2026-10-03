-- Minimal stand-in for the Supabase tables, types and helpers that the
-- Service Verification visit functions read (column names and types copied
-- from the production schema). Lets their logic be tested on plain
-- PostgreSQL without a full Supabase stack. SYNTHETIC data only.
--
-- auth.uid() reads the test.uid setting, so a test acts as a user with
-- `set test.uid = '<uuid>'`. has_permission() grants every permission to
-- active owner/manager memberships and none to caregivers, matching how the
-- visit functions use visits.manage / visits.read.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;

create type public.client_status as enum ('active', 'inactive', 'discharged');
create type public.membership_status as enum ('invited', 'active', 'suspended', 'revoked');
create type public.organization_status as enum ('active', 'suspended', 'closed');
create type public.system_role as enum ('platform_owner', 'organization_owner', 'organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'caregiver', 'read_only');
create type public.service_visit_status as enum ('draft', 'awaiting_signature', 'signed', 'administrator_review', 'corrected', 'voided');
create type public.visit_authorization_status as enum ('within_authorization', 'limit_reached', 'exceeds_authorization', 'administrator_override');
create type public.visit_signer_role as enum ('client', 'parent', 'guardian', 'authorized_representative');
create type public.shift_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');
create type public.shift_coverage_event_type as enum ('called_out', 'reassigned', 'cancelled');

create table public.organizations (
  id uuid primary key, slug text not null, status public.organization_status not null default 'active',
  timezone text default 'America/Los_Angeles'
);
create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  user_id uuid not null, role public.system_role not null, status public.membership_status not null default 'active'
);
create table public.user_profiles (id uuid primary key, display_name text);
create table public.clients (
  id uuid primary key, organization_id uuid not null references public.organizations(id),
  first_name text not null default 'Client', last_name text not null default 'Synthetic',
  client_code text, caregiver_display_code text,
  status public.client_status not null default 'active', deleted_at timestamptz
);
create table public.services (
  id uuid primary key, organization_id uuid not null references public.organizations(id),
  name text not null, code text, color text, is_active boolean not null default true, deleted_at timestamptz
);
create table public.client_authorizations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null,
  service_id uuid, max_monthly_hours numeric not null, period_start date not null, period_end date not null,
  is_current boolean not null default true, deleted_at timestamptz
);
create table public.caregiver_assignments (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, caregiver_user_id uuid not null,
  client_id uuid not null, service_id uuid, effective_start date not null, effective_end date,
  is_active boolean not null default true, created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.caregiver_records (
  id uuid primary key, organization_id uuid not null, linked_user_id uuid,
  first_name text not null, last_name text not null, preferred_name text,
  status text not null default 'active', deleted_at timestamptz, updated_at timestamptz not null default now()
);
create table public.shifts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null,
  caregiver_user_id uuid, caregiver_record_id uuid, service_id uuid,
  starts_at timestamptz not null, ends_at timestamptz not null,
  status public.shift_status not null default 'scheduled',
  created_by uuid, updated_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.shift_coverage_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, shift_id uuid not null references public.shifts(id),
  event_type public.shift_coverage_event_type not null, created_at timestamptz not null default now()
);
create table public.service_visits (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null,
  client_code_snapshot text, caregiver_user_id uuid, caregiver_name_snapshot text,
  scheduled_shift_id uuid references public.shifts(id), service_authorization_id uuid, service_id uuid not null,
  service_date date not null, time_in timestamptz not null, time_out timestamptz,
  worked_minutes integer, verified_minutes integer, billable_minutes integer,
  task_categories text[] not null default '{}', service_notes text, caregiver_attested_at timestamptz,
  status public.service_visit_status not null default 'draft',
  authorization_status public.visit_authorization_status,
  signed_at timestamptz, locked_at timestamptz, original_visit_id uuid, correction_reason text,
  voided_at timestamptz, voided_by uuid, void_reason text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  visit_number_snapshot text, caregiver_record_id uuid
);
-- Production index (20260809042943): one live visit per scheduled shift.
create unique index service_visits_shift_unique
  on public.service_visits (scheduled_shift_id)
  where scheduled_shift_id is not null and status not in ('voided', 'corrected');
create index service_visits_one_draft_per_caregiver on public.service_visits (caregiver_user_id);
create table public.visit_signatures (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, visit_id uuid not null,
  signed_visit_snapshot jsonb
);
create table public.audit_logs (
  id bigserial primary key, organization_id uuid, actor_user_id uuid, action text not null,
  entity_type text, entity_id text, source text, reason text, metadata jsonb, occurred_at timestamptz not null default now()
);

create function public.organization_is_active(target_organization_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from public.organizations o where o.id = target_organization_id and o.status = 'active')
$$;
create function public.is_organization_member(target_organization_id uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_organization_id and m.user_id = auth.uid() and m.status = 'active'
  )
$$;
create function public.has_permission(target_organization_id uuid, permission_key text) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_organization_id and m.user_id = auth.uid() and m.status = 'active'
      and m.role in ('organization_owner', 'manager')
  )
$$;
-- Superseded v2 picker; the v3 migration only revokes access to it.
create function public.list_startable_shifts_for_client(uuid, uuid) returns setof uuid
language sql as $$ select null::uuid where false $$;
