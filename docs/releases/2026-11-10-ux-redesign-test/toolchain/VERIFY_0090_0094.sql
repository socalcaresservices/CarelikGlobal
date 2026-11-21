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

-- Applied files are recorded with the same names/checksums the normal runner uses.
with expected(version, name, checksum) as (values
  ('0090', '0090_caregiver_signin_override.sql', '963d8cf4e7c8bdfa7da38d2719d4a4be2f7dafd7ab50e371c4e2ae1a567dfe54'),
  ('0091', '0091_caregiver_client_labels.sql', '673dea984d97433cad1df663a890233acb2d240eb87abb8434db655d9a7596f3'),
  ('0092', '0092_bulk_import.sql', '2dc18c125b459750431981dad2dd257630c6864e5ed41102770e6d9d1f992121'),
  ('0093', '0093_staff_duplicates.sql', '952e1c9176ecee8b9475fd45f923fdff175bf78de14341a61b46e49d9f28affa'),
  ('0094', '0094_standard_document_types.sql', 'b0a28f483462a826aac0c9bb1e8e7b4ad8d26bfea80156668ab80874508f8d91')
) select 'ledger_' || e.version, case when :'expect' = 'present' then exists (select 1 from ogevia_meta.schema_migrations m where m.version=e.version and m.name=e.name and m.checksum=e.checksum) else not exists (select 1 from ogevia_meta.schema_migrations m where m.version=e.version) end, e.name from expected e;
