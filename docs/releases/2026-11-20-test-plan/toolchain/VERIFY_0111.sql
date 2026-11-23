-- READ-ONLY verification of pending migration 0111 (office assignments, counties, caregiver colors). Writes nothing.
--   psql -X -At -F '|' -v expect=absent  -v ledger=skip -d <db> -f VERIFY_0111.sql    BEFORE: none of the objects exist
--   psql -X -At -F '|' -v expect=present -v ledger=skip -d <db> -f VERIFY_0111.sql    AFTER : all exist, definer functions pinned, no PUBLIC execute, app role may execute
-- ledger = skip (local harness), absent (TEST before) or present (TEST after: one ogevia_meta.schema_migrations row for version 0111).
-- Output: one row per check: name|t|detail (t = ok, f = FAILING). The wrapper counts the rows and fails on any "|f|".
-- list_offices and list_client_offices and set_client_office exist BEFORE (0110) and are replaced by 0111, so they are not "absent" checks.
\set ON_ERROR_STOP on
with fn(sig) as (values
  ('ogevia_api.update_office(uuid,uuid,text,text,text,text,text)'), ('ogevia_api.reactivate_office(uuid,uuid)'), ('ogevia_api.set_person_offices(uuid,text,uuid,uuid,uuid[])'),
  ('ogevia_api.set_client_service_county(uuid,uuid,text)'), ('ogevia_api.set_caregiver_service_counties(uuid,uuid,text[])'), ('ogevia_api.set_caregiver_color(uuid,uuid,text)'),
  ('ogevia_api.list_people_facets(uuid)')
), f as (select fn.*, to_regprocedure(sig) as oid from fn)
select 'function ' || sig || ' ' || :'expect', case when :'expect' = 'absent' then oid is null else oid is not null end, '' from f
union all
select 'definer ' || sig, case when :'expect' = 'absent' then true else oid is not null and (select prosecdef from pg_proc where oid = f.oid) end, '' from f
union all
select 'search_path pinned ' || sig, case when :'expect' = 'absent' then true else oid is not null and coalesce((select proconfig::text like '%search_path=ogevia, pg_temp%' from pg_proc where oid = f.oid), false) end, '' from f
union all
select 'no PUBLIC execute ' || sig, case when :'expect' = 'absent' then true else oid is not null and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') end, '' from f
union all
select 'app role execute ' || sig, case when :'expect' = 'absent' then true else oid is not null and has_function_privilege('ogevia_app', oid, 'execute') end, '' from f
union all
select 'table ogevia.' || t || ' ' || :'expect', (to_regclass('ogevia.' || t) is not null) = (:'expect' = 'present'), '' from (values ('office_assignments'), ('caregiver_service_counties')) v(t)
union all
select 'column ' || c || ' ' || :'expect',
       exists (select 1 from information_schema.columns x where x.table_schema = 'ogevia' and x.table_name = split_part(c, '.', 1) and x.column_name = split_part(c, '.', 2)) = (:'expect' = 'present'), ''
  from (values ('offices.county'), ('offices.city'), ('offices.postal_code'), ('offices.address_line1'), ('clients.service_county'), ('caregiver_records.profile_color')) v(c)
union all
select 'function ogevia.california_counties ' || :'expect', (to_regprocedure('ogevia.california_counties()') is not null) = (:'expect' = 'present'), ''
union all
select 'row level security ' || t,
       case when :'expect' = 'absent' then true else coalesce((select relrowsecurity from pg_class where oid = to_regclass('ogevia.' || t)), false) end, ''
  from (values ('office_assignments'), ('caregiver_service_counties')) v(t)
union all
select 'app role has no direct table access to ' || t,
       case when :'expect' = 'absent' then true else to_regclass('ogevia.' || t) is not null and not has_table_privilege('ogevia_app', 'ogevia.' || t, 'select,insert,update,delete') end, ''
  from (values ('office_assignments'), ('caregiver_service_counties')) v(t)
union all
select 'primary-office guard trigger ' || :'expect',
       exists (select 1 from pg_trigger where tgname = 'office_assignments_primary_guard' and not tgisinternal) = (:'expect' = 'present'), ''
union all
select 'one primary office per person ' || :'expect',
       (select count(*) from pg_indexes where schemaname = 'ogevia' and tablename = 'office_assignments' and indexdef ilike '%is_primary%') >= (case when :'expect' = 'present' then 2 else 0 end)
       and (:'expect' = 'present' or not exists (select 1 from pg_indexes where schemaname = 'ogevia' and tablename = 'office_assignments')), ''
union all
select 'retained 0110 function ' || s, to_regprocedure(s) is not null, ''
  from (values ('ogevia_api.list_offices(uuid)'), ('ogevia_api.list_client_offices(uuid)'), ('ogevia_api.set_client_office(uuid,uuid,uuid)'), ('ogevia_api.create_office(uuid,text,uuid)'), ('ogevia_api.rename_office(uuid,uuid,text)'), ('ogevia_api.retire_office(uuid,uuid,text)')) v(s)
union all
select 'no person lost an office: every 0110 responsible office is a primary assignment',
       case when :'expect' = 'absent' then true
            else (xpath('/row/n/text()', query_to_xml('select count(*) n from ogevia.clients c where c.responsible_office_id is not null and not exists (select 1 from ogevia.office_assignments a where a.client_id = c.id and a.office_id = c.responsible_office_id and a.is_primary)', false, true, '')))[1]::text::int = 0 end, ''
union all
select 'ledger row 0111 ' || :'ledger',
       case :'ledger'
         when 'skip' then true
         when 'absent' then not exists (select 1 from ogevia_meta.schema_migrations where version = '0111')
         else (select count(*) from ogevia_meta.schema_migrations where version = '0111' and name = '0111_office_assignments_counties_colors.sql') = 1 end, '';
