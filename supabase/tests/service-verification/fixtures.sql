-- SYNTHETIC fixtures for the visit <-> scheduled shift link tests.
-- Shift times are relative to now() so the real Time In logic is exercised.
--   org1 ...0001, client c1 ...00c1, services s1 ...00e1 / s2 ...00e2
--   manager user ...0a00; caregivers k = 0..9: user ...010k, record ...020k
insert into public.organizations (id, slug) values
  ('00000000-0000-4000-8000-000000000001', 'synthetic-agency');
insert into public.clients (id, organization_id, client_code) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'TEST-C01');
insert into public.services (id, organization_id, name, code) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', 'Respite (synthetic)', 'RSP'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000001', 'Personal care (synthetic)', 'PC');
insert into public.client_authorizations (organization_id, client_id, service_id, max_monthly_hours, period_start, period_end)
select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', s, 500,
       (now() - interval '60 days')::date, (now() + interval '60 days')::date
from unnest(array['00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2']::uuid[]) s;

insert into public.user_profiles (id, display_name) values ('00000000-0000-4000-8000-000000000a00', 'Synthetic Manager');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000a00', 'manager');

insert into public.user_profiles (id, display_name)
select ('00000000-0000-4000-8000-00000000010' || k)::uuid, 'Synthetic Caregiver ' || k from generate_series(0, 9) k;
insert into public.organization_memberships (organization_id, user_id, role)
select '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-00000000010' || k)::uuid, 'caregiver'
from generate_series(0, 9) k;
insert into public.caregiver_records (id, organization_id, linked_user_id, first_name, last_name)
select ('00000000-0000-4000-8000-00000000020' || k)::uuid, '00000000-0000-4000-8000-000000000001',
       ('00000000-0000-4000-8000-00000000010' || k)::uuid, 'Caregiver', 'Synthetic ' || k
from generate_series(0, 9) k;
insert into public.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start)
select '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-00000000010' || k)::uuid,
       '00000000-0000-4000-8000-0000000000c1', s, (now() - interval '30 days')::date
from generate_series(0, 9) k,
     unnest(array['00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2']::uuid[]) s;

-- Shifts: id ...030k (and ...0306b for caregiver 6's second shift).
insert into public.shifts (id, organization_id, client_id, caregiver_user_id, caregiver_record_id, service_id, starts_at, ends_at)
values
  -- 0: in progress (used by the negative control on the previous function)
  ('00000000-0000-4000-8000-000000000300', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000200', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '30 minutes', now() + interval '3 hours'),
  -- 1: in progress -> linked
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '30 minutes', now() + interval '3 hours'),
  -- 2: starts in 45 minutes (inside the early-arrival window) -> linked
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-0000000000e1',
   now() + interval '45 minutes', now() + interval '4 hours'),
  -- 3: starts in 90 minutes (outside the window) -> not linked
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-0000000000e1',
   now() + interval '90 minutes', now() + interval '5 hours'),
  -- 4: in progress but the caregiver called out -> not linked
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '30 minutes', now() + interval '3 hours'),
  -- 5: in progress for the OTHER service; caregiver 5 starts service s1 -> not linked
  ('00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-0000000000e2',
   now() - interval '30 minutes', now() + interval '3 hours'),
  -- 6a: in progress, ending in 10 minutes; 6b: starts in 40 minutes -> 6a wins
  ('00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000206', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '3 hours', now() + interval '10 minutes'),
  ('00000000-0000-4000-8000-00000000036b', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000206', '00000000-0000-4000-8000-0000000000e1',
   now() + interval '40 minutes', now() + interval '4 hours'),
  -- 7: in progress but already has a live (signed) visit -> not linked again
  ('00000000-0000-4000-8000-000000000307', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000207', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '30 minutes', now() + interval '3 hours'),
  -- 9: another caregiver's shift for the same client/service; caregiver 8 (no shift) must not take it
  ('00000000-0000-4000-8000-000000000309', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000109', '00000000-0000-4000-8000-000000000209', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '30 minutes', now() + interval '3 hours');

insert into public.shift_coverage_events (organization_id, shift_id, event_type) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000304', 'called_out');

insert into public.service_visits (organization_id, client_id, caregiver_user_id, caregiver_record_id, scheduled_shift_id,
                                   service_id, service_date, time_in, time_out, status)
values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000207',
        '00000000-0000-4000-8000-000000000307', '00000000-0000-4000-8000-0000000000e1',
        now()::date, now() - interval '25 minutes', now() - interval '5 minutes', 'signed');
