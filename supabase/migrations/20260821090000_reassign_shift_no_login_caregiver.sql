-- reassign_shift took a user id, so a Care Team member without a login
-- could be a shift's original assignee (the scheduling form has always
-- supported that) but could never be picked as a reassignment target -
-- a real gap flagged when the call-out/reassignment workflow shipped.
-- Widens it to take the caregiver's workforce record id instead, the
-- same identity shifts_validate_caregiver_overlap already keys on, and
-- resolves a linked login only if one exists. shift_coverage_events
-- gains record-id columns alongside the existing user-id ones so
-- history can name a no-login replacement instead of showing a blank.

alter table public.shift_coverage_events
  add column if not exists original_caregiver_record_id uuid references public.caregiver_records(id),
  add column if not exists replacement_caregiver_record_id uuid references public.caregiver_records(id);

-- The existing check required a reassignment to carry a replacement
-- *user* id - exactly the assumption this migration removes. Widen it
-- to accept either a user id (has a login) or a record id (no login).
alter table public.shift_coverage_events drop constraint if exists shift_coverage_events_reassign_has_replacement;
alter table public.shift_coverage_events add constraint shift_coverage_events_reassign_has_replacement
  check (
    (event_type = 'reassigned' and (replacement_caregiver_user_id is not null or replacement_caregiver_record_id is not null))
    or (event_type = 'called_out' and replacement_caregiver_user_id is null and replacement_caregiver_record_id is null)
  );

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

  return event_id;
end;
$function$;

-- Postgres refuses to rename an input parameter via CREATE OR REPLACE
-- (new_caregiver_user_id -> new_caregiver_record_id); drop first.
drop function if exists public.reassign_shift(uuid, uuid, text);

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
end;
$function$;

create or replace function public.list_shift_coverage_history(target_shift_id uuid)
 returns table(id uuid, event_type shift_coverage_event_type, original_caregiver_name text, replacement_caregiver_name text, actor_name text, reason text, created_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    e.id, e.event_type,
    coalesce(op.display_name, nullif(concat_ws(' ', coalesce(ocr.preferred_name, ocr.first_name), ocr.last_name), ''), 'Caregiver'),
    coalesce(rp.display_name, nullif(concat_ws(' ', coalesce(rcr.preferred_name, rcr.first_name), rcr.last_name), '')),
    coalesce(ap.display_name, 'Administrator'),
    e.reason, e.created_at
  from public.shift_coverage_events e
  join public.shifts s on s.id = e.shift_id
  left join public.user_profiles op on op.id = e.original_caregiver_user_id
  left join public.caregiver_records ocr on ocr.id = e.original_caregiver_record_id
  left join public.user_profiles rp on rp.id = e.replacement_caregiver_user_id
  left join public.caregiver_records rcr on rcr.id = e.replacement_caregiver_record_id
  left join public.user_profiles ap on ap.id = e.actor_user_id
  where e.shift_id = target_shift_id
    and (
      public.has_permission(s.organization_id, 'shifts.read')
      or e.original_caregiver_user_id = auth.uid()
      or e.replacement_caregiver_user_id = auth.uid()
    )
  order by e.created_at asc;
$function$;
