-- SCS PILOT (Monday 2026-10-05) / synthetic configuration. SYNTHETIC CLIENT
-- DATA ONLY: no real clients, no PHI, no payer identifiers. Workforce accounts
-- are individual (one Cognito user per person; no shared logins).
--
-- Run as the RDS master user against ogevia_sv_test, AFTER migrations
-- 0001-0016 are applied and AFTER the three Cognito users exist:
--
--   psql ... \
--     -v manager_sub="$MANAGER_SUB" \
--     -v caregiver_a_sub="$CAREGIVER_A_SUB" -v caregiver_a_code=SCS-CG-A \
--     -v caregiver_a_first=... -v caregiver_a_last=... \
--     -v caregiver_b_sub="$CAREGIVER_B_SUB" -v caregiver_b_code=SCS-CG-B \
--     -v caregiver_b_first=... -v caregiver_b_last=... \
--     -v manager_name="..." \
--     -f 04_seed_scs_pilot_synthetic.sql
--
-- Staff names are passed at run time, never committed. Idempotent (fixed
-- synthetic ids, ON CONFLICT / NOT EXISTS). This is a separate organization
-- from the test slice (7e57...0001), so both coexist and every pilot account
-- doubles as a cross-tenant check against the other.
--
-- Deliberately NOT seeded: shifts and reservations. The pilot manager creates
-- them in the app through Care Requests (assign_care_request), the only path
-- that reserves authorization time.
\set ON_ERROR_STOP on
begin;

insert into ogevia.organizations (id, slug, display_name, timezone)
values ('5c500000-0000-4000-8000-000000000001', 'scs-pilot-synthetic',
        'SoCal Care Services - PILOT (synthetic data)', 'America/Los_Angeles')
on conflict (id) do nothing;

insert into ogevia.app_users (cognito_sub, display_name)
values (:'manager_sub', :'manager_name'),
       (:'caregiver_a_sub', :'caregiver_a_first' || ' ' || :'caregiver_a_last'),
       (:'caregiver_b_sub', :'caregiver_b_first' || ' ' || :'caregiver_b_last')
on conflict (cognito_sub) do nothing;

insert into ogevia.organization_memberships (organization_id, user_id, role)
select '5c500000-0000-4000-8000-000000000001', u.id, v.role::ogevia.system_role
from (values (:'manager_sub', 'manager'), (:'caregiver_a_sub', 'caregiver'), (:'caregiver_b_sub', 'caregiver')) as v(sub, role)
join ogevia.app_users u on u.cognito_sub = v.sub
on conflict (organization_id, user_id) do nothing;

insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status)
select '5c500000-0000-4000-8000-000000000001', u.id, v.code, v.first, v.last, 'active'
from (values (:'caregiver_a_sub', :'caregiver_a_code', :'caregiver_a_first', :'caregiver_a_last'),
             (:'caregiver_b_sub', :'caregiver_b_code', :'caregiver_b_first', :'caregiver_b_last')) as v(sub, code, first, last)
join ogevia.app_users u on u.cognito_sub = v.sub
on conflict (organization_id, caregiver_code) do nothing;

-- Random, non-semantic client codes (generated once; not derived from anything).
insert into ogevia.clients (id, organization_id, client_code)
values ('5c500000-0000-4000-8000-0000000000c1', '5c500000-0000-4000-8000-000000000001', 'P-QAUF7'),
       ('5c500000-0000-4000-8000-0000000000c2', '5c500000-0000-4000-8000-000000000001', 'P-AAXRX'),
       ('5c500000-0000-4000-8000-0000000000c3', '5c500000-0000-4000-8000-000000000001', 'P-AHXN7')
on conflict (id) do nothing;

insert into ogevia.services (id, organization_id, code, name)
values ('5c500000-0000-4000-8000-0000000000e1', '5c500000-0000-4000-8000-000000000001', 'RSP', 'Respite (synthetic)')
on conflict (id) do nothing;

-- Standing assignments: caregiver A -> P-QAUF7 and P-AAXRX; caregiver B ->
-- P-AHXN7 only. B reaches P-QAUF7 only through a reassigned (replacement)
-- shift, which exercises shift-based access (0014).
insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start)
select '5c500000-0000-4000-8000-000000000001', u.id, v.client_id, '5c500000-0000-4000-8000-0000000000e1',
       (now() at time zone 'America/Los_Angeles')::date - 1
from (values (:'caregiver_a_sub', '5c500000-0000-4000-8000-0000000000c1'::uuid),
             (:'caregiver_a_sub', '5c500000-0000-4000-8000-0000000000c2'::uuid),
             (:'caregiver_b_sub', '5c500000-0000-4000-8000-0000000000c3'::uuid)) as v(sub, client_id)
join ogevia.app_users u on u.cognito_sub = v.sub
where not exists (
  select 1 from ogevia.caregiver_assignments a
  where a.caregiver_user_id = u.id and a.client_id = v.client_id
    and a.service_id = '5c500000-0000-4000-8000-0000000000e1');

-- Authorizations, this month + 2: P-QAUF7 20 h (clean path), P-AAXRX 3 h
-- (limit_reached / exceeds -> administrator review), P-AHXN7 10 h.
insert into ogevia.client_authorizations
  (id, organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
select v.id, '5c500000-0000-4000-8000-000000000001', v.client_id, '5c500000-0000-4000-8000-0000000000e1',
       'SYNTHETIC-PAYER', v.minutes,
       date_trunc('month', (now() at time zone 'America/Los_Angeles'))::date,
       (date_trunc('month', (now() at time zone 'America/Los_Angeles')) + interval '3 months - 1 day')::date
from (values ('5c500000-0000-4000-8000-0000000000a1'::uuid, '5c500000-0000-4000-8000-0000000000c1'::uuid, 1200),
             ('5c500000-0000-4000-8000-0000000000a2'::uuid, '5c500000-0000-4000-8000-0000000000c2'::uuid, 180),
             ('5c500000-0000-4000-8000-0000000000a3'::uuid, '5c500000-0000-4000-8000-0000000000c3'::uuid, 600)) as v(id, client_id, minutes)
on conflict (id) do nothing;

commit;

-- Read-back (counts only; no names).
select (select count(*) from ogevia.organization_memberships where organization_id = '5c500000-0000-4000-8000-000000000001') as memberships,
       (select count(*) from ogevia.caregiver_records where organization_id = '5c500000-0000-4000-8000-000000000001') as caregiver_records,
       (select count(*) from ogevia.caregiver_assignments where organization_id = '5c500000-0000-4000-8000-000000000001') as assignments,
       (select count(*) from ogevia.client_authorizations where organization_id = '5c500000-0000-4000-8000-000000000001') as authorizations;
