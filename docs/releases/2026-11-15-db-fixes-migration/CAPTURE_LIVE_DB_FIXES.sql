-- READ-ONLY capture of the exact LIVE definitions of the two manual production fixes of 2026-11-14 (business_documents SELECT grant + policy; EXECUTE on action_issue_rows).
-- Writes nothing: only SELECTs on the system catalogs, no table data. Output has no client or caregiver data, only role, object and privilege names.
-- Run through the usual private path (temporary window, SSM port-forward, psql to ogevia_prd), then paste the WHOLE output back for review:
--   psql -X -d ogevia_prd -f CAPTURE_LIVE_DB_FIXES.sql | tee /tmp/capture-live-db-fixes.txt
-- (psql variable expected_db defaults to ogevia_prd; only a local test changes it.)
\pset pager off
\pset null '(null)'
\if :{?expected_db}
\else
\set expected_db ogevia_prd
\endif

\echo '== 1. Database and ledger'
select current_database() as db, current_database() = :'expected_db' as is_expected_db;
select count(*) as ledger_rows, max(version) as ledger_max from ogevia_meta.schema_migrations;

\echo '== 2. ogevia.business_documents: owner, ACL, row-level security'
select pg_get_userbyid(c.relowner) as owner, c.relacl::text as acl, c.relrowsecurity as rls_on, c.relforcerowsecurity as rls_forced
  from pg_class c where c.oid = 'ogevia.business_documents'::regclass;

\echo '== 3. Policies on ogevia.business_documents (every policy, exact definition)'
select p.polname, p.polcmd, p.polpermissive, p.polroles::regrole[]::text as roles,
       pg_get_expr(p.polqual, p.polrelid) as using_expr, pg_get_expr(p.polwithcheck, p.polrelid) as with_check_expr
  from pg_policy p where p.polrelid = 'ogevia.business_documents'::regclass order by p.polname;

\echo '== 4. Column-level privileges on ogevia.business_documents (should be none)'
select a.attname, a.attacl::text as column_acl from pg_attribute a
 where a.attrelid = 'ogevia.business_documents'::regclass and a.attnum > 0 and not a.attisdropped and a.attacl is not null;

\echo '== 5. ogevia.action_issue_rows and the function it wraps: every overload, owner, ACL, definer, search_path'
select p.oid::regprocedure::text as function, pg_get_userbyid(p.proowner) as owner, p.proacl::text as acl, p.prosecdef as security_definer, p.proconfig::text as config
  from pg_proc p where p.pronamespace = 'ogevia'::regnamespace and p.proname in ('action_issue_rows', 'operational_action_issue_rows') order by 1;

\echo '== 6. Effective privileges of ogevia_owner (what the migration states)'
select has_table_privilege('ogevia_owner', 'ogevia.business_documents', 'SELECT') as owner_can_select_business_documents,
       has_function_privilege('ogevia_owner', 'ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer)'::regprocedure, 'EXECUTE') as owner_can_execute_action_issue_rows;

\echo '== 7. Roles involved (attributes and memberships: the migration runner role must be one that can grant)'
select r.rolname, r.rolsuper, r.rolcreaterole, r.rolbypassrls, r.rolinherit, r.rolcanlogin,
       (select string_agg(g.rolname, ', ' order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid) as member_of
  from pg_roles r where r.rolname in ('ogevia_owner', 'ogevia_admin', 'ogevia_app', 'ogevia_prd_app', 'ogevia_readonly') order by 1;
select current_user as running_as, session_user as session_user,
       case when to_regrole('ogevia_admin') is not null then pg_has_role(current_user, 'ogevia_admin', 'MEMBER') end as member_of_ogevia_admin,
       case when to_regrole('ogevia_owner') is not null then pg_has_role(current_user, 'ogevia_owner', 'MEMBER') end as member_of_ogevia_owner;

\echo '== 8. Functions that run as ogevia_owner and read the table (owner and definer flag)'
select p.oid::regprocedure::text as function, pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer
  from pg_proc p where p.proname in ('system_compliance_orgs', 'system_compliance_sweep_org', 'list_my_notifications', 'get_attention_counts', 'get_attention_summary', 'get_attention_overview')
   and p.pronamespace in ('ogevia'::regnamespace, 'ogevia_api'::regnamespace) order by 1;

\echo '== 9. Other tables and functions owned by ogevia_admin in schemas ogevia and ogevia_api (the wider drift; not changed by 0108)'
select 'table' as kind, n.nspname || '.' || c.relname as name, c.relacl::text as acl, c.relrowsecurity as rls_on
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where pg_get_userbyid(c.relowner) = 'ogevia_admin' and n.nspname in ('ogevia', 'ogevia_api') and c.relkind in ('r', 'p', 'v', 'm', 'S')
union all
select 'function', p.oid::regprocedure::text, p.proacl::text, p.prosecdef
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where pg_get_userbyid(p.proowner) = 'ogevia_admin' and n.nspname in ('ogevia', 'ogevia_api') order by 1, 2;

\echo '== 10. Does the live state match what migration 0108 states? (the migration is a no-op only if every line is true)'
select exists (select 1 from pg_policy p where p.polrelid = 'ogevia.business_documents'::regclass and p.polname = 'owner_definer_select'
                 and p.polcmd = 'r' and p.polpermissive and p.polroles = array[(select oid from pg_roles where rolname = 'ogevia_owner')]
                 and pg_get_expr(p.polqual, p.polrelid) = 'true' and p.polwithcheck is null) as policy_exactly_as_recorded,
       has_table_privilege('ogevia_owner', 'ogevia.business_documents', 'SELECT') as select_effective,
       has_function_privilege('ogevia_owner', 'ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer)'::regprocedure, 'EXECUTE') as execute_effective
\gset
\if :policy_exactly_as_recorded
\if :select_effective
\if :execute_effective
\echo 'CAPTURE VERDICT: MATCHES (migration 0108 would change nothing)'
\else
\echo 'CAPTURE VERDICT: DIFFERS (execute not effective)'
\endif
\else
\echo 'CAPTURE VERDICT: DIFFERS (select not effective)'
\endif
\else
\echo 'CAPTURE VERDICT: DIFFERS (policy absent or defined differently: compare section 3 with the migration)'
\endif

\echo '== done. Nothing was written.'
