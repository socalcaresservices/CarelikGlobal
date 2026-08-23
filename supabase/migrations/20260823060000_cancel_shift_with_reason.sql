begin;

-- The scheduling audit's remaining gap in the call-out/cancel/replace
-- workflow: call_out_shift() and reassign_shift() both require a
-- non-empty reason and record it in shift_coverage_events, but plain
-- cancellation only ever went through a direct
-- `supabase.from("shifts").update({ status: "cancelled" })` on the
-- Schedule page - no reason captured anywhere beyond the generic
-- audit_logs old/new-value diff. Fixed by adding a 'cancelled' event
-- type to the existing append-only shift_coverage_events log (the same
-- table already used for called_out/reassigned) and a cancel_shift()
-- RPC matching call_out_shift/reassign_shift's house style exactly:
-- security definer, requires shifts.update, requires a non-empty
-- reason, locks the row, only allows the scheduled -> cancelled
-- transition.
alter type public.shift_coverage_event_type add value if not exists 'cancelled';
commit;

begin;

-- shift_coverage_events_reassign_has_replacement (20260821060000) is an
-- exhaustive enum-shaped check written before 'cancelled' existed - it
-- only recognizes 'reassigned' (replacement required) and 'called_out'
-- (replacement forbidden), so any other event_type value fails
-- unconditionally. Widened to put 'cancelled' in the same
-- no-replacement bucket as 'called_out' (a cancellation has an original
-- caregiver, if any, but never a replacement).
alter table public.shift_coverage_events drop constraint shift_coverage_events_reassign_has_replacement;
alter table public.shift_coverage_events add constraint shift_coverage_events_reassign_has_replacement check (
  (event_type = 'reassigned' and (replacement_caregiver_user_id is not null or replacement_caregiver_record_id is not null))
  or (event_type in ('called_out', 'cancelled') and replacement_caregiver_user_id is null and replacement_caregiver_record_id is null)
);

create or replace function public.cancel_shift(target_shift_id uuid, reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  target_shift public.shifts%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to cancel a shift';
  end if;

  select * into target_shift from public.shifts where id = target_shift_id for update;
  if target_shift.id is null then raise exception 'Shift not found'; end if;
  if not public.has_permission(target_shift.organization_id, 'shifts.update') then
    raise exception 'You do not have permission to cancel shifts for this organization';
  end if;
  if target_shift.status <> 'scheduled' then
    raise exception 'Only a scheduled shift can be cancelled';
  end if;

  insert into public.shift_coverage_events (
    organization_id, shift_id, event_type,
    original_caregiver_user_id, original_caregiver_record_id,
    actor_user_id, reason
  ) values (
    target_shift.organization_id, target_shift.id, 'cancelled',
    target_shift.caregiver_user_id, target_shift.caregiver_record_id,
    auth.uid(), btrim(reason)
  );

  update public.shifts set status = 'cancelled' where id = target_shift.id;
end;
$function$;

revoke all on function public.cancel_shift(uuid, text) from public, anon;
grant execute on function public.cancel_shift(uuid, text) to authenticated;

commit;
