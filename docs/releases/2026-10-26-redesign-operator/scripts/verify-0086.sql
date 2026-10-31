-- READ ONLY. Verification of the pending migration 0086 (staff management) on the TEST database, run by apply-0086-test.sh inside a read-only transaction, never against ogevia_prd.
-- One row per check: check_name | ok | detail. Every row must be ok; any false row stops the release (the wrapper prints FAIL and exits non-zero). 110 rows are expected:
-- 2 tables x 2 + 21 functions x 4 (exists, fixed search_path, no PUBLIC execute, application-role execute as designed) + 15 API functions x 1 (SECURITY DEFINER) + 7 single checks. The query
-- never errors when 0086 is absent: every row is then false (so a wrong target is a failure, not a crash that could be mistaken for 'nothing to check').
with api_fns(f, args) as (values
  ('list_staff_types', 'uuid'), ('create_staff_type', 'uuid, text'), ('rename_staff_type', 'uuid, uuid, text'), ('set_staff_type_active', 'uuid, uuid, boolean'),
  ('list_staff', 'uuid'), ('create_staff', 'uuid, text, uuid, text, text'), ('add_member_to_staff', 'uuid, uuid, uuid'), ('update_staff', 'uuid, uuid, text, uuid, text, text, text'),
  ('begin_staff_invitation', 'uuid, uuid, text, text'), ('complete_staff_invitation', 'uuid, uuid, text, text, boolean, text'), ('begin_staff_invitation_resend', 'uuid, uuid'),
  ('record_staff_invitation_resent', 'uuid, uuid'), ('set_staff_role', 'uuid, uuid, text, text'), ('list_role_permissions', 'uuid'), ('list_staff_audit', 'uuid, uuid')),
internal_fns(f, args) as (values
  ('seed_default_staff_types', 'uuid'), ('organizations_seed_staff_types', ''), ('staff_guard', 'uuid, boolean'), ('assignable_staff_role', 'text'),
  ('staff_role_change_allowed', 'uuid, uuid, text, text'), ('staff_validate_contact', 'text, text')),
fns as (
  select 'ogevia_api' as sch, f, to_regprocedure('ogevia_api.' || f || '(' || args || ')') as oid from api_fns
  union all
  select 'ogevia', f, to_regprocedure('ogevia.' || f || '(' || args || ')') from internal_fns),
roles_with as (
  select rp.permission_key, array_agg(rp.role::text order by rp.role::text) as roles from ogevia.role_permissions rp where rp.permission_key in ('staff.read', 'staff.manage') group by rp.permission_key)
select 'table_' || t as check_name,
       to_regclass('ogevia.' || t) is not null and coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('ogevia.' || t)), false) as ok,
       'exists with row-level security on' as detail
  from (values ('staff_types'), ('staff_profiles')) v(t)
union all
select 'table_no_app_privilege_' || t,
       to_regclass('ogevia.' || t) is not null and not coalesce(has_table_privilege('ogevia_app', to_regclass('ogevia.' || t), 'select') or has_table_privilege('ogevia_app', to_regclass('ogevia.' || t), 'insert')
         or has_table_privilege('ogevia_app', to_regclass('ogevia.' || t), 'update') or has_table_privilege('ogevia_app', to_regclass('ogevia.' || t), 'delete'), true),
       'the application role has no direct table privilege'
  from (values ('staff_types'), ('staff_profiles')) v(t)
union all
select 'function_exists_' || sch || '.' || f, oid is not null, null from fns
union all
select 'function_fixed_search_path_' || sch || '.' || f,
       coalesce(oid is not null and (select exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') from pg_proc p where p.oid = fns.oid), false),
       'search_path is fixed on the function'
  from fns
union all
select 'function_security_definer_' || sch || '.' || f,
       coalesce(oid is not null and (select p.prosecdef from pg_proc p where p.oid = fns.oid), false),
       'API function runs as its owner (SECURITY DEFINER)'
  from fns where sch = 'ogevia_api'
union all
select 'function_no_public_execute_' || sch || '.' || f,
       oid is not null and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = fns.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
       'PUBLIC has no EXECUTE'
  from fns
union all
select 'function_app_execute_' || sch || '.' || f,
       coalesce(oid is not null and (case when sch = 'ogevia_api' then has_function_privilege('ogevia_app', oid, 'execute') else not has_function_privilege('ogevia_app', oid, 'execute') end), false),
       case when sch = 'ogevia_api' then 'the application role can execute it' else 'internal: the application role cannot execute it' end
  from fns
union all
select 'trigger_organizations_seed_staff_types',
       exists (select 1 from pg_trigger t where t.tgrelid = 'ogevia.organizations'::regclass and t.tgname = 'organizations_seed_staff_types' and not t.tgisinternal),
       'new agencies get the default staff types'
union all
select 'index_staff_types_org_name_unique',
       exists (select 1 from pg_indexes where schemaname = 'ogevia' and tablename = 'staff_types' and indexname = 'staff_types_org_name_idx' and indexdef like 'CREATE UNIQUE INDEX%'),
       'one name per agency, case-insensitive'
union all
select 'permissions_exist',
       (select count(*) from ogevia.permissions where key in ('staff.read', 'staff.manage')) = 2,
       'staff.read and staff.manage'
union all
select 'permissions_owner_only',
       (select count(*) from roles_with) = 2 and not exists (select 1 from roles_with where roles <> array['organization_owner']),
       coalesce((select string_agg(permission_key || '=' || array_to_string(roles, ','), '; ') from roles_with), 'none')
union all
select 'default_staff_types_every_agency',
       case when to_regclass('ogevia.staff_types') is null then false
            else coalesce((xpath('/row/c/text()', query_to_xml('select (not exists (select 1 from ogevia.organizations o cross join (values (''administrator''), (''manager''), (''scheduler''), (''coordinator''), (''supervisor''), (''office assistant''), (''caregiver'')) d(name) where not exists (select 1 from ogevia.staff_types s where s.organization_id = o.id and lower(s.name) = d.name)))::text as c', false, true, '')))[1]::text = 'true', false) end,
       'every agency has the 7 default types (' || (select count(*) from ogevia.organizations) || ' agencies)'
union all
select 'note_my_sign_in_replaced',
       to_regprocedure('ogevia_api.note_my_sign_in()') is not null
         and pg_get_functiondef(to_regprocedure('ogevia_api.note_my_sign_in()')) like '%staff_profiles%'
         and has_function_privilege('ogevia_app', to_regprocedure('ogevia_api.note_my_sign_in()'), 'execute'),
       'marks a staff invitation as signed in, still executable by the application role'
union all
select 'staff_profiles_login_email_not_exposed_to_app',
       to_regclass('ogevia.staff_profiles') is not null and not coalesce(has_column_privilege('ogevia_app', to_regclass('ogevia.staff_profiles'), 'login_email', 'select'), true),
       'the sign-in email column cannot be read by the application role directly'
order by 1;
