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
