\set ON_ERROR_STOP on
do $$
declare r record; n int;
begin
  -- Backfill.
  select category, categories into r from public.incidents where id = '00000000-0000-4000-8000-0000000001a1';
  assert r.categories = '{Fall}' and r.category = 'Fall', format('backfill: %s', row_to_json(r));

  -- New incident with several categories: trimmed, blanks and case-duplicates dropped, order kept.
  insert into public.incidents (id, organization_id, category, categories, description)
  values ('00000000-0000-4000-8000-0000000001a2', '00000000-0000-4000-8000-000000000001', 'ignored',
          array[' Fall ', 'Injury', '', 'fall', 'Medication error'], 'synthetic');
  select category, categories into r from public.incidents where id = '00000000-0000-4000-8000-0000000001a2';
  assert r.categories = '{Fall,Injury,"Medication error"}', format('normalized: %s', r.categories);
  assert r.category = 'Fall', format('primary = first: %s', r.category);

  -- Older client: insert with only category.
  insert into public.incidents (id, organization_id, category, description)
  values ('00000000-0000-4000-8000-0000000001a3', '00000000-0000-4000-8000-000000000001', 'Behavior', 'synthetic');
  select categories into r from public.incidents where id = '00000000-0000-4000-8000-0000000001a3';
  assert r.categories = '{Behavior}', format('legacy insert: %s', r.categories);

  -- Older client: update only category -> replaces the primary, keeps the rest.
  update public.incidents set category = 'Elopement' where id = '00000000-0000-4000-8000-0000000001a2';
  select category, categories into r from public.incidents where id = '00000000-0000-4000-8000-0000000001a2';
  assert r.categories = '{Elopement,Injury,"Medication error"}' and r.category = 'Elopement', format('legacy update: %s', row_to_json(r));

  -- New client: update categories -> category follows.
  update public.incidents set categories = array['Injury'] where id = '00000000-0000-4000-8000-0000000001a2';
  select category, categories into r from public.incidents where id = '00000000-0000-4000-8000-0000000001a2';
  assert r.categories = '{Injury}' and r.category = 'Injury', format('categories update: %s', row_to_json(r));

  -- Status-only update leaves categories alone.
  update public.incidents set status = 'resolved' where id = '00000000-0000-4000-8000-0000000001a2';
  select categories into r from public.incidents where id = '00000000-0000-4000-8000-0000000001a2';
  assert r.categories = '{Injury}', 'status update changed categories';

  -- At least one category.
  begin
    insert into public.incidents (organization_id, category, categories, description)
    values ('00000000-0000-4000-8000-000000000001', '  ', array['', '  '], 'synthetic');
    assert false, 'incident without a category accepted';
  exception when raise_exception then null; end;

  -- list_incidents returns the full list.
  select count(*) into n from public.list_incidents('00000000-0000-4000-8000-000000000001')
   where id = '00000000-0000-4000-8000-0000000001a3' and categories = '{Behavior}' and category = 'Behavior';
  assert n = 1, 'list_incidents categories';

  -- Grants.
  assert has_function_privilege('authenticated', 'public.list_incidents(uuid,integer,timestamptz,uuid)', 'execute'), 'list grant';
  assert not has_function_privilege('anon', 'public.list_incidents(uuid,integer,timestamptz,uuid)', 'execute'), 'list anon';
  assert not has_function_privilege('authenticated', 'public.normalize_incident_categories()', 'execute'), 'trigger fn locked';
  raise notice 'incident categories assertions: all passed';
end $$;
