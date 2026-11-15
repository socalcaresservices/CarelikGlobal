-- READ-ONLY production verification for the sign-in override release (migration 0103). Run it BEFORE the API change and again AFTER.
-- It writes nothing: every statement is a SELECT, and section 9 runs inside a transaction that is always rolled back.
-- Run through the usual private path (SSM port-forward to the admin host, psql to ogevia_prd), then paste the whole output back for review:
--   psql -X -d ogevia_prd -f VERIFY_PRODUCTION_DB.sql
-- Section 9 needs two optional psql variables; skip it (it is skipped when they are unset) or set them first:
--   \set org '<organization uuid>'      \set admin_sub '<the Cognito sub of an organization owner or administrator>'
-- PASS lines say what each row must show. Anything else is a STOP: do not enable the routes.
\pset pager off
\pset null '(null)'

\echo '== 1. Right database; ledger has all 107 rows and the exact 0103 checksum'
select current_database() as db, current_database() = 'ogevia_prd' as pass_is_prd;
select count(*) as ledger_rows, count(*) = 107 as pass_107 from ogevia_meta.schema_migrations;
select version, name, checksum,
       checksum = '963d8cf4e7c8bdfa7da38d2719d4a4be2f7dafd7ab50e371c4e2ae1a567dfe54' as pass_0103_checksum
  from ogevia_meta.schema_migrations where version = '0103';

\echo '== 2. Objects exist (every value must be true)'
select to_regclass('ogevia.caregiver_signin_overrides') is not null as table_exists,
       to_regprocedure('ogevia_api.approve_signin_override(uuid,uuid,text)') is not null as approve_fn,
       to_regprocedure('ogevia_api.list_signin_overrides(uuid)') is not null as list_fn,
       to_regprocedure('ogevia.caregiver_has_signin_override(uuid,uuid)') is not null as helper_fn,
       pg_get_functiondef('ogevia.caregiver_readiness(uuid,uuid)'::regprocedure) like '%caregiver_has_signin_override%' as readiness_has_override_branch;

\echo '== 3. Owners: the table and the functions that write it must have the SAME owner (a definer that does not own an RLS table cannot write it)'
select 'table' as kind, 'caregiver_signin_overrides' as name, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls_on, c.relforcerowsecurity as rls_forced
  from pg_class c where c.oid = 'ogevia.caregiver_signin_overrides'::regclass
union all
select 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner), p.prosecdef, null
  from pg_proc p where p.oid in ('ogevia_api.approve_signin_override(uuid,uuid,text)'::regprocedure, 'ogevia_api.list_signin_overrides(uuid)'::regprocedure,
                                 'ogevia.caregiver_has_signin_override(uuid,uuid)'::regprocedure, 'ogevia.caregiver_readiness(uuid,uuid)'::regprocedure);
-- PASS: every owner is ogevia_owner; rls_on = true; rls_forced = false.

\echo '== 4. Application grants: ogevia_app may EXECUTE the two API functions; PUBLIC may not'
select p.oid::regprocedure::text as fn,
       has_function_privilege('ogevia_app', p.oid, 'EXECUTE') as pass_app_can_execute,
       not has_function_privilege('public', p.oid, 'EXECUTE') as pass_public_cannot
  from pg_proc p where p.oid in ('ogevia_api.approve_signin_override(uuid,uuid,text)'::regprocedure, 'ogevia_api.list_signin_overrides(uuid)'::regprocedure);

\echo '== 5. The functions run as ogevia_owner: it must be able to EXECUTE everything the approval path calls and read/write what it touches'
select p.proname, pg_get_userbyid(p.proowner) as owner, has_function_privilege('ogevia_owner', p.oid, 'EXECUTE') as pass_owner_can_execute
  from pg_proc p
 where p.pronamespace = 'ogevia'::regnamespace
   and p.proname in ('require_actor','is_active_member','has_permission','lock_caregiver','caregiver_has_signed_in','background_clearance_state',
                     'write_audit','caregiver_readiness_summary','caregiver_readiness','caregiver_has_signin_override','append_only_guard')
 order by p.proname, p.oid;
select c.relname, pg_get_userbyid(c.relowner) as owner,
       has_table_privilege('ogevia_owner', c.oid, 'SELECT') as pass_owner_select,
       has_table_privilege('ogevia_owner', c.oid, 'INSERT') as owner_insert
  from pg_class c
 where c.oid in ('ogevia.caregiver_signin_overrides'::regclass, 'ogevia.caregiver_records'::regclass, 'ogevia.caregiver_invitations'::regclass,
                 'ogevia.caregiver_background_checks'::regclass, 'ogevia.app_users'::regclass, 'ogevia.audit_events'::regclass, 'ogevia.organizations'::regclass)
 order by c.relname;
-- PASS: every pass_* is true; owner_insert is true for caregiver_signin_overrides and audit_events. A false in this section is the same class of defect as the
-- business_documents / action_issue_rows failures of 2026-11-14: a definer function that cannot read something owned by another role.

\echo '== 6. Permission rows: only organization_owner and organization_admin hold caregivers.signin_override'
select p.key, (select string_agg(rp.role::text, ', ' order by rp.role::text) from ogevia.role_permissions rp where rp.permission_key = p.key) as roles
  from ogevia.permissions p where p.key = 'caregivers.signin_override';
-- PASS: one row; roles = organization_admin, organization_owner.

\echo '== 7. Who will see the action in production (active members holding the permission, by agency)'
select o.slug, m.role, count(*) as active_members
  from ogevia.organization_memberships m
  join ogevia.role_permissions rp on rp.role = m.role and rp.permission_key = 'caregivers.signin_override'
  join ogevia.organizations o on o.id = m.organization_id
 where m.status = 'active'
 group by o.slug, m.role order by 1, 2;

\echo '== 8. Append-only trigger and table policies; current override rows (expected 0 before the first approval)'
select tgname, tgenabled from pg_trigger where tgrelid = 'ogevia.caregiver_signin_overrides'::regclass and not tgisinternal;
select polname, polcmd, polroles::regrole[]::text as roles from pg_policy where polrelid = 'ogevia.caregiver_signin_overrides'::regclass;
select count(*) as override_rows_now from ogevia.caregiver_signin_overrides;

\echo '== 9. (optional) Function path as the real application role, rolled back: list_signin_overrides for an administrator'
\if :{?org}
\if :{?admin_sub}
begin;
set local role ogevia_app;
select ogevia_api.begin_request(:'admin_sub', gen_random_uuid());
select count(*) as visible_override_rows from ogevia_api.list_signin_overrides(:'org'::uuid);
rollback;
\else
\echo 'skipped: set admin_sub'
\endif
\else
\echo 'skipped: set org and admin_sub'
\endif

\echo '== done. Nothing was written.'
