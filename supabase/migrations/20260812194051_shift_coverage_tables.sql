create type public.shift_coverage_event_type as enum ('called_out', 'reassigned');

create table public.shift_coverage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  event_type public.shift_coverage_event_type not null,
  original_caregiver_user_id uuid not null references auth.users(id),
  replacement_caregiver_user_id uuid references auth.users(id),
  actor_user_id uuid not null references auth.users(id),
  reason text not null,
  created_at timestamptz not null default now(),
  constraint shift_coverage_events_reassign_has_replacement check (
    (event_type = 'reassigned' and replacement_caregiver_user_id is not null)
    or (event_type = 'called_out' and replacement_caregiver_user_id is null)
  )
);

create index shift_coverage_events_shift_idx on public.shift_coverage_events (shift_id, created_at desc);
create index shift_coverage_events_org_idx on public.shift_coverage_events (organization_id);

create trigger shift_coverage_events_audit
after insert or update or delete on public.shift_coverage_events
for each row execute function public.write_audit_log();

alter table public.shift_coverage_events enable row level security;

create policy "members_read_shift_coverage_events"
on public.shift_coverage_events for select to authenticated
using (
  public.has_permission(organization_id, 'shifts.read')
  or original_caregiver_user_id = auth.uid()
  or replacement_caregiver_user_id = auth.uid()
);
