-- 0086 read-only target verification. Operator: Stella Okereke. READ ONLY: no insert, update, delete, DDL or function that writes.
-- Run ONLY on database ogevia_sv_test (the same RDS instance also holds production ogevia_prd).
-- Output is counts and settings only. Do not paste names, emails or secrets anywhere.
begin read only;
set local role ogevia_readonly;          -- if this fails, stop and report; do not switch to a more powerful role
set local statement_timeout = '15s';

-- V1 GUARD. Must return ogevia_sv_test. If it returns anything else: STOP, ROLLBACK, report.
select current_database() as db, current_user as role_in_use, (current_database() = 'ogevia_sv_test') as is_test_db;

-- V2 migration ledger. Expect latest 0085 and count 85 (0086 not yet applied). Lower: report (contiguity rule, runbook B).
select count(*) as n, max(version) as latest from ogevia_meta.schema_migrations;
select version from ogevia_meta.schema_migrations order by version desc limit 5;

-- V3 0086 not already present. Expect null.
select to_regclass('ogevia.caregiver_work_approvals') as already_has_0086;

-- V4 baseline counts for the post-apply comparison (counts only).
select count(*) filter (where status in ('ready','active')) as ready_or_active, count(*) as caregivers
  from ogevia.caregiver_records where deleted_at is null;

-- V5 ENFORCEMENT (decision D10 depends on it). Expect null (report-only). Non-null means TEST already enforces: report to the owner at once.
select o.slug, s.enforcement_active_from, s.service_checks
  from ogevia.organizations o left join ogevia.organization_readiness_settings s on s.organization_id = o.id
 order by o.slug;

-- V6 ORGANIZATIONS on TEST (decision D11). Record the number: 1 = cross-agency UAT not possible by hand; 2 or more = X1 to X3 apply.
select count(*) as organizations, count(*) filter (where status = 'active') as active_organizations from ogevia.organizations;

-- V7 UAT account roles (decision D23): counts of ACTIVE memberships per organization and role; no names, emails or ids.
-- Answers "does a synthetic Owner exist in TEST?" (an organization_owner row in ogevia-test-slice or scs-pilot-synthetic). The Operator decides which accounts are synthetic.
select o.slug, m.role, m.status, count(*) as accounts
  from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id
 where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic')
 group by o.slug, m.role, m.status order by o.slug, m.role, m.status;

rollback;
