-- Assertions for 20260826040000_client_operations_utilization_breakdown.sql.
-- Agency timezone America/Los_Angeles; session UTC; "now" is the real clock
-- (2026-10-02 when written), so 2026-09 is a past month and 2026-11 a future one.
\set ON_ERROR_STOP on
set timezone = 'UTC';
insert into public.organizations values ('00000000-0000-4000-8000-000000000001', 'America/Los_Angeles') on conflict do nothing;
insert into public.services (id, organization_id, name) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', 'Respite'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000001', 'Personal care');
insert into public.clients (id, organization_id, first_name, last_name) values
  ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-000000000001', 'Util', 'Client'),
  ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-000000000001', 'No', 'Service');
insert into public.client_authorizations (organization_id, client_id, service_id, max_monthly_hours, period_start, period_end) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', 40, '2026-09-01', '2026-12-31');
-- Requested: Monday 09:00-13:00 for Respite (240 min); Friday 22:00-06:00 overnight
-- for all services (480 min); Wednesday 10:00-11:00 for Personal care only (not Respite).
insert into public.client_requested_schedule (organization_id, client_id, day_of_week, start_time, end_time, service_id) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', 'monday', '09:00', '13:00', '00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', 'friday', '22:00', '06:00', null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', 'wednesday', '10:00', '11:00', '00000000-0000-4000-8000-0000000000e2');
insert into public.shifts (organization_id, client_id, service_id, starts_at, ends_at, status) values
  -- September (past): completed 240, scheduled-but-past 240, one crossing the month start
  -- (Aug 31 22:00 PDT -> Sep 1 06:00 PDT: 360 min inside September), cancelled + other service ignored.
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-07T16:00:00Z', '2026-09-07T20:00:00Z', 'completed'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-14T16:00:00Z', '2026-09-14T20:00:00Z', 'scheduled'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-01T05:00:00Z', '2026-09-01T13:00:00Z', 'completed'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-21T16:00:00Z', '2026-09-21T20:00:00Z', 'cancelled'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e2', '2026-09-09T17:00:00Z', '2026-09-09T18:00:00Z', 'completed'),
  -- November (future): 240 scheduled.
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-11-02T17:00:00Z', '2026-11-02T21:00:00Z', 'scheduled');
insert into public.service_visits (organization_id, client_id, service_id, service_date, status, worked_minutes, verified_minutes, billable_minutes) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-07', 'signed', 240, 240, 240),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-14', 'administrator_review', 60, 0, 0),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-15', 'corrected', 240, 240, 240),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-16', 'draft', 100, null, null),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000e1', '2026-09-17', 'voided', 90, 90, 90);
do $$
declare r record;
begin
  select * into r from public.list_client_operations('00000000-0000-4000-8000-000000000001', '2026-09-01')
   where client_id = '00000000-0000-4000-8000-0000000000c4' and service_id = '00000000-0000-4000-8000-0000000000e1';
  -- Requested: 4 Mondays x 240 + 4 Fridays x 480 (overnight, all-services window) = 2880.
  assert r.requested_minutes = 2880, format('requested %s', r.requested_minutes);
  -- Scheduled: 240 + 240 + 360 (agency-local month clamp); cancelled / other service excluded.
  assert r.scheduled_minutes = 840, format('scheduled %s', r.scheduled_minutes);
  assert r.upcoming_scheduled_minutes = 0, format('past month upcoming %s', r.upcoming_scheduled_minutes);
  -- Worked = signed + administrator review; corrected original, draft, voided excluded.
  assert r.worked_minutes = 300 and r.delivered_minutes = 300, format('worked %s delivered %s', r.worked_minutes, r.delivered_minutes);
  assert r.confirmed_minutes = 240 and r.billable_minutes = 240, format('confirmed %s billable %s', r.confirmed_minutes, r.billable_minutes);
  assert r.remaining_minutes = 2400 - 300 and r.projected_minutes = 300, format('remaining %s projected %s', r.remaining_minutes, r.projected_minutes);

  select * into r from public.list_client_operations('00000000-0000-4000-8000-000000000001', '2026-11-01')
   where client_id = '00000000-0000-4000-8000-0000000000c4' and service_id = '00000000-0000-4000-8000-0000000000e1';
  -- November: 5 Mondays x 240 + 4 Fridays x 480 = 3120; the 240-minute shift is all still ahead.
  assert r.requested_minutes = 3120, format('Nov requested %s', r.requested_minutes);
  assert r.scheduled_minutes = 240 and r.upcoming_scheduled_minutes = 240, format('Nov scheduled %s upcoming %s', r.scheduled_minutes, r.upcoming_scheduled_minutes);
  assert r.worked_minutes = 0 and r.projected_minutes = 240 and r.remaining_minutes = 2400 - 240, format('Nov projected %s remaining %s', r.projected_minutes, r.remaining_minutes);

  -- A client with no service: no breakdown, null remaining/projected.
  select * into r from public.list_client_operations('00000000-0000-4000-8000-000000000001', '2026-09-01')
   where client_id = '00000000-0000-4000-8000-0000000000c5';
  assert r.service_id is null and r.requested_minutes = 0 and r.projected_minutes is null and r.remaining_minutes is null, format('no-service row %s', row_to_json(r));
  -- Grants unchanged.
  assert has_function_privilege('authenticated', 'public.list_client_operations(uuid,date)', 'execute'), 'authenticated grant';
  assert not has_function_privilege('anon', 'public.list_client_operations(uuid,date)', 'execute'), 'anon revoked';
  raise notice 'utilization breakdown assertions: all passed';
end $$;
