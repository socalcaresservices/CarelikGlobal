begin;

-- Call-out / replacement coverage. Until now, covering a called-out shift
-- meant either editing shifts.caregiver_user_id by hand with no record of
-- why, or - worse - cancelling the shift and creating a new one, which
-- would have meant a second authorization reservation and, if a visit had
-- already been started, a second service event for the same work. Neither
-- of those was actually built, but there was also no supported path at
-- all: no way to record a call-out, no way to reassign with a reason kept,
-- no coverage history.
--
-- Reassignment updates shifts.caregiver_user_id on the SAME shift row -
-- same id, same starts_at/ends_at, same authorization reservation (the
-- cap/overlap trigger and every "committed hours" query key off
-- organization+client+service+status, never caregiver, so nothing about
-- the reservation changes when only the caregiver does). No new shift,
-- no new authorization check, no duplicate service_visits row. Coverage
-- history (who called out, who covered, who acted, when, why) lives in
-- its own append-only table rather than as fields on shifts itself, the
-- same reasoning visit_corrections split out from service_visits: a shift
-- can be reassigned more than once, and each event should stay a
-- permanent record rather than overwriting the last one.
create type public.shift_coverage_event_type as enum ('called_out', 'reassigned');

create table public.shift_coverage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shift_id uuid not null references public.shifts(id) on delete cascade,
  event_type public.shift_coverage_event_type not null,
  original_caregiver_user_id uuid not null references auth.users(id),
  -- Only set for 'reassigned' - a 'called_out' event has no replacement
  -- yet, that's what "needs coverage" means.
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

-- No insert/update/delete policy, same reasoning as service_visits -
-- every mutation goes through call_out_shift()/reassign_shift() below.
create policy "members_read_shift_coverage_events"
on public.shift_coverage_events for select to authenticated
using (
  public.has_permission(organization_id, 'shifts.read')
  or original_caregiver_user_id = auth.uid()
  or replacement_caregiver_user_id = auth.uid()
);

-- ---------------------------------------------------------------------
-- call_out_shift: either the shift's own caregiver, or anyone with
-- shifts.update, can report it. Doesn't touch the shift row itself -
-- "needs coverage" is read back from the event log (see list_shifts
-- below), not a stored shift status, so the shift's own status/caregiver
-- stay exactly what they were until an actual reassignment happens.
-- ---------------------------------------------------------------------
create or replace function public.call_out_shift(
  target_shift_id uuid,
  reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_shift public.shifts%rowtype;
  event_id uuid;
  latest_event_type public.shift_coverage_event_type;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to call out a shift';
  end if;

  select * into target_shift from public.shifts where id = target_shift_id for update;
  if target_shift.id is null then raise exception 'Shift not found'; end if;
  if target_shift.caregiver_user_id <> auth.uid()
     and not public.has_permission(target_shift.organization_id, 'shifts.update') then
    raise exception 'You cannot call out another caregiver''s shift';
  end if;
  if target_shift.status <> 'scheduled' then
    raise exception 'Only a scheduled shift can be called out';
  end if;

  select event_type into latest_event_type from public.shift_coverage_events
  where shift_id = target_shift.id
  order by created_at desc
  limit 1;

  if latest_event_type = 'called_out' then
    raise exception 'This shift already has an open call-out awaiting coverage';
  end if;

  insert into public.shift_coverage_events (
    organization_id, shift_id, event_type, original_caregiver_user_id, actor_user_id, reason
  ) values (
    target_shift.organization_id, target_shift.id, 'called_out', target_shift.caregiver_user_id, auth.uid(), btrim(reason)
  ) returning id into event_id;

  return event_id;
end;
$$;

revoke all on function public.call_out_shift(uuid, text) from public, anon;
grant execute on function public.call_out_shift(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- reassign_shift: shifts.update only - a caregiver can report a call-out
-- but not hand their own shift to someone else. Updates the SAME shift
-- row's caregiver_user_id; everything else about the shift (id, times,
-- client, service, and therefore its authorization reservation) is
-- unchanged. Blocked once a visit already exists for this shift - that
-- means actual service already started under the current caregiver, and
-- reassigning at that point would misattribute already-real work rather
-- than cover a not-yet-delivered shift.
-- ---------------------------------------------------------------------
create or replace function public.reassign_shift(
  target_shift_id uuid,
  new_caregiver_user_id uuid,
  reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_shift public.shifts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to reassign a shift';
  end if;

  select * into target_shift from public.shifts where id = target_shift_id for update;
  if target_shift.id is null then raise exception 'Shift not found'; end if;
  if not public.has_permission(target_shift.organization_id, 'shifts.update') then
    raise exception 'You do not have permission to reassign shifts for this organization';
  end if;
  if target_shift.status <> 'scheduled' then
    raise exception 'Only a scheduled shift can be reassigned';
  end if;
  if new_caregiver_user_id = target_shift.caregiver_user_id then
    raise exception 'This shift is already assigned to that caregiver';
  end if;
  if exists (
    select 1 from public.service_visits
    where scheduled_shift_id = target_shift.id and status not in ('voided', 'corrected')
  ) then
    raise exception 'This shift already has a started visit and cannot be reassigned';
  end if;
  if not exists (
    select 1 from public.organization_memberships
    where organization_id = target_shift.organization_id
      and user_id = new_caregiver_user_id
      and status = 'active'
  ) then
    raise exception 'The replacement caregiver must be an active member of this organization';
  end if;

  insert into public.shift_coverage_events (
    organization_id, shift_id, event_type, original_caregiver_user_id, replacement_caregiver_user_id, actor_user_id, reason
  ) values (
    target_shift.organization_id, target_shift.id, 'reassigned',
    target_shift.caregiver_user_id, new_caregiver_user_id, auth.uid(), btrim(reason)
  );

  update public.shifts set caregiver_user_id = new_caregiver_user_id where id = target_shift.id;
end;
$$;

revoke all on function public.reassign_shift(uuid, uuid, text) from public, anon;
grant execute on function public.reassign_shift(uuid, uuid, text) to authenticated;

create or replace function public.list_shift_coverage_history(target_shift_id uuid)
returns table (
  id uuid,
  event_type public.shift_coverage_event_type,
  original_caregiver_name text,
  replacement_caregiver_name text,
  actor_name text,
  reason text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.id, e.event_type,
    coalesce(op.display_name, 'Caregiver'),
    coalesce(rp.display_name, null),
    coalesce(ap.display_name, 'Administrator'),
    e.reason, e.created_at
  from public.shift_coverage_events e
  join public.shifts s on s.id = e.shift_id
  left join public.user_profiles op on op.id = e.original_caregiver_user_id
  left join public.user_profiles rp on rp.id = e.replacement_caregiver_user_id
  left join public.user_profiles ap on ap.id = e.actor_user_id
  where e.shift_id = target_shift_id
    and (
      public.has_permission(s.organization_id, 'shifts.read')
      or e.original_caregiver_user_id = auth.uid()
      or e.replacement_caregiver_user_id = auth.uid()
    )
  order by e.created_at asc;
$$;

revoke all on function public.list_shift_coverage_history(uuid) from public, anon;
grant execute on function public.list_shift_coverage_history(uuid) to authenticated;

-- list_shifts: adds needs_coverage (an open call-out with nothing newer
-- resolving it) and the reason, so the schedule page can flag it without
-- a second round trip. No other column or behavior changes from the
-- version this replaces. New output columns mean Postgres won't allow a
-- plain CREATE OR REPLACE (changes the OUT-parameter row type) - drop
-- first.
drop function if exists public.list_shifts(uuid, timestamptz, timestamptz);

create function public.list_shifts(
  target_organization_id uuid,
  from_time timestamptz default null,
  to_time timestamptz default null
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  caregiver_user_id uuid,
  caregiver_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.shift_status,
  notes text,
  needs_coverage boolean,
  call_out_reason text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.client_id,
    coalesce(c.first_name || ' ' || c.last_name, 'Unknown client'),
    s.caregiver_user_id,
    coalesce(p.display_name, 'Unknown caregiver'),
    s.starts_at,
    s.ends_at,
    s.status,
    s.notes,
    s.status = 'scheduled' and latest_event.event_type = 'called_out',
    case when latest_event.event_type = 'called_out' then latest_event.reason else null end
  from public.shifts s
  join public.clients c on c.id = s.client_id
  left join public.user_profiles p on p.id = s.caregiver_user_id
  left join lateral (
    select e.event_type, e.reason
    from public.shift_coverage_events e
    where e.shift_id = s.id
    order by e.created_at desc
    limit 1
  ) latest_event on true
  where s.organization_id = target_organization_id
    and (
      public.has_permission(target_organization_id, 'shifts.read')
      or s.caregiver_user_id = auth.uid()
    )
    and (from_time is null or s.ends_at >= from_time)
    and (to_time is null or s.starts_at <= to_time)
  order by s.starts_at;
$$;

revoke all on function public.list_shifts(uuid, timestamptz, timestamptz) from public;
grant execute on function public.list_shifts(uuid, timestamptz, timestamptz) to authenticated;

commit;
