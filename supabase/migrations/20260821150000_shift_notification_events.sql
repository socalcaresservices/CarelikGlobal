begin;

-- Phase 1 "eliminate the scheduler": nobody currently gets told a shift
-- needs coverage or that they've been assigned one - the office finds out
-- by opening the Schedule page, and a caregiver finds out by checking the
-- app or being called. domain_events already exists as a generic outbox
-- (see 20260719160000_domain_event_outbox_processing.sql and the
-- document_request.reminder_due / *.usage_threshold_reached examples that
-- already enqueue through it) with a real consumer (process-events edge
-- function) whose dispatchEvent() has been an intentional stub since it
-- was written - this wires the two shift-coverage RPCs and shift creation
-- into that existing pipeline instead of building a new one.
--
-- Two event types:
--   shift.assigned        - a caregiver (with or without a login) now
--                            owns a scheduled shift, fired on initial
--                            creation (trigger) and on reassignment (RPC).
--   shift.needs_coverage   - a shift lost its caregiver to a call-out and
--                            has no replacement yet, fired from
--                            call_out_shift(). Consumed by texting
--                            everyone in the org who holds shifts.update
--                            (the people who'd otherwise be "scrambling to
--                            refill" per the product owner's own framing
--                            of the pain point) - see
--                            supabase/functions/process-events for the
--                            actual send.

create or replace function public.notify_shift_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'scheduled' and (new.caregiver_user_id is not null or new.caregiver_record_id is not null) then
    insert into public.domain_events (
      organization_id, event_type, aggregate_type, aggregate_id, payload, metadata, idempotency_key
    ) values (
      new.organization_id,
      'shift.assigned',
      'shift',
      new.id::text,
      jsonb_build_object(
        'shift_id', new.id,
        'client_id', new.client_id,
        'caregiver_user_id', new.caregiver_user_id,
        'caregiver_record_id', new.caregiver_record_id,
        'starts_at', new.starts_at,
        'ends_at', new.ends_at
      ),
      '{}'::jsonb,
      'shift_assigned:' || new.id || ':' || extract(epoch from new.created_at)::text
    )
    on conflict (organization_id, idempotency_key) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.notify_shift_assigned() from public, anon, authenticated;

drop trigger if exists shifts_notify_assigned on public.shifts;
create trigger shifts_notify_assigned
after insert on public.shifts
for each row execute function public.notify_shift_assigned();

create or replace function public.call_out_shift(target_shift_id uuid, reason text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
    organization_id, shift_id, event_type, original_caregiver_user_id, original_caregiver_record_id, actor_user_id, reason
  ) values (
    target_shift.organization_id, target_shift.id, 'called_out',
    target_shift.caregiver_user_id, target_shift.caregiver_record_id, auth.uid(), btrim(reason)
  ) returning id into event_id;

  insert into public.domain_events (
    organization_id, event_type, aggregate_type, aggregate_id, payload, metadata, idempotency_key
  ) values (
    target_shift.organization_id,
    'shift.needs_coverage',
    'shift',
    target_shift.id::text,
    jsonb_build_object(
      'shift_id', target_shift.id,
      'client_id', target_shift.client_id,
      'starts_at', target_shift.starts_at,
      'ends_at', target_shift.ends_at,
      'reason', btrim(reason)
    ),
    '{}'::jsonb,
    'shift_needs_coverage:' || event_id
  )
  on conflict (organization_id, idempotency_key) do nothing;

  return event_id;
end;
$function$;

create or replace function public.reassign_shift(target_shift_id uuid, new_caregiver_record_id uuid, reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  target_shift public.shifts%rowtype;
  new_caregiver_user_id uuid;
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
  if new_caregiver_record_id = target_shift.caregiver_record_id then
    raise exception 'This shift is already assigned to that caregiver';
  end if;
  if exists (
    select 1 from public.service_visits
    where scheduled_shift_id = target_shift.id and status not in ('voided', 'corrected')
  ) then
    raise exception 'This shift already has a started visit and cannot be reassigned';
  end if;

  select cr.linked_user_id into new_caregiver_user_id
  from public.caregiver_records cr
  where cr.id = new_caregiver_record_id
    and cr.organization_id = target_shift.organization_id
    and cr.deleted_at is null
    and cr.status in ('active', 'ready');
  if not found then
    raise exception 'The replacement caregiver must be an active workforce record in this organization';
  end if;

  insert into public.shift_coverage_events (
    organization_id, shift_id, event_type,
    original_caregiver_user_id, original_caregiver_record_id,
    replacement_caregiver_user_id, replacement_caregiver_record_id,
    actor_user_id, reason
  ) values (
    target_shift.organization_id, target_shift.id, 'reassigned',
    target_shift.caregiver_user_id, target_shift.caregiver_record_id,
    new_caregiver_user_id, new_caregiver_record_id,
    auth.uid(), btrim(reason)
  );

  update public.shifts
  set caregiver_user_id = new_caregiver_user_id,
      caregiver_record_id = new_caregiver_record_id
  where id = target_shift.id;

  insert into public.domain_events (
    organization_id, event_type, aggregate_type, aggregate_id, payload, metadata, idempotency_key
  ) values (
    target_shift.organization_id,
    'shift.assigned',
    'shift',
    target_shift.id::text,
    jsonb_build_object(
      'shift_id', target_shift.id,
      'client_id', target_shift.client_id,
      'caregiver_user_id', new_caregiver_user_id,
      'caregiver_record_id', new_caregiver_record_id,
      'starts_at', target_shift.starts_at,
      'ends_at', target_shift.ends_at
    ),
    '{}'::jsonb,
    'shift_reassigned:' || target_shift.id || ':' || extract(epoch from now())::text
  )
  on conflict (organization_id, idempotency_key) do nothing;
end;
$function$;

commit;
