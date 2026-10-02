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
create table public.clients (
  id uuid primary key, organization_id uuid not null,
  address_zip text, address_city text, address_state text,
  language_needs text[] not null default '{}', care_needs text[] not null default '{}'
);
create table public.client_requested_schedule (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null,
  day_of_week public.weekday not null, start_time time not null, end_time time not null
);
create table public.user_profiles (id uuid primary key, skills text[] not null default '{}');
create table public.caregiver_records (
  id uuid primary key, organization_id uuid not null, linked_user_id uuid references public.user_profiles(id),
  first_name text not null, last_name text not null, preferred_name text,
  address_zip text, address_city text, address_state text,
  languages text[] not null default '{}', desired_weekly_hours numeric,
  status text not null default 'active', deleted_at timestamptz
);
create table public.caregiver_record_availability (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, caregiver_record_id uuid not null,
  day_of_week public.weekday not null, start_time time not null, end_time time not null
);
create table public.shifts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, client_id uuid not null,
  caregiver_record_id uuid, starts_at timestamptz not null, ends_at timestamptz not null,
  status public.shift_status not null default 'scheduled'
);
create table public.incidents (
  id uuid primary key default gen_random_uuid(), client_id uuid, caregiver_user_id uuid,
  status public.incident_status not null default 'open'
);
create function public.has_permission(org uuid, perm text) returns boolean language sql stable as $$ select true $$;
