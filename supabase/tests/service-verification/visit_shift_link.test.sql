-- Visit <-> scheduled shift link (20260826070000). SYNTHETIC data only.
-- Runs after fixtures.sql and the migration. Every assertion raises on failure.
create function pg_temp.start_as(caregiver integer, service uuid default '00000000-0000-4000-8000-0000000000e1')
returns uuid language plpgsql as $$
begin
  perform set_config('test.uid', '00000000-0000-4000-8000-00000000010' || caregiver, false);
  return public.start_ad_hoc_service_visit(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', service);
end $$;

create function pg_temp.shift_of(visit uuid) returns uuid language sql as $$
  select scheduled_shift_id from public.service_visits where id = visit
$$;

do $$
declare
  v1 uuid; v2 uuid; v3 uuid; v4 uuid; v5 uuid; v6 uuid; v7 uuid; v8 uuid; v1b uuid;
  r record;
begin
  v1 := pg_temp.start_as(1);
  v2 := pg_temp.start_as(2);
  v3 := pg_temp.start_as(3);
  v4 := pg_temp.start_as(4);
  v5 := pg_temp.start_as(5);
  v6 := pg_temp.start_as(6);
  v7 := pg_temp.start_as(7);
  v8 := pg_temp.start_as(8);

  if pg_temp.shift_of(v1) is distinct from '00000000-0000-4000-8000-000000000301' then
    raise exception 'in-progress shift was not linked: %', pg_temp.shift_of(v1);
  end if;
  if pg_temp.shift_of(v2) is distinct from '00000000-0000-4000-8000-000000000302' then
    raise exception 'shift starting in 45 minutes was not linked: %', pg_temp.shift_of(v2);
  end if;
  if pg_temp.shift_of(v3) is not null then
    raise exception 'shift starting in 90 minutes must not be linked';
  end if;
  if pg_temp.shift_of(v4) is not null then
    raise exception 'called-out shift must not be linked';
  end if;
  if pg_temp.shift_of(v5) is not null then
    raise exception 'shift for another service must not be linked';
  end if;
  if pg_temp.shift_of(v6) is distinct from '00000000-0000-4000-8000-000000000306' then
    raise exception 'the shift in progress must win over the next one: %', pg_temp.shift_of(v6);
  end if;
  if pg_temp.shift_of(v7) is not null then
    raise exception 'a shift that already has a live visit must not be linked again';
  end if;
  if pg_temp.shift_of(v8) is not null then
    raise exception 'another caregiver''s shift must not be linked';
  end if;

  -- The start audit entry records the link (ids only).
  if not exists (
    select 1 from public.audit_logs
    where entity_id = v1::text and action = 'service_visit.started_ad_hoc'
      and metadata ->> 'scheduled_shift_id' = '00000000-0000-4000-8000-000000000301'
  ) then
    raise exception 'start audit entry does not record the linked shift';
  end if;

  -- Time Out completes the linked shift; a retry returns the same result.
  update public.service_visits set time_in = now() - interval '2 hours' where id in (v1, v2, v3);
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000101', false);
  select * into r from public.end_service_visit(v1);
  if r.worked_minutes <> 120 then raise exception 'unexpected worked minutes %', r.worked_minutes; end if;
  if (select status from public.shifts where id = '00000000-0000-4000-8000-000000000301') <> 'completed' then
    raise exception 'Time Out did not complete the linked shift';
  end if;
  select * into r from public.end_service_visit(v1);
  if r.visit_id <> v1 then raise exception 'end retry did not return the original visit'; end if;

  -- A shift cancelled while the visit was open stays cancelled.
  update public.shifts set status = 'cancelled' where id = '00000000-0000-4000-8000-000000000302';
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000102', false);
  perform public.end_service_visit(v2);
  if (select status from public.shifts where id = '00000000-0000-4000-8000-000000000302') <> 'cancelled' then
    raise exception 'Time Out must not change a cancelled shift';
  end if;

  -- An unlinked visit ends exactly as before and touches no shift.
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000103', false);
  perform public.end_service_visit(v3);
  if (select status from public.shifts where id = '00000000-0000-4000-8000-000000000303') <> 'scheduled' then
    raise exception 'an unlinked visit must not change any shift';
  end if;

  -- A delivered (completed) shift is not linked to a second visit.
  update public.service_visits set status = 'signed' where id = v1;
  v1b := pg_temp.start_as(1);
  if pg_temp.shift_of(v1b) is not null then
    raise exception 'a completed shift must not be linked to a second visit';
  end if;

  -- Visit records expose the scheduled window (manager view).
  perform set_config('test.uid', '00000000-0000-4000-8000-000000000a00', false);
  select * into r from public.list_service_visits('00000000-0000-4000-8000-000000000001') x where x.id = v1;
  if r.scheduled_shift_id is distinct from '00000000-0000-4000-8000-000000000301'
     or r.scheduled_starts_at is distinct from (select starts_at from public.shifts where id = '00000000-0000-4000-8000-000000000301')
     or r.scheduled_ends_at is distinct from (select ends_at from public.shifts where id = '00000000-0000-4000-8000-000000000301') then
    raise exception 'list_service_visits did not return the scheduled window';
  end if;
  select * into r from public.list_service_visits('00000000-0000-4000-8000-000000000001') x where x.id = v3;
  if r.scheduled_shift_id is not null or r.scheduled_starts_at is not null then
    raise exception 'an unlinked visit must list no scheduled window';
  end if;

  -- Grants: the helper is internal; the visit RPCs keep their grants.
  if has_function_privilege('authenticated', 'public.match_scheduled_shift_for_visit(uuid, uuid, uuid, uuid, uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.match_scheduled_shift_for_visit(uuid, uuid, uuid, uuid, uuid, timestamptz)', 'execute') then
    raise exception 'match_scheduled_shift_for_visit must not be callable by app roles';
  end if;
  if not has_function_privilege('authenticated', 'public.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text)', 'execute')
     or not has_function_privilege('authenticated', 'public.end_service_visit(uuid, text[], text)', 'execute')
     or not has_function_privilege('authenticated', 'public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status)', 'execute') then
    raise exception 'visit RPC grants changed';
  end if;
  if has_function_privilege('anon', 'public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status)', 'execute') then
    raise exception 'list_service_visits must not be callable by anon';
  end if;

  raise notice 'visit/shift link assertions: all passed';
end $$;
