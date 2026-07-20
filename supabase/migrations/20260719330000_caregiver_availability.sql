begin;

-- Weekly availability: which days a caregiver can work and what hours
-- each day, entered directly on the caregiver's profile - there's no
-- shift-history proxy for "can work Tuesdays" the way there is for
-- weekly hour totals, so this has to be its own explicit data. One row
-- per available window; a caregiver with two separate windows the same
-- day (morning and evening) just gets two rows for that day.

create type public.weekday as enum (
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
);

create table public.caregiver_availability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  caregiver_user_id uuid not null references auth.users(id),
  day_of_week public.weekday not null,
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caregiver_availability_time_order check (end_time > start_time)
);

create index caregiver_availability_org_idx on public.caregiver_availability (organization_id);
create index caregiver_availability_caregiver_idx on public.caregiver_availability (caregiver_user_id);

create trigger caregiver_availability_set_updated_at
before update on public.caregiver_availability
for each row execute function public.set_updated_at();

create trigger caregiver_availability_audit
after insert or update or delete on public.caregiver_availability
for each row execute function public.write_audit_log();

alter table public.caregiver_availability enable row level security;

-- Same shape as caregiver_credentials: org-wide with membership.read,
-- or always your own rows regardless of permission.
create policy "members_read_availability"
on public.caregiver_availability for select
to authenticated
using (
  public.has_permission(organization_id, 'membership.read')
  or caregiver_user_id = auth.uid()
);

-- Unlike credentials (compliance data, staff-managed only), a caregiver
-- manages their own availability directly - same self-or-manager shape
-- as set_caregiver_profile()/set_caregiver_weekly_target().
create policy "self_or_authorized_manage_availability"
on public.caregiver_availability for all
to authenticated
using (
  caregiver_user_id = auth.uid()
  or public.has_permission(organization_id, 'membership.update')
)
with check (
  caregiver_user_id = auth.uid()
  or public.has_permission(organization_id, 'membership.update')
);

commit;
