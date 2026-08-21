begin;

-- validate_shift_authorization (20260818020000) enforces client+service
-- overlap and the monthly authorization cap on every shifts insert/
-- update, but nothing anywhere checks whether the *caregiver* is already
-- booked elsewhere at that time - a manager could double-book the same
-- caregiver across two different clients with nothing server-side to
-- stop it. schedule_caregiver_visit(), the one RPC that used to check
-- this, is now a permanently-disabled stub
-- ("SELF_SCHEDULING_DISABLED: Visits must be scheduled by an agency
-- administrator."), so the admin scheduling screen's raw
-- supabase.from("shifts").insert(...) is the only path left, and it
-- never had this check either.
--
-- Keyed on caregiver_record_id when present, falling back to
-- caregiver_user_id only when neither row has a record id - matching
-- normalize_shift_workforce_identity()'s own identity model, since
-- caregiver_user_id is null for a Care Team member with no login and a
-- user-id-only match would silently skip protection for exactly those
-- caregivers.
create or replace function public.validate_shift_caregiver_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status <> 'scheduled' then
    return new;
  end if;

  if exists (
    select 1 from public.shifts s
    where s.organization_id = new.organization_id
      and s.status in ('scheduled', 'completed')
      and s.id is distinct from new.id
      and s.starts_at < new.ends_at
      and s.ends_at > new.starts_at
      and (
        (new.caregiver_record_id is not null and s.caregiver_record_id = new.caregiver_record_id)
        or (
          new.caregiver_record_id is null and new.caregiver_user_id is not null
          and s.caregiver_record_id is null and s.caregiver_user_id = new.caregiver_user_id
        )
      )
  ) then
    raise exception 'This caregiver is already scheduled during this time.';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_shift_caregiver_overlap() from public, anon, authenticated;

-- Name sorts after shifts_normalize_workforce_identity (Postgres runs
-- same-event BEFORE triggers in name order), so caregiver_user_id has
-- already been derived from caregiver_record_id by the time this checks
-- overlap - matters for a reassignment, which only ever sets
-- caregiver_record_id/caregiver_user_id, never touches starts_at/ends_at.
create trigger shifts_validate_caregiver_overlap
before insert or update of organization_id, caregiver_record_id, caregiver_user_id, starts_at, ends_at, status
on public.shifts
for each row execute function public.validate_shift_caregiver_overlap();

-- reassign_shift only ever updated caregiver_user_id, leaving
-- caregiver_record_id pointing at the *original* caregiver's Care Team
-- record after a reassignment - a real data-integrity bug (any feature
-- keyed on caregiver_record_id, including the overlap trigger just
-- added above, would silently see the wrong caregiver for a reassigned
-- shift). Fixed by resolving the replacement's caregiver_records row
-- (if one exists for this organization) and updating both columns
-- together, so normalize_shift_workforce_identity's own invariant -
-- caregiver_user_id always mirrors caregiver_record_id when a record id
-- is present - holds after a reassignment exactly as it does after a
-- normal insert.
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
  new_caregiver_record_id uuid;
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

  select cr.id into new_caregiver_record_id
  from public.caregiver_records cr
  where cr.organization_id = target_shift.organization_id
    and cr.linked_user_id = new_caregiver_user_id
    and cr.deleted_at is null
  limit 1;

  insert into public.shift_coverage_events (
    organization_id, shift_id, event_type, original_caregiver_user_id, replacement_caregiver_user_id, actor_user_id, reason
  ) values (
    target_shift.organization_id, target_shift.id, 'reassigned',
    target_shift.caregiver_user_id, new_caregiver_user_id, auth.uid(), btrim(reason)
  );

  -- shifts_validate_caregiver_overlap (BEFORE UPDATE, watches these
  -- columns) fires on this update and raises if the replacement is
  -- already booked elsewhere at this time - authoritative here exactly
  -- as it is for a fresh insert.
  update public.shifts
  set caregiver_user_id = new_caregiver_user_id,
      caregiver_record_id = new_caregiver_record_id
  where id = target_shift.id;
end;
$$;

revoke all on function public.reassign_shift(uuid, uuid, text) from public, anon;
grant execute on function public.reassign_shift(uuid, uuid, text) to authenticated;

commit;
