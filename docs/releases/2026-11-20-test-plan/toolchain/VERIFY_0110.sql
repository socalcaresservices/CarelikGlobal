-- READ-ONLY verification of pending migration 0110 (offices) on a database. Run it as the operator's read-only login. Writes nothing.
--   psql -X -At -F '|' -v expect=absent  -v ledger=skip -d <db> -f VERIFY_0110.sql    BEFORE: none of the objects exist
--   psql -X -At -F '|' -v expect=present -v ledger=skip -d <db> -f VERIFY_0110.sql    AFTER : all exist, definer functions pinned, no PUBLIC execute, app role may execute
-- ledger = skip (local harness), absent (TEST before) or present (TEST after: one ogevia_meta.schema_migrations row for version 0110).
-- Output: one row per check: name|t|detail (t = ok, f = FAILING). The wrapper counts the rows and fails on any "|f|".
\set ON_ERROR_STOP on
with fn(sig) as (values
  ('ogevia_api.create_office(uuid,text,uuid)'), ('ogevia_api.rename_office(uuid,uuid,text)'), ('ogevia_api.retire_office(uuid,uuid,text)'),
  ('ogevia_api.list_offices(uuid)'), ('ogevia_api.list_client_offices(uuid)'), ('ogevia_api.set_client_office(uuid,uuid,uuid)')
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
select 'table ogevia.offices ' || :'expect', (to_regclass('ogevia.offices') is not null) = (:'expect' = 'present'), ''
union all
select 'column clients.responsible_office_id ' || :'expect',
       exists (select 1 from information_schema.columns c where c.table_schema = 'ogevia' and c.table_name = 'clients' and c.column_name = 'responsible_office_id') = (:'expect' = 'present'), ''
union all
select 'constraint clients_responsible_office_fk ' || :'expect',
       exists (select 1 from pg_constraint where conname = 'clients_responsible_office_fk' and contype = 'f') = (:'expect' = 'present'), ''
union all
select 'unique office name per agency ' || :'expect',
       exists (select 1 from pg_indexes where schemaname = 'ogevia' and indexname = 'offices_org_name_unique') = (:'expect' = 'present'), ''
union all
select 'offices row level security ' || :'expect',
       case when :'expect' = 'absent' then true else coalesce((select relrowsecurity from pg_class where oid = to_regclass('ogevia.offices')), false) end, ''
union all
select 'app role has no direct table access to offices',
       case when :'expect' = 'absent' then true else to_regclass('ogevia.offices') is not null and not has_table_privilege('ogevia_app', 'ogevia.offices', 'select,insert,update,delete') end, ''
union all
select 'ledger row 0110 ' || :'ledger',
       case :'ledger'
         when 'skip' then true
         when 'absent' then not exists (select 1 from ogevia_meta.schema_migrations where version = '0110')
         else (select count(*) from ogevia_meta.schema_migrations where version = '0110' and name = '0110_offices.sql') = 1 end, '';
