-- READ-ONLY verification of pending migrations 0090 to 0094 on the TEST database (ogevia_sv_test). Run inside "begin read only; ... rollback;".
--   psql -X -At -F '|' -v expect=absent  -d ogevia_sv_test -f VERIFY_0090_0094.sql    BEFORE: none of the objects exist
--   psql -X -At -F '|' -v expect=present -d ogevia_sv_test -f VERIFY_0090_0094.sql    AFTER : all exist, definer functions pinned, no PUBLIC execute, no app-role table access
-- Output: one row per check: name|t|detail (t = ok, f = FAILING). The wrapper counts rows and fails on any "|f|". Writes nothing.
\set ON_ERROR_STOP on
with fn(sig, definer, app_exec) as (values
  ('ogevia_api.approve_signin_override(uuid,uuid,text)', true, true),
  ('ogevia_api.list_signin_overrides(uuid)', true, true),
  ('ogevia.caregiver_has_signin_override(uuid,uuid)', false, false),
  ('ogevia_api.list_assigned_visit_clients(uuid)', true, true),
  ('ogevia_api.list_open_shifts(uuid)', true, true),
  ('ogevia_api.import_rows(uuid,text,jsonb,text,text,boolean)', true, true),
  ('ogevia_api.list_possible_duplicate_staff(uuid)', true, true),
  ('ogevia_api.merge_staff_profiles(uuid,uuid,uuid,text)', true, true),
  ('ogevia.ensure_standard_document_types(uuid)', true, false)
), f as (select fn.*, to_regprocedure(sig) as oid from fn)
select 'function ' || sig || ' ' || :'expect',
       case when :'expect' = 'absent' then oid is null else oid is not null end, ''
  from f where sig not in ('ogevia_api.list_assigned_visit_clients(uuid)', 'ogevia_api.list_open_shifts(uuid)')   -- these two exist before (changed by 0091), see the shape checks below
union all
select 'definer ' || sig, case when :'expect' = 'absent' then true else oid is not null and (select prosecdef from pg_proc where oid = f.oid) = definer end, ''
  from f where definer
union all
select 'search_path pinned ' || sig, case when :'expect' = 'absent' then true else oid is not null and coalesce((select proconfig::text like '%search_path=ogevia, pg_temp%' from pg_proc where oid = f.oid), false) end, ''
  from f where definer
union all
select 'no PUBLIC execute ' || sig, case when :'expect' = 'absent' then true else oid is not null and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = f.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') end, ''
  from f
union all
select 'app role execute ' || sig || ' = ' || app_exec, case when :'expect' = 'absent' then true else oid is not null and has_function_privilege('ogevia_app', oid, 'execute') = app_exec end, ''
  from f where sig like 'ogevia_api.%' or sig like '%ensure_standard%'
union all
select 'shape 0091 list_assigned_visit_clients has display_label', case when :'expect' = 'absent' then position('display_label' in pg_get_function_result(to_regprocedure('ogevia_api.list_assigned_visit_clients(uuid)'))) = 0
       else position('display_label' in pg_get_function_result(to_regprocedure('ogevia_api.list_assigned_visit_clients(uuid)'))) > 0 end, ''
union all
select 'shape 0091 list_open_shifts has city', case when :'expect' = 'absent' then position('city' in pg_get_function_result(to_regprocedure('ogevia_api.list_open_shifts(uuid)'))) = 0
       else position('city' in pg_get_function_result(to_regprocedure('ogevia_api.list_open_shifts(uuid)'))) > 0 end, ''
union all
select 'table ' || t || ' ' || :'expect', case when :'expect' = 'absent' then to_regclass('ogevia.' || t) is null else to_regclass('ogevia.' || t) is not null end, ''
  from unnest(array['caregiver_signin_overrides', 'import_batches', 'staff_merge_links']) t
union all
select 'row level security on ' || t, case when :'expect' = 'absent' then true else coalesce((select relrowsecurity from pg_class where oid = to_regclass('ogevia.' || t)), false) end, ''
  from unnest(array['caregiver_signin_overrides', 'import_batches', 'staff_merge_links']) t
union all
select 'app role has NO table privilege on ' || t, case when :'expect' = 'absent' then true else to_regclass('ogevia.' || t) is not null and not has_table_privilege('ogevia_app', to_regclass('ogevia.' || t), 'select,insert,update,delete') end, ''
  from unnest(array['caregiver_signin_overrides', 'import_batches', 'staff_merge_links']) t
union all
select 'permission caregivers.signin_override ' || :'expect', case when :'expect' = 'absent' then not exists (select 1 from ogevia.permissions where key = 'caregivers.signin_override')
       else (select count(*) from ogevia.role_permissions where permission_key = 'caregivers.signin_override') = 2 end, ''
union all
select 'ledger unchanged (pending migrations are outside the ledger): 88 rows, max 0088', (select count(*) = 88 and max(version) = '0088' from ogevia_meta.schema_migrations), '';
