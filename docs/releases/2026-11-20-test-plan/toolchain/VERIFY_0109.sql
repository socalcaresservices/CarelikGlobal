-- READ-ONLY verification of pending migration 0109 (request cleanup) on a database. Run it as the operator's read-only login. Writes nothing.
--   psql -X -At -F '|' -v expect=absent  -v ledger=skip -d <db> -f VERIFY_0109.sql    BEFORE: none of the objects exist
--   psql -X -At -F '|' -v expect=present -v ledger=skip -d <db> -f VERIFY_0109.sql    AFTER : all exist, definer functions pinned, no PUBLIC execute, app role may execute
-- ledger = skip (local harness, where 0109 is applied by hand), absent (TEST before) or present (TEST after: one ogevia_meta.schema_migrations row for version 0109).
-- Output: one row per check: name|t|detail (t = ok, f = FAILING). The wrapper counts the rows and fails on any "|f|".
\set ON_ERROR_STOP on
with fn(sig, app_exec) as (values
  ('ogevia_api.cancel_staff_document_request(uuid,uuid,text,uuid)', true),
  ('ogevia_api.retire_document_type(uuid,uuid,text)', true),
  ('ogevia_api.mark_staff_care_notifications_read(uuid,uuid[])', true)
), f as (select fn.*, to_regprocedure(sig) as oid from fn),
col(tbl, name) as (values ('staff_documents','cancelled_by'), ('staff_documents','cancel_reason'), ('document_types','retired_by'), ('document_types','retired_at'))
select 'function ' || sig || ' ' || :'expect', case when :'expect' = 'absent' then oid is null else oid is not null end, '' from f
union all
select 'definer ' || sig, case when :'expect' = 'absent' then true else oid is not null and (select prosecdef from pg_proc where oid = f.oid) end, '' from f
union all
select 'search_path pinned ' || sig, case when :'expect' = 'absent' then true else oid is not null and coalesce((select proconfig::text like '%search_path=ogevia, pg_temp%' from pg_proc where oid = f.oid), false) end, '' from f
union all
select 'no PUBLIC execute ' || sig, case when :'expect' = 'absent' then true else oid is not null and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') end, '' from f
union all
select 'app role execute ' || sig || ' = ' || app_exec, case when :'expect' = 'absent' then true else oid is not null and has_function_privilege('ogevia_app', oid, 'execute') = app_exec end, '' from f
union all
select 'column ' || tbl || '.' || name || ' ' || :'expect',
       (exists (select 1 from information_schema.columns c where c.table_schema = 'ogevia' and c.table_name = col.tbl and c.column_name = col.name)) = (:'expect' = 'present'), '' from col
union all
select 'ledger row 0109 ' || :'ledger',
       case :'ledger'
         when 'skip' then true
         when 'absent' then not exists (select 1 from ogevia_meta.schema_migrations where version = '0109')
         else (select count(*) from ogevia_meta.schema_migrations where version = '0109' and name = '0109_request_cleanup.sql') = 1 end, '';
