-- 0003 - Caregivers, clients, services, assignments, shifts (SV-relevant columns).
--
-- Data minimization: only the columns Service Verification reads are modeled.
-- Client legal names, DOB, addresses, phone, UCI/Medicaid/payer member IDs and
-- care notes are NOT part of this schema; caregivers only ever see a code.

create type ogevia.client_status as enum ('active', 'inactive', 'discharged');
create type ogevia.shift_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');
create type ogevia.shift_coverage_event_type as enum ('called_out', 'reassigned');

create table ogevia.caregiver_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  linked_user_id uuid references ogevia.app_users(id),
  caregiver_code text not null,
  -- Shown to managers as the visit's caregiver name snapshot.
  first_name text not null,
  last_name text not null,
  preferred_name text,
  status text not null default 'active'
    check (status in ('onboarding', 'ready', 'active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, caregiver_code),
  unique (id, organization_id)
);
create unique index caregiver_records_one_link_per_user
  on ogevia.caregiver_records (organization_id, linked_user_id)
  where linked_user_id is not null and deleted_at is null;

create table ogevia.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  -- Random, non-semantic, never derived from identity.
  client_code text not null,
  -- Optional manager-chosen caregiver-facing label (current main 20260824210000).
  caregiver_display_code text
    check (caregiver_display_code is null or length(btrim(caregiver_display_code)) between 3 and 40),
  status ogevia.client_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, organization_id)
);
create unique index clients_org_client_code_unique
  on ogevia.clients (organization_id, lower(client_code)) where deleted_at is null;
create unique index clients_org_display_code_unique
  on ogevia.clients (organization_id, lower(btrim(caregiver_display_code)))
  where caregiver_display_code is not null and deleted_at is null;

-- Phase 0 finding M-3: current main derives 'CL-' + 6 hex chars of the UUID
-- (24 bits), so an insert fails on collision. The target draws 40 random bits
-- and retries until the code is unused in the organization.
create function ogevia.set_default_client_code()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  candidate text;
begin
  if new.client_code is not null and btrim(new.client_code) <> '' then
    return new;
  end if;
  loop
    -- 10 hex digits = 40 random bits (the leading part of a v4 UUID is random).
    candidate := 'CL-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 10));
    exit when not exists (
      select 1 from ogevia.clients
      where organization_id = new.organization_id
        and lower(client_code) = lower(candidate)
        and deleted_at is null
    );
  end loop;
  new.client_code := candidate;
  return new;
end;
$$;

create trigger clients_set_default_client_code
before insert on ogevia.clients
for each row execute function ogevia.set_default_client_code();

create table ogevia.services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  code text not null,
  name text not null,
  color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, organization_id)
);

create table ogevia.caregiver_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_user_id uuid not null references ogevia.app_users(id),
  client_id uuid not null,
  service_id uuid not null,
  effective_start date not null,
  effective_end date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caregiver_assignments_period_check
    check (effective_end is null or effective_start <= effective_end),
  -- Composite FKs make cross-tenant references impossible at the schema level.
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id)
);
create index caregiver_assignments_lookup_idx
  on ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id)
  where is_active;

-- Ported from current main assert_valid_caregiver_assignment (20260824222000).
create function ogevia.assert_valid_caregiver_assignment()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if not new.is_active then
    return new;
  end if;
  if not exists (
    select 1
    from ogevia.organization_memberships m
    join ogevia.caregiver_records cr
      on cr.organization_id = m.organization_id
     and cr.linked_user_id = m.user_id
     and cr.deleted_at is null
     and cr.status in ('active', 'ready')
    where m.organization_id = new.organization_id
      and m.user_id = new.caregiver_user_id
      and m.role = 'caregiver'
      and m.status in ('active', 'invited')
  ) then
    raise exception 'Assign an active Care Team record with a linked caregiver login' using errcode = 'OGV22';
  end if;
  if not exists (
    select 1 from ogevia.clients c
    where c.id = new.client_id and c.organization_id = new.organization_id
      and c.deleted_at is null and c.status = 'active'
  ) then
    raise exception 'The client must be active in this organization' using errcode = 'OGV22';
  end if;
  if not exists (
    select 1 from ogevia.services s
    where s.id = new.service_id and s.organization_id = new.organization_id
      and s.deleted_at is null and s.is_active
  ) then
    raise exception 'The service must be active in this organization' using errcode = 'OGV22';
  end if;
  return new;
end;
$$;

create trigger caregiver_assignments_assert_valid
before insert or update of organization_id, caregiver_user_id, client_id, service_id, is_active
on ogevia.caregiver_assignments
for each row execute function ogevia.assert_valid_caregiver_assignment();

-- Ported from current main caregiver_has_active_assignment (v3): uses the
-- ORGANIZATION's local date, not the database session date.
create function ogevia.caregiver_has_active_assignment(
  p_organization_id uuid,
  p_client_id uuid,
  p_service_id uuid default null
)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select ogevia.is_active_member(p_organization_id)
    and exists (
      select 1
      from ogevia.caregiver_assignments ca
      where ca.organization_id = p_organization_id
        and ca.caregiver_user_id = ogevia.current_user_id()
        and ca.client_id = p_client_id
        and (p_service_id is null or ca.service_id = p_service_id)
        and ca.is_active
        and ogevia.organization_local_date(p_organization_id, now()) >= ca.effective_start
        and (ca.effective_end is null
             or ogevia.organization_local_date(p_organization_id, now()) <= ca.effective_end)
    );
$$;

create table ogevia.shifts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  service_id uuid,
  caregiver_user_id uuid references ogevia.app_users(id),
  caregiver_record_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status ogevia.shift_status not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shifts_time_check check (starts_at < ends_at),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create index shifts_org_client_start_idx on ogevia.shifts (organization_id, client_id, starts_at);

create table ogevia.shift_coverage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  shift_id uuid not null references ogevia.shifts(id),
  event_type ogevia.shift_coverage_event_type not null,
  created_at timestamptz not null default now()
);
create index shift_coverage_events_shift_idx on ogevia.shift_coverage_events (shift_id, created_at desc);

-- True when the shift's most recent coverage event is a call-out.
create function ogevia.shift_is_called_out(p_shift_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce((
    select e.event_type = 'called_out'
    from ogevia.shift_coverage_events e
    where e.shift_id = p_shift_id
    order by e.created_at desc
    limit 1
  ), false);
$$;
