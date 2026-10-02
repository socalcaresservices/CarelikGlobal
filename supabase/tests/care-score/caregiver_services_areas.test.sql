-- Assertions for 20260826060000_caregiver_services_and_areas.sql (runs after
-- the earlier files; synthetic data only).
\set ON_ERROR_STOP on
do $$
declare r record; n int; s0 int;
begin
  -- Backfill ran at migration time for Dana (record from applicant ...0d0).
  select count(*) into n from public.caregiver_record_services where caregiver_record_id = '00000000-0000-4000-8000-00000000000d';
  assert n = 1, format('services backfill: %s', n);
  select count(*) into n from public.caregiver_records where id = '00000000-0000-4000-8000-00000000000d' and preferred_cities = '{Riverside}';
  assert n = 1, 'preferred cities backfill';

  -- RPC: replaces the set; rejects a service from another organization and a record from another organization.
  perform public.replace_caregiver_record_services('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a',
    array['00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e1']::uuid[]);
  select count(*) into n from public.caregiver_record_services where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  assert n = 1, format('replace with duplicates: %s', n);
  begin
    perform public.replace_caregiver_record_services('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a',
      array['00000000-0000-4000-8000-0000000000f9']::uuid[]);
    assert false, 'other-organization service accepted';
  exception when raise_exception then null; end;
  begin
    perform public.replace_caregiver_record_services('00000000-0000-4000-8000-000000000999', '00000000-0000-4000-8000-00000000000a', '{}');
    assert false, 'record from another organization accepted';
  exception when raise_exception then null; end;

  -- CareScore notes for client C1 (requests Respite e1 and Personal care e2; city Los Angeles).
  insert into public.client_requested_services values
    ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e1'),
    ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e2');
  select match_score into s0 from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1')
   where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  -- Alex supports only e1: some services not supported; no preferred cities: no area note.
  select * into r from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1')
   where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  assert r.match_notes = '{some_services_not_supported}', format('Alex notes %s', r.match_notes);
  -- Dana supports a service the client did not request (backfilled e3) and prefers Riverside.
  select * into r from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1')
   where caregiver_record_id = '00000000-0000-4000-8000-00000000000d';
  assert r.match_notes = '{service_not_supported,outside_preferred_area}', format('Dana notes %s', r.match_notes);
  -- Blair has no services recorded: flagged as missing data, no service note.
  select * into r from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1')
   where caregiver_record_id = '00000000-0000-4000-8000-00000000000b';
  assert 'services' = any(r.missing_data) and r.match_notes = '{}', format('Blair %s', row_to_json(r));
  -- Notes never change the score: supporting both services leaves Alex's score as it was.
  perform public.replace_caregiver_record_services('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a',
    array['00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2']::uuid[]);
  select * into r from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1')
   where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  assert r.match_notes = '{}' and r.match_score = s0, format('Alex after: %s (was %s)', row_to_json(r), s0);
  -- Grants.
  assert has_function_privilege('authenticated', 'public.replace_caregiver_record_services(uuid,uuid,uuid[])', 'execute'), 'rpc grant';
  assert not has_function_privilege('anon', 'public.replace_caregiver_record_services(uuid,uuid,uuid[])', 'execute'), 'rpc anon';
  assert not has_table_privilege('authenticated', 'public.caregiver_record_services', 'insert'), 'no direct insert';
  assert has_table_privilege('authenticated', 'public.caregiver_record_services', 'select'), 'select grant';
  assert not has_function_privilege('authenticated', 'public._score_caregiver_matches(uuid,uuid)', 'execute'), 'scorer locked';
  raise notice 'caregiver services and areas assertions: all passed';
end $$;
