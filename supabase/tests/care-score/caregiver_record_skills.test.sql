-- Assertions for 20260826020000_caregiver_record_skills.sql (run after the
-- 20260826010000 assertions, on the same fixtures).
\set ON_ERROR_STOP on
do $$
declare a record; b record; v text[];
begin
  -- Backfill: Alex (linked login with profile skills) now has them on the record.
  select skills into v from public.caregiver_records where id = '00000000-0000-4000-8000-00000000000a';
  assert v = '{dementia}', format('backfill: %s', v);
  -- Blair (no login) had no way to hold skills; record one now.
  update public.caregiver_records set skills = '{dementia,"  "}' where id = '00000000-0000-4000-8000-00000000000b';
  select * into b from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1') where caregiver_record_id = '00000000-0000-4000-8000-00000000000b';
  assert b.skills_score = 10, format('no-login caregiver skills credit: %s', b.skills_score);
  assert not ('skills' = any(b.missing_data)), format('skills still flagged missing: %s', b.missing_data);
  -- Blank entries never count as a skill.
  update public.caregiver_records set skills = '{" "}' where id = '00000000-0000-4000-8000-00000000000b';
  select * into b from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1') where caregiver_record_id = '00000000-0000-4000-8000-00000000000b';
  assert b.skills_score = 0 and 'skills' = any(b.missing_data), format('blank skill counted: %s', row_to_json(b));
  -- Union: record skills and the linked login's profile skills both count.
  update public.caregiver_records set skills = '{wound care}' where id = '00000000-0000-4000-8000-00000000000a';
  select * into a from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1') where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  assert a.skills_score = 10, format('profile skill lost in union: %s', a.skills_score);
  -- Backfill never overwrites skills a record already has (re-run is a no-op).
  update public.user_profiles set skills = '{bathing}' where id = '00000000-0000-4000-8000-0000000000a0';
  update public.caregiver_records cr set skills = up.skills from public.user_profiles up
   where up.id = cr.linked_user_id and cardinality(cr.skills) = 0 and cardinality(up.skills) > 0;
  select skills into v from public.caregiver_records where id = '00000000-0000-4000-8000-00000000000a';
  assert v = '{wound care}', format('backfill overwrote record skills: %s', v);
  -- Grants unchanged.
  assert not has_function_privilege('authenticated', 'public._score_caregiver_matches(uuid,uuid)', 'execute'), 'scorer grant';
  assert has_function_privilege('authenticated', 'public.list_caregiver_matches(uuid,uuid)', 'execute'), 'wrapper grant';
  raise notice 'caregiver record skills assertions: all passed';
end $$;
