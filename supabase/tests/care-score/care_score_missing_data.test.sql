-- Assertions for 20260826010000_matching_no_credit_for_missing_caregiver_data.sql.
\set ON_ERROR_STOP on
do $$
declare a record; b record; d record; a2 record; b2 record; n int;
begin
  select * into a from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1') where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  select * into b from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1') where caregiver_record_id = '00000000-0000-4000-8000-00000000000b';
  select * into d from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1') where caregiver_record_id = '00000000-0000-4000-8000-00000000000d';
  -- Complete partial fit: capacity 12 + 1 of 2 windows (4) = 16; skill matched 10.
  assert a.availability_score = 16 and a.skills_score = 10 and a.missing_data = '{}', format('A unexpected: %s', row_to_json(a));
  -- Incomplete profile earns nothing for data it does not have, and the gaps are named.
  assert b.availability_score = 0 and b.skills_score = 0, format('B unexpected: %s', row_to_json(b));
  assert b.missing_data = '{availability_windows,skills,weekly_hours_target}', format('B missing_data: %s', b.missing_data);
  assert a.match_score > b.match_score, format('incomplete profile outranks complete one: A=%s B=%s', a.match_score, b.match_score);
  assert a.match_score = 30 + 25 + 16 + 10 + 0 and b.match_score = 30 + 25, 'totals';
  assert d.missing_data @> '{location,languages}' and d.proximity_score = 0 and d.language_score = 0, format('D: %s', row_to_json(d));
  -- Ranking order: the documented caregiver first.
  select count(*) into n from (select caregiver_record_id, row_number() over () rn from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1')) x
   where (rn = 1 and caregiver_record_id = '00000000-0000-4000-8000-00000000000a');
  assert n = 1, 'A must rank first';
  -- Client with NO recorded needs: neutral credit is equal for everyone (unchanged).
  select * into a2 from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2') where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  select * into b2 from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2') where caregiver_record_id = '00000000-0000-4000-8000-00000000000b';
  assert a2.language_score = 25 and b2.language_score = 25 and a2.skills_score = 10 and b2.skills_score = 10, 'no-needs language/skills neutral';
  assert a2.availability_score = 12 + 8 and b2.availability_score = 0 + 8, format('no-needs availability: A=%s B=%s', a2.availability_score, b2.availability_score);
  assert b2.missing_data = '{weekly_hours_target}', format('no-needs: only the hours target is flagged, got %s', b2.missing_data);
  -- Grants: anon cannot call either function; authenticated can call only the wrapper.
  assert not has_function_privilege('anon', 'public.list_caregiver_matches(uuid,uuid)', 'execute'), 'anon wrapper';
  assert has_function_privilege('authenticated', 'public.list_caregiver_matches(uuid,uuid)', 'execute'), 'authenticated wrapper';
  assert not has_function_privilege('authenticated', 'public._score_caregiver_matches(uuid,uuid)', 'execute'), 'authenticated scorer';
  assert not has_function_privilege('anon', 'public._score_caregiver_matches(uuid,uuid)', 'execute'), 'anon scorer';
  raise notice 'care-score missing-data assertions: all passed';
end $$;
