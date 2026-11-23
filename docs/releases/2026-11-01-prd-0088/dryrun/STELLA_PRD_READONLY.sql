-- STELLA_PRD_READONLY.sql: PRODUCTION closing read for the 0086-0088 release. READ ONLY. COUNTS ONLY: no names, no contact details, no identifiers, no record content.
-- Run by STELLA_PRD_DB.sh inside a read-only transaction on ogevia_prd (it refuses any other database).
begin read only;
select current_database() as db, current_setting('transaction_read_only') as read_only;
select count(*) as migrations_applied, max(version) as latest from ogevia_meta.schema_migrations;
select 'organizations' as what, count(*)::text as n from ogevia.organizations;
select 'memberships_by_role_status' as what, role::text || '/' || status::text as k, count(*) as n from ogevia.organization_memberships group by 2 order by 2;
select 'caregivers_by_stored_status' as what, status::text as k, count(*) as n from ogevia.caregiver_records where deleted_at is null group by 2 order by 2;
select 'staff_objects(staff_types|staff_profiles|accept_staff_invitation)' as what,
       (to_regclass('ogevia.staff_types') is not null)::int || '|' || (to_regclass('ogevia.staff_profiles') is not null)::int || '|' ||
       (exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname = 'accept_staff_invitation'))::int as present;
select 'readiness_table' as what, coalesce(to_regclass('ogevia.caregiver_work_approvals')::text, 'absent') as present;
select 'enforcement_agencies(active|rows)' as what,
       (select count(*) filter (where enforcement_active_from is not null) from ogevia.organization_readiness_settings) || '|' || (select count(*) from ogevia.organization_readiness_settings) as n;
select 'active_onboarding_requirements_by_category' as what, category::text as k, count(*) as n from ogevia.onboarding_requirements where is_active group by 2 order by 2;
-- present only after 0088: built as text and run by \gexec, so the statement is never parsed while the table is absent (a NULL result is skipped)
select case when to_regclass('ogevia.caregiver_work_approvals') is not null
            then 'select ''legacy_status_approvals'' as what, count(*)::text as n from ogevia.caregiver_work_approvals where source = ''legacy_status''' end \gexec
rollback;
