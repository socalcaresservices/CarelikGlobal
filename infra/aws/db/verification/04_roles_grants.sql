-- READ ONLY. Least-privilege role model.
select 'app_role_has_no_table_privileges' as check_name,
       not exists (select 1 from information_schema.role_table_grants where grantee = 'ogevia_app') as ok,
       null::text as detail
union all
select 'app_role_not_superuser_or_bypassrls',
       coalesce((select not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb
                 from pg_roles where rolname = 'ogevia_app'), false), null
union all
select 'owner_role_is_nologin',
       coalesce((select not rolcanlogin from pg_roles where rolname = 'ogevia_owner'), false), null
union all
select 'all_objects_owned_by_ogevia_owner',
       not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname in ('ogevia', 'ogevia_api') and pg_get_userbyid(c.relowner) <> 'ogevia_owner'),
       null
union all
select 'no_function_executable_by_public',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname in ('ogevia', 'ogevia_api')
                     and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
       null
union all
select 'every_function_pins_search_path',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname in ('ogevia', 'ogevia_api')
                     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%')),
       null
union all
select 'api_functions_security_definer_owned_by_owner',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'ogevia_api'
                     and (not p.prosecdef or pg_get_userbyid(p.proowner) <> 'ogevia_owner')),
       null
union all
select 'rls_enabled_on_data_tables',
       not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'ogevia' and c.relkind = 'r' and not c.relrowsecurity
                     and c.relname not in ('permissions', 'role_permissions')),
       null
union all
select 'no_bytea_columns', not exists (select 1 from information_schema.columns
                                       where table_schema = 'ogevia' and data_type = 'bytea'), null;
