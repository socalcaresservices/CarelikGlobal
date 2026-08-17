begin;

-- Structured address, part 2: address_city/state/zip already existed
-- (20260721000000-era migrations) but there was no second line and the
-- existing `address` column (street/line 1) was only ever set at
-- creation - never editable afterward. address_line2 is new; `address`
-- itself is kept as-is (safe migration, no rename/backfill needed) and
-- the frontend now labels it "Address line 1" and makes it editable on
-- the client's own detail page, not just at creation.
alter table public.clients add column address_line2 text;

-- Freeform companion to client_requested_services: a service type not in
-- the org's own catalog (checklist), captured as plain text rather than
-- forcing an admin to first add it to Settings -> Services before a
-- client's stated need can be recorded at all.
alter table public.clients add column requested_service_notes text;

-- Client Requested Schedule: documents WHEN a client says they need
-- care - explicitly not an assignment or a scheduled shift. A client can
-- have more than one requested window the same day (e.g. Monday
-- 7-10am AND Monday 3-6pm), so this is one row per window, same "day_of_week
-- + start_time + end_time, multiple rows per day allowed" shape as
-- caregiver_availability (20260719330000) - reusing its public.weekday
-- enum rather than inventing a second one. service_id is optional: a
-- family may ask for "mornings" before they've settled on which service
-- covers it.
create table public.client_requested_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  day_of_week public.weekday not null,
  start_time time not null,
  end_time time not null,
  service_id uuid references public.services(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint client_requested_schedule_time_order check (end_time > start_time)
);

create index client_requested_schedule_client_idx on public.client_requested_schedule (client_id);
create index client_requested_schedule_org_idx on public.client_requested_schedule (organization_id);

create trigger client_requested_schedule_audit
after insert or update or delete on public.client_requested_schedule
for each row execute function public.write_audit_log();

alter table public.client_requested_schedule enable row level security;

-- Same shape as client_requested_services: part of the client record, so
-- it reuses clients.read/clients.update rather than new permission keys.
create policy "members_read_client_requested_schedule"
on public.client_requested_schedule for select
to authenticated
using (public.has_permission(organization_id, 'clients.read'));

create policy "authorized_manage_client_requested_schedule"
on public.client_requested_schedule for all
to authenticated
using (public.has_permission(organization_id, 'clients.update'))
with check (public.has_permission(organization_id, 'clients.update'));

commit;
