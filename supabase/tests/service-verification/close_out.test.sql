-- Manager close-out of a missed clock-out (20260826090000). SYNTHETIC data only.
-- Caregiver f (user ...010f, record ...020f) left a visit open for 30 hours;
-- its linked shift ended long ago. Another visit of f sits 27h-26.5h ago.
insert into public.user_profiles (id, display_name) values ('00000000-0000-4000-8000-00000000010f', 'Synthetic Caregiver f');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000010f', 'caregiver');
insert into public.caregiver_records (id, organization_id, linked_user_id, first_name, last_name) values
  ('00000000-0000-4000-8000-00000000020f', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000010f', 'Caregiver', 'Synthetic f');
insert into public.shifts (id, organization_id, client_id, caregiver_user_id, caregiver_record_id, service_id, starts_at, ends_at) values
  ('00000000-0000-4000-8000-00000000030f', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-00000000010f', '00000000-0000-4000-8000-00000000020f', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '30 hours', now() - interval '27 hours');
insert into public.service_visits (id, organization_id, client_id, caregiver_user_id, caregiver_record_id, scheduled_shift_id,
                                   service_authorization_id, service_id, service_date, time_in, status)
select '00000000-0000-4000-8000-0000000004f1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
       '00000000-0000-4000-8000-00000000010f', '00000000-0000-4000-8000-00000000020f', '00000000-0000-4000-8000-00000000030f',
       a.id, '00000000-0000-4000-8000-0000000000e1', (now() - interval '30 hours')::date, now() - interval '30 hours', 'draft'
from public.client_authorizations a where a.service_id = '00000000-0000-4000-8000-0000000000e1';
insert into public.service_visits (organization_id, client_id, caregiver_user_id, caregiver_record_id, service_id, service_date,
                                   time_in, time_out, status)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000010f',
        '00000000-0000-4000-8000-00000000020f', '00000000-0000-4000-8000-0000000000e1', (now() - interval '27 hours')::date,
        now() - interval '27 hours', now() - interval '26 hours 30 minutes', 'signed');

create function pg_temp.close_fails(uid text, t timestamptz, why text, expected text) returns void language plpgsql as $$
begin
  perform set_config('test.uid', uid, false);
  perform public.close_missed_service_visit('00000000-0000-4000-8000-0000000004f1', t, why);
  raise exception 'expected failure: %', expected;
exception when others then
  if sqlerrm <> expected then raise exception 'got "%" instead of "%"', sqlerrm, expected; end if;
end $$;

do $$
declare
  manager constant text := '00000000-0000-4000-8000-000000000a00';
  caregiver constant text := '00000000-0000-4000-8000-00000000010f';
  visit constant uuid := '00000000-0000-4000-8000-0000000004f1';
  r record;
begin
  -- The caregiver can no longer end it themselves (pre-existing rule).
  perform set_config('test.uid', caregiver, false);
  begin
    perform public.end_service_visit(visit);
    raise exception 'caregiver end should be refused after 24h';
  exception when others then
    if sqlerrm not like 'This visit has been open for over 24 hours%' then raise; end if;
  end;

  perform pg_temp.close_fails(caregiver, now() - interval '27 hours 10 minutes', 'Forgot to sign out', 'Only a visit manager can close a missed visit');
  perform pg_temp.close_fails(manager, now() - interval '27 hours 10 minutes', '   ', 'A reason is required to close a missed visit');
  perform pg_temp.close_fails(manager, now() + interval '5 minutes', 'Forgot to sign out', 'The Time Out cannot be in the future');
  perform pg_temp.close_fails(manager, now() - interval '31 hours', 'Forgot to sign out', 'The Time Out must be after the Time In');
  perform pg_temp.close_fails(manager, now() - interval '5 hours', 'Forgot to sign out', 'A visit cannot be longer than 24 hours');
  perform pg_temp.close_fails(manager, now() - interval '26 hours 45 minutes', 'Forgot to sign out', 'The Time Out overlaps another visit for this caregiver');

  perform set_config('test.uid', manager, false);
  select * into r from public.close_missed_service_visit(visit, now() - interval '27 hours 10 minutes', '  Caregiver confirmed by phone they left at 3:50  ');
  if r.worked_minutes <> 170 then raise exception 'worked minutes %', r.worked_minutes; end if;

  select * into r from public.service_visits where id = visit;
  if r.status <> 'awaiting_signature' or r.time_out is distinct from (now() - interval '27 hours 10 minutes')
     or r.time_out_entered_by is distinct from manager::uuid
     or r.time_out_reason <> 'Caregiver confirmed by phone they left at 3:50'
     or r.caregiver_attested_at is not null then
    raise exception 'close-out did not record the visit as expected: %', row_to_json(r);
  end if;
  if (select status from public.shifts where id = '00000000-0000-4000-8000-00000000030f') <> 'completed' then
    raise exception 'close-out did not complete the linked shift';
  end if;
  if not exists (
    select 1 from public.audit_logs
    where action = 'service_visit.closed_by_manager' and entity_id = visit::text and actor_user_id = manager::uuid
      and reason = 'Caregiver confirmed by phone they left at 3:50' and (metadata ->> 'worked_minutes')::int = 170
  ) then
    raise exception 'close-out audit entry missing';
  end if;

  perform pg_temp.close_fails(manager, now() - interval '27 hours', 'Again', 'Only an open visit (no Time Out) can be closed this way');

  -- The caregiver's app reopens it at confirmation, marked as manager-entered.
  perform set_config('test.uid', caregiver, false);
  select * into r from public.get_active_service_visit_v3('00000000-0000-4000-8000-000000000001');
  if r.visit_id is distinct from visit or r.visit_status <> 'awaiting_signature' or not r.time_out_entered_by_manager then
    raise exception 'caregiver does not see the closed visit for confirmation: %', row_to_json(r);
  end if;

  perform set_config('test.uid', manager, false);
  if not (select time_out_entered_by_manager from public.list_service_visits('00000000-0000-4000-8000-000000000001') x where x.id = visit)
     or exists (select 1 from public.list_service_visits('00000000-0000-4000-8000-000000000001') x where x.id <> visit and x.time_out_entered_by_manager) then
    raise exception 'visit records do not flag manager-entered Time Out correctly';
  end if;

  if not has_function_privilege('authenticated', 'public.close_missed_service_visit(uuid, timestamptz, text)', 'execute')
     or has_function_privilege('anon', 'public.close_missed_service_visit(uuid, timestamptz, text)', 'execute')
     or has_function_privilege('anon', 'public.get_active_service_visit_v3(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.get_active_service_visit_v3(uuid)', 'execute') then
    raise exception 'close-out grants are wrong';
  end if;

  raise notice 'manager close-out assertions: all passed';
end $$;
