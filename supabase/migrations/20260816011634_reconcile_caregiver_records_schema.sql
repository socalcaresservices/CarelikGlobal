begin;

create extension if not exists citext;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'availability_preference') then
    create type public.availability_preference as enum ('available', 'preferred');
  end if;
end $$;

create table if not exists public.caregiver_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  applicant_id uuid references public.job_applicants(id) on delete set null,
  linked_user_id uuid references auth.users(id),
  first_name text not null,
  middle_name text,
  last_name text not null,
  preferred_name text,
  email extensions.citext,
  phone text,
  alternate_phone text,
  address_street text,
  address_line2 text,
  address_city text,
  address_state text,
  address_zip text,
  address_country text not null default 'US',
  employment_type text,
  available_start_date date,
  desired_weekly_hours numeric,
  min_weekly_hours numeric,
  max_weekly_hours numeric,
  min_shift_hours numeric,
  max_shift_hours numeric,
  max_travel_minutes integer,
  transportation_method text,
  reliable_transportation boolean,
  willing_to_transport_clients boolean,
  valid_drivers_license boolean,
  vehicle_available boolean,
  auto_insurance boolean,
  languages text[] not null default '{}',
  status text not null default 'active' check (status = any (array['onboarding', 'ready', 'active', 'inactive'])),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  onboarding_status text,
  onboarding_scheduled_at timestamptz,
  onboarding_method text,
  onboarding_location text,
  onboarding_instructions text,
  onboarding_notes text,
  background_check_status text,
  compliance_status text,
  onboarding_completed_at timestamptz
);

create table if not exists public.caregiver_record_availability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_record_id uuid not null references public.caregiver_records(id) on delete cascade,
  day_of_week public.weekday not null,
  start_time time not null,
  end_time time not null,
  preference public.availability_preference not null default 'available',
  created_at timestamptz not null default now(),
  constraint caregiver_record_availability_order check (end_time > start_time)
);

create table if not exists public.caregiver_record_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_record_id uuid not null references public.caregiver_records(id) on delete cascade,
  source_candidate_credential_id uuid references public.candidate_credentials(id) on delete set null,
  credential_type text not null,
  issue_date date,
  expiration_date date,
  does_not_expire boolean not null default false,
  issuing_organization text,
  credential_number text,
  verification_status text not null default 'unverified',
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists caregiver_records_org_idx on public.caregiver_records (organization_id);
create index if not exists caregiver_records_linked_user_idx on public.caregiver_records (linked_user_id);
create index if not exists caregiver_record_availability_record_idx on public.caregiver_record_availability (caregiver_record_id);
create index if not exists caregiver_record_credentials_record_idx on public.caregiver_record_credentials (caregiver_record_id);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'caregiver_records_set_updated_at') then
    create trigger caregiver_records_set_updated_at
    before update on public.caregiver_records
    for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'caregiver_records_audit') then
    create trigger caregiver_records_audit
    after insert or update or delete on public.caregiver_records
    for each row execute function public.write_audit_log();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'caregiver_record_credentials_set_updated_at') then
    create trigger caregiver_record_credentials_set_updated_at
    before update on public.caregiver_record_credentials
    for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'caregiver_record_credentials_audit') then
    create trigger caregiver_record_credentials_audit
    after insert or update or delete on public.caregiver_record_credentials
    for each row execute function public.write_audit_log();
  end if;
end $$;

alter table public.caregiver_records enable row level security;
alter table public.caregiver_record_availability enable row level security;
alter table public.caregiver_record_credentials enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'caregiver_records' and policyname = 'authorized_read_caregiver_records') then
    create policy "authorized_read_caregiver_records"
    on public.caregiver_records for select
    to authenticated
    using (deleted_at is null and (public.has_permission(organization_id, 'membership.read') or linked_user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'caregiver_records' and policyname = 'authorized_manage_caregiver_records') then
    create policy "authorized_manage_caregiver_records"
    on public.caregiver_records for all
    to authenticated
    using (public.has_permission(organization_id, 'membership.update'))
    with check (public.has_permission(organization_id, 'membership.update'));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'caregiver_record_availability' and policyname = 'authorized_read_caregiver_record_availability') then
    create policy "authorized_read_caregiver_record_availability"
    on public.caregiver_record_availability for select
    to authenticated
    using (
      public.has_permission(organization_id, 'membership.read')
      or exists (
        select 1 from public.caregiver_records cr
        where cr.id = caregiver_record_availability.caregiver_record_id and cr.linked_user_id = auth.uid()
      )
    );
  end if;
  if not exists (select 1 from pg_policies where tablename = 'caregiver_record_availability' and policyname = 'authorized_manage_caregiver_record_availability') then
    create policy "authorized_manage_caregiver_record_availability"
    on public.caregiver_record_availability for all
    to authenticated
    using (public.has_permission(organization_id, 'membership.update'))
    with check (public.has_permission(organization_id, 'membership.update'));
  end if;

  if not exists (select 1 from pg_policies where tablename = 'caregiver_record_credentials' and policyname = 'authorized_read_caregiver_record_credentials') then
    create policy "authorized_read_caregiver_record_credentials"
    on public.caregiver_record_credentials for select
    to authenticated
    using (
      deleted_at is null and (
        public.has_permission(organization_id, 'credentials.read')
        or exists (
          select 1 from public.caregiver_records cr
          where cr.id = caregiver_record_credentials.caregiver_record_id and cr.linked_user_id = auth.uid()
        )
      )
    );
  end if;
  if not exists (select 1 from pg_policies where tablename = 'caregiver_record_credentials' and policyname = 'authorized_manage_caregiver_record_credentials') then
    create policy "authorized_manage_caregiver_record_credentials"
    on public.caregiver_record_credentials for all
    to authenticated
    using (public.has_permission(organization_id, 'credentials.update'))
    with check (public.has_permission(organization_id, 'credentials.update'));
  end if;
end $$;

commit;
