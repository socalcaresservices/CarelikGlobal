-- Cross-agency isolation check, TEST only. READ ONLY: no insert, update, delete, DDL or function that writes.
-- Run ONLY on database ogevia_sv_test (the same RDS instance also holds production ogevia_prd). Synthetic organizations only.
-- Output: ids (random UUIDs, no names or emails) and counts. Use the ids for steps X2 and X4 of CROSS_AGENCY_ISOLATION_PLAN.md.
begin read only;
set local role ogevia_readonly;          -- if this fails, stop and report; do not switch to a more powerful role
set local statement_timeout = '15s';

-- G1 GUARD. Must return ogevia_sv_test. If it returns anything else: STOP, ROLLBACK, report.
select current_database() as db, current_user as role_in_use, (current_database() = 'ogevia_sv_test') as is_test_db;

-- G2 the two organizations of the check (both must be present and active).
select o.slug, o.status, o.id::text as organization_id from ogevia.organizations o where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic') order by o.slug;

-- G3 sign-in accounts per organization and role: counts only (the check needs a separate Manager in each organization and a Caregiver in scs-pilot-synthetic).
select o.slug, m.role, m.status, count(*) as accounts
  from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id
 where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic')
 group by o.slug, m.role, m.status order by o.slug, m.role, m.status;

-- G4 one caregiver record id and one client id per organization, for the by-address attempts (X2, X4).
select o.slug, 'caregiver' as kind, (select cr.id::text from ogevia.caregiver_records cr where cr.organization_id = o.id order by cr.id limit 1) as id
  from ogevia.organizations o where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic')
union all
select o.slug, 'client', (select c.id::text from ogevia.clients c where c.organization_id = o.id order by c.id limit 1)
  from ogevia.organizations o where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic')
order by 1, 2;

-- G5 baseline and after-counts per organization (run once before the steps, once after; the two outputs must be identical).
select o.slug,
       (select count(*) from ogevia.caregiver_records cr where cr.organization_id = o.id) as caregivers,
       (select count(*) from ogevia.clients c where c.organization_id = o.id) as clients,
       (select count(*) from ogevia.audit_events a where a.organization_id = o.id) as audit_events,
       (select count(*) from ogevia.organization_memberships m where m.organization_id = o.id) as memberships
  from ogevia.organizations o where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic') order by o.slug;

-- G6 separation: how many sign-in users hold a membership in BOTH organizations. Must be 0 (the check needs separate accounts).
select count(*) as users_in_both_orgs from (
  select m.user_id from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id
   where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic') group by m.user_id having count(distinct o.id) = 2) x;

-- G7 which account is which: organization, role, status and the first 8 characters of the sign-in subject (match them with the TEST sign-in pool; no names or emails).
select o.slug, m.role, m.status, left(u.cognito_sub, 8) as sub_prefix
  from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id join ogevia.app_users u on u.id = m.user_id
 where o.slug in ('ogevia-test-slice', 'scs-pilot-synthetic') order by o.slug, m.role, sub_prefix;

rollback;
