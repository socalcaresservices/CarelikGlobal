-- Shift-based visit access (20260826080000). SYNTHETIC data only.
create function pg_temp.as_user(caregiver text) returns void language sql as $$
  select set_config('test.uid', '00000000-0000-4000-8000-00000000010' || caregiver, false)::text::void
$$;
create function pg_temp.refused(caregiver text) returns boolean language plpgsql as $$
begin
  perform pg_temp.as_user(caregiver);
  perform public.start_ad_hoc_service_visit(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e1');
  return false;
exception when others then
  if sqlerrm <> 'This client and service are not assigned to you' then raise; end if;
  return true;
end $$;

do $$
declare
  v uuid; r record;
begin
  -- a: scheduled now, no standing assignment -> sees the client and only the
  -- shift's service, and can clock in; the visit links to that shift.
  perform pg_temp.as_user('a');
  select * into r from public.list_assigned_visit_clients('00000000-0000-4000-8000-000000000001')
  where client_id = '00000000-0000-4000-8000-0000000000c1';
  if r.client_id is null then raise exception 'scheduled caregiver does not see the client'; end if;
  if r.active_service_count <> 1 then raise exception 'expected only the shift''s service, got %', r.active_service_count; end if;
  select array_agg(service_id) into r from public.list_authorized_services_for_client(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1');
  if r.array_agg is distinct from array['00000000-0000-4000-8000-0000000000e1']::uuid[] then
    raise exception 'authorized services for a shift-only caregiver: %', r.array_agg;
  end if;
  v := public.start_ad_hoc_service_visit(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e1');
  if (select scheduled_shift_id from public.service_visits where id = v) is distinct from '00000000-0000-4000-8000-00000000030a' then
    raise exception 'shift-based start was not linked to the shift';
  end if;

  -- The other service on the same client stays closed to a.
  begin
    perform public.start_ad_hoc_service_visit(
      '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e2');
    raise exception 'a shift for s1 must not open s2';
  exception when others then
    if sqlerrm not in ('This client and service are not assigned to you', 'Finish your current visit before starting another client') then raise; end if;
  end;

  -- Access ends with the shift: after Time Out the shift is completed.
  update public.service_visits set time_in = now() - interval '2 hours' where id = v;
  perform public.end_service_visit(v);
  update public.service_visits set status = 'signed' where id = v;
  if not pg_temp.refused('a') then raise exception 'access must end when the shift is completed'; end if;
  perform pg_temp.as_user('a');
  if exists (select 1 from public.list_assigned_visit_clients('00000000-0000-4000-8000-000000000001')) then
    raise exception 'completed shift still lists the client';
  end if;

  -- Not yet in the window, called out, or someone else's shift -> refused.
  if not pg_temp.refused('b') then raise exception 'a shift 90 minutes away must not grant access'; end if;
  if not pg_temp.refused('c') then raise exception 'a called-out shift must not grant access'; end if;
  if not pg_temp.refused('d') then raise exception 'another caregiver''s shift must not grant access'; end if;
  perform pg_temp.as_user('d');
  if exists (select 1 from public.list_assigned_visit_clients('00000000-0000-4000-8000-000000000001')) then
    raise exception 'a caregiver without a shift or assignment sees a client';
  end if;
  -- e's shift carries only the record id (as the Schedule page writes it).
  if pg_temp.refused('e') then raise exception 'record-linked shift must grant access'; end if;

  -- Helpers stay internal.
  if has_function_privilege('authenticated', 'public.caregiver_has_current_shift(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.caregiver_has_current_shift(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.visit_shift_early_arrival()', 'execute') then
    raise exception 'shift-access helpers must not be callable by app roles';
  end if;
  if not has_function_privilege('authenticated', 'public.list_assigned_visit_clients(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.list_authorized_services_for_client(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.list_assigned_visit_clients(uuid)', 'execute') then
    raise exception 'visit picker grants changed';
  end if;

  raise notice 'shift-based visit access assertions: all passed';
end $$;
