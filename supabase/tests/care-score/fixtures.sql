-- Client C1 records all three needs: language, care need, two requested windows.
-- A (complete, partial fit): login caregiver with the skill, a 20 h target and
--   availability covering ONE of the two windows.
-- B (incomplete profile): no login (no skills), no hours target, no availability.
-- Client C2 records no needs at all.
insert into public.clients values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', '90001', 'Los Angeles', 'CA', '{Spanish}', '{dementia}'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001', '90001', 'Los Angeles', 'CA', '{}', '{}');
insert into public.client_requested_schedule (organization_id, client_id, day_of_week, start_time, end_time) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'monday', '09:00', '13:00'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'wednesday', '09:00', '13:00');
insert into public.user_profiles values ('00000000-0000-4000-8000-0000000000a0', '{dementia}');
insert into public.caregiver_records (id, organization_id, linked_user_id, first_name, last_name, address_zip, address_city, address_state, languages, desired_weekly_hours) values
  ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a0', 'Alex', 'Complete', '90001', 'Los Angeles', 'CA', '{Spanish}', 20),
  ('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', null, 'Blair', 'Incomplete', '90001', 'Los Angeles', 'CA', '{Spanish}', null),
  ('00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-000000000001', null, 'Dana', 'NoLocation', null, null, null, '{}', 20);
insert into public.caregiver_record_availability (organization_id, caregiver_record_id, day_of_week, start_time, end_time) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a', 'monday', '08:00', '14:00');
