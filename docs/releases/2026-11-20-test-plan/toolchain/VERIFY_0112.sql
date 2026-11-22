-- READ-ONLY verification of pending migration 0112 (assignment history). Writes nothing.
--   psql -X -At -F '|' -v expect=absent  -v ledger=skip -d <db> -f VERIFY_0112.sql    BEFORE: the function does not exist
--   psql -X -At -F '|' -v expect=present -v ledger=skip -d <db> -f VERIFY_0112.sql    AFTER : it exists, definer, search_path pinned, no PUBLIC execute, app role may execute, 0111 objects retained
-- ledger = skip (local harness), absent (TEST before) or present (TEST after: one ogevia_meta.schema_migrations row for version 0112).
-- Output: one row per check: name|t|detail (t = ok, f = FAILING). The wrapper counts the rows and fails on any "|f|".
\set ON_ERROR_STOP on
with fn(sig) as (values ('ogevia_api.list_assignment_history(uuid,text,uuid,integer)')), f as (select fn.*, to_regprocedure(sig) as oid from fn)
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
select 'retained 0111 object ' || s, to_regclass(s) is not null, '' from (values ('ogevia.office_assignments'), ('ogevia.caregiver_service_counties')) v(s)
union all
select 'retained 0111 function ogevia_api.list_people_facets', to_regprocedure('ogevia_api.list_people_facets(uuid)') is not null, ''
union all
select 'ledger row 0112 ' || :'ledger',
       case :'ledger'
         when 'skip' then true
         when 'absent' then not exists (select 1 from ogevia_meta.schema_migrations where version = '0112')
         else (select count(*) from ogevia_meta.schema_migrations where version = '0112' and name = '0112_assignment_history.sql') = 1 end, '';
