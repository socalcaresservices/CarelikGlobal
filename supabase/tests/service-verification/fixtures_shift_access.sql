-- SYNTHETIC fixtures for shift-based visit access (20260826080000).
-- Caregivers k = a..e (users ...010k, records ...020k) have NO standing
-- caregiver_assignments row; only shifts.
insert into public.user_profiles (id, display_name)
select ('00000000-0000-4000-8000-00000000010' || k)::uuid, 'Synthetic Caregiver ' || k from unnest(array['a','b','c','d','e']) k;
insert into public.organization_memberships (organization_id, user_id, role)
select '00000000-0000-4000-8000-000000000001', ('00000000-0000-4000-8000-00000000010' || k)::uuid, 'caregiver'
from unnest(array['a','b','c','d','e']) k;
insert into public.caregiver_records (id, organization_id, linked_user_id, first_name, last_name)
select ('00000000-0000-4000-8000-00000000020' || k)::uuid, '00000000-0000-4000-8000-000000000001',
       ('00000000-0000-4000-8000-00000000010' || k)::uuid, 'Caregiver', 'Synthetic ' || k
from unnest(array['a','b','c','d','e']) k;

insert into public.shifts (id, organization_id, client_id, caregiver_user_id, caregiver_record_id, service_id, starts_at, ends_at)
values
  -- a: in progress, service s1 -> may clock in for s1 only
  ('00000000-0000-4000-8000-00000000030a', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-00000000010a', '00000000-0000-4000-8000-00000000020a', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '15 minutes', now() + interval '3 hours'),
  -- b: starts in 90 minutes -> no access yet
  ('00000000-0000-4000-8000-00000000030b', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-00000000010b', '00000000-0000-4000-8000-00000000020b', '00000000-0000-4000-8000-0000000000e1',
   now() + interval '90 minutes', now() + interval '5 hours'),
  -- c: in progress but called out -> no access
  ('00000000-0000-4000-8000-00000000030c', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-00000000010c', '00000000-0000-4000-8000-00000000020c', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '15 minutes', now() + interval '3 hours'),
  -- e: in progress, assigned to e only; d (no shift) must not borrow it.
  -- Shift d is linked by record only (no user id), as the Schedule page writes it.
  ('00000000-0000-4000-8000-00000000030e', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   null, '00000000-0000-4000-8000-00000000020e', '00000000-0000-4000-8000-0000000000e1',
   now() - interval '15 minutes', now() + interval '3 hours');
insert into public.shift_coverage_events (organization_id, shift_id, event_type) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000030c', 'called_out');
