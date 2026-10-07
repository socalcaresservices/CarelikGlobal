-- TEST SLICE / step 3 of 3. SYNTHETIC DATA ONLY: no real clients, no PHI.
-- Run as the RDS master user connected to ogevia_sv_test:
--
--   psql ... -v caregiver_sub="$CAREGIVER_SUB" -v manager_sub="$MANAGER_SUB" -f 02_seed_synthetic_test_slice.sql
--
-- The two subs are the Cognito `sub` values returned by admin-create-user for
-- the two test sign-ins. Idempotent (fixed synthetic ids, ON CONFLICT).
\set ON_ERROR_STOP on
begin;

insert into ogevia.organizations (id, slug, display_name, timezone)
values ('7e570000-0000-4000-8000-000000000001', 'ogevia-test-slice', 'Ogevia Test Agency (synthetic)', 'America/Los_Angeles')
on conflict (id) do nothing;

insert into ogevia.app_users (cognito_sub, display_name)
values (:'caregiver_sub', 'TEST CAREGIVER (synthetic)'), (:'manager_sub', 'TEST MANAGER (synthetic)')
on conflict (cognito_sub) do nothing;

insert into ogevia.organization_memberships (organization_id, user_id, role)
select '7e570000-0000-4000-8000-000000000001', u.id, v.role::ogevia.system_role
from (values (:'caregiver_sub', 'caregiver'), (:'manager_sub', 'manager')) as v(sub, role)
join ogevia.app_users u on u.cognito_sub = v.sub
on conflict (organization_id, user_id) do nothing;

insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name)
select '7e570000-0000-4000-8000-000000000001', u.id, 'TEST-CG-01', 'Test', 'Caregiver'
from ogevia.app_users u where u.cognito_sub = :'caregiver_sub'
on conflict (organization_id, caregiver_code) do nothing;

insert into ogevia.clients (id, organization_id, client_code)
values ('7e570000-0000-4000-8000-0000000000c1', '7e570000-0000-4000-8000-000000000001', 'TEST-C01'),
       ('7e570000-0000-4000-8000-0000000000c2', '7e570000-0000-4000-8000-000000000001', 'TEST-C02')
on conflict (id) do nothing;

insert into ogevia.services (id, organization_id, code, name)
values ('7e570000-0000-4000-8000-0000000000e1', '7e570000-0000-4000-8000-000000000001', 'RSP', 'Respite (synthetic)')
on conflict (id) do nothing;

-- The test caregiver is assigned to both synthetic clients for the service.
insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start)
select '7e570000-0000-4000-8000-000000000001', u.id, c.id, '7e570000-0000-4000-8000-0000000000e1',
       (now() at time zone 'America/Los_Angeles')::date - 1
from ogevia.app_users u
cross join (values ('7e570000-0000-4000-8000-0000000000c1'::uuid), ('7e570000-0000-4000-8000-0000000000c2'::uuid)) as c(id)
where u.cognito_sub = :'caregiver_sub'
  and not exists (
    select 1 from ogevia.caregiver_assignments a
    where a.caregiver_user_id = u.id and a.client_id = c.id and a.service_id = '7e570000-0000-4000-8000-0000000000e1');

-- Authorizations: TEST-C01 10 h/month (normal path), TEST-C02 2 h/month (to
-- exercise limit_reached / exceeds_authorization). Period: this month + 2.
insert into ogevia.client_authorizations
  (id, organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
select v.id, '7e570000-0000-4000-8000-000000000001', v.client_id, '7e570000-0000-4000-8000-0000000000e1',
       'SYNTHETIC-PAYER', v.minutes,
       date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date,
       (date_trunc('month', (now() at time zone 'America/Los_Angeles')) + interval '3 months - 1 day')::date
from (values ('7e570000-0000-4000-8000-0000000000a1'::uuid, '7e570000-0000-4000-8000-0000000000c1'::uuid, 600),
             ('7e570000-0000-4000-8000-0000000000a2'::uuid, '7e570000-0000-4000-8000-0000000000c2'::uuid, 120)) as v(id, client_id, minutes)
on conflict (id) do nothing;

commit;

-- Read-back (counts only).
select (select count(*) from ogevia.organization_memberships where organization_id = '7e570000-0000-4000-8000-000000000001') as memberships,
       (select count(*) from ogevia.caregiver_assignments where organization_id = '7e570000-0000-4000-8000-000000000001') as assignments,
       (select count(*) from ogevia.client_authorizations where organization_id = '7e570000-0000-4000-8000-000000000001') as authorizations;
