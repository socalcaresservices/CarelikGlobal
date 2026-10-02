-- Minimal stand-in for the Supabase objects the incident migrations touch
-- (columns/types copied from supabase/migrations). SYNTHETIC data only.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-4000-8000-0000000000aa'::uuid $$;
create function public.has_permission(org uuid, perm text) returns boolean language sql stable as $$ select true $$;
create type public.incident_severity as enum ('low', 'medium', 'high');
create type public.incident_status as enum ('open', 'under_review', 'resolved');
create table public.clients (id uuid primary key, first_name text not null, last_name text not null);
create table public.user_profiles (id uuid primary key, display_name text);
create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid references public.clients(id),
  caregiver_user_id uuid,
  shift_id uuid,
  occurred_at timestamptz not null default now(),
  category text not null,
  severity public.incident_severity not null default 'medium',
  status public.incident_status not null default 'open',
  description text not null,
  reported_by uuid,
  resolution_notes text,
  resolved_at timestamptz,
  deleted_at timestamptz
);
-- An incident filed before the migration.
insert into public.incidents (id, organization_id, category, description)
values ('00000000-0000-4000-8000-0000000001a1', '00000000-0000-4000-8000-000000000001', 'Fall', 'synthetic pre-existing incident');
