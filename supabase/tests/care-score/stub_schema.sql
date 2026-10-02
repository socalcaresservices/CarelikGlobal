-- Minimal stand-in for the Supabase tables/types that
-- public._score_caregiver_matches reads (column names and types copied
-- from supabase/migrations). Lets the scorer's logic be tested on plain
-- PostgreSQL without a full Supabase stack. SYNTHETIC data only.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create type public.weekday as enum ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday');
create type public.shift_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');
create type public.incident_status as enum ('open', 'under_review', 'resolved');
create type public.availability_preference as enum ('available', 'preferred');
create schema if not exists auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create table public.organizations (id uuid primary key, timezone text not null default 'America/Los_Angeles');
create type public.client_status as enum ('active', 'inactive', 'discharged');
create type public.service_visit_status as enum ('draft', 'awaiting_signature', 'signed', 'administrator_review', 'corrected', 'voided');
create table public.services (id uuid primary key, organization_id uuid not null, name text not null default 'Service', deleted_at timestamptz);
create table public.clients (
  id uuid primary key, organization_id uuid not null,
  address_zip text, address_city text, address_state text,
  language_needs text[] not null default '{}', care_needs text[] not null default '{}',
  deleted_at timestamptz,
  first_name text not null default 'Client', last_name text not null default 'Synthetic',
  client_code text, caregiver_display_code text, status public.client_status not null default 'active'
);
create table public.client_requested_schedule (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null,
  day_of_week public.weekday not null, start_time time not null, end_time time not null,
  service_id uuid, notes text, created_by uuid,
  constraint client_requested_schedule_time_order check (end_time > start_time)
);
create table public.user_profiles (id uuid primary key, skills text[] not null default '{}', display_name text);
create table public.caregiver_records (
  id uuid primary key, organization_id uuid not null, linked_user_id uuid references public.user_profiles(id),
  first_name text not null, last_name text not null, preferred_name text,
  address_zip text, address_city text, address_state text,
  languages text[] not null default '{}', desired_weekly_hours numeric,
  status text not null default 'active', deleted_at timestamptz
);
create table public.caregiver_record_availability (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, caregiver_record_id uuid not null,
  day_of_week public.weekday not null, start_time time not null, end_time time not null,
  preference public.availability_preference not null default 'available',
  constraint caregiver_record_availability_order check (end_time > start_time)
);
create table public.shifts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null,
  caregiver_record_id uuid, starts_at timestamptz not null, ends_at timestamptz not null,
  status public.shift_status not null default 'scheduled',
  source_requested_schedule_id uuid,
  service_id uuid
);
create table public.client_authorizations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null, service_id uuid not null,
  max_monthly_hours numeric, period_start date not null, period_end date not null,
  is_current boolean not null default true, version_number int not null default 1, deleted_at timestamptz
);
create table public.client_requested_services (organization_id uuid not null, client_id uuid not null, service_id uuid not null);
create table public.service_visits (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null, service_id uuid,
  service_date date not null, status public.service_visit_status not null,
  worked_minutes int, verified_minutes int, billable_minutes int
);
create table public.caregiver_assignments (
  organization_id uuid not null, caregiver_user_id uuid, client_id uuid not null, service_id uuid,
  is_active boolean not null default true, effective_start date not null, effective_end date
);
create table public.client_service_gap_reviews (
  organization_id uuid not null, client_id uuid not null, service_id uuid not null, month_start date not null,
  reason text, notes text, resolved boolean
);
create table public.incidents (
  id uuid primary key default gen_random_uuid(), client_id uuid, caregiver_user_id uuid,
  status public.incident_status not null default 'open'
);
create function public.has_permission(org uuid, perm text) returns boolean language sql stable as $$ select true $$;
