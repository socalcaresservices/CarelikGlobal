-- Assertions for 20260826030000_overnight_availability.sql. Session timezone
-- is UTC, like a Supabase API connection; the agency is America/Los_Angeles.
\set ON_ERROR_STOP on
set timezone = 'UTC';
insert into public.organizations values ('00000000-0000-4000-8000-000000000001', 'America/Los_Angeles') on conflict do nothing;
insert into public.clients (id, organization_id) values ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000001');
create trigger shifts_link_requested_schedule before insert on public.shifts
  for each row execute function public.link_shift_to_requested_schedule();
do $$
declare ok boolean; r record; n int;
begin
  -- Helpers: same-day, overnight, Sunday->Monday wrap, no false positives.
  assert public.weekly_window('monday', '09:00', '13:00') = int4range(540, 780), 'same-day window';
  assert public.weekly_window('monday', '22:00', '06:00') = int4range(1320, 1800), 'overnight window ends next day';
  assert public.weekly_windows_overlap(public.weekly_window('monday', '22:00', '06:00'), public.weekly_window('tuesday', '01:00', '03:00')), 'overnight covers early next morning';
  assert not public.weekly_windows_overlap(public.weekly_window('monday', '22:00', '06:00'), public.weekly_window('tuesday', '07:00', '09:00')), 'no overlap after it ends';
  assert public.weekly_windows_overlap(public.weekly_window('sunday', '22:00', '06:00'), public.weekly_window('monday', '02:00', '04:00')), 'Sunday night wraps into Monday';
  assert not public.weekly_windows_overlap(public.weekly_window('monday', '09:00', '13:00'), public.weekly_window('monday', '13:00', '15:00')), 'touching windows do not overlap';

  -- Caregiver availability RPC: overnight accepted, equal times and 3 windows/day refused.
  perform public.replace_caregiver_record_availability('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b',
    '[{"day_of_week":"monday","start_time":"22:00","end_time":"06:00"}]');
  select count(*) into n from public.caregiver_record_availability where caregiver_record_id = '00000000-0000-4000-8000-00000000000b' and start_time = '22:00' and end_time = '06:00';
  assert n = 1, 'overnight caregiver window stored as one row on its start day';
  begin
    perform public.replace_caregiver_record_availability('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b',
      '[{"day_of_week":"monday","start_time":"09:00","end_time":"09:00"}]');
    assert false, 'equal start/end accepted';
  exception when raise_exception then null; end;
  begin
    perform public.replace_caregiver_record_availability('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b',
      '[{"day_of_week":"monday","start_time":"06:00","end_time":"10:00"},{"day_of_week":"monday","start_time":"12:00","end_time":"16:00"},{"day_of_week":"monday","start_time":"22:00","end_time":"06:00"}]');
    assert false, 'three windows on one day accepted';
  exception when raise_exception then null; end;
  begin
    insert into public.caregiver_record_availability (organization_id, caregiver_record_id, day_of_week, start_time, end_time)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b', 'friday', '08:00', '08:00');
    assert false, 'table constraint allowed equal times';
  exception when check_violation then null; end;

  -- Client requested schedule RPC: overnight request accepted.
  perform public.replace_client_requested_schedule('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3',
    '[{"day_of_week":"monday","start_time":"23:00","end_time":"05:00"},{"day_of_week":"wednesday","start_time":"09:00","end_time":"13:00"}]');
  select count(*) into n from public.client_requested_schedule where client_id = '00000000-0000-4000-8000-0000000000c3';
  assert n = 2, 'client overnight request stored';

  -- CareScore: Blair's Monday 22:00-06:00 window covers C3's Monday 23:00-05:00
  -- request (1 of 2). Alex's Monday 08:00-14:00 window covers neither request.
  select * into r from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3')
   where caregiver_record_id = '00000000-0000-4000-8000-00000000000b';
  assert r.availability_score = 0 + 4, format('overnight window should match 1 of 2 requests (capacity 0 + 4): %s', row_to_json(r));
  select * into r from public.list_caregiver_matches('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3')
   where caregiver_record_id = '00000000-0000-4000-8000-00000000000a';
  assert r.availability_score = 12 + 0, format('day-only window must not match night/Wednesday requests: %s', row_to_json(r));

  -- Shift -> requested schedule link, in the agency's timezone.
  -- Mon 2026-10-05 23:30 PDT = 2026-10-06 06:30Z, to Tue 04:30 PDT: overnight request.
  insert into public.shifts (organization_id, client_id, starts_at, ends_at)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3', '2026-10-06T06:30:00Z', '2026-10-06T11:30:00Z');
  select count(*) into n from public.shifts s join public.client_requested_schedule c on c.id = s.source_requested_schedule_id
   where s.starts_at = '2026-10-06T06:30:00Z' and c.day_of_week = 'monday' and c.start_time = '23:00';
  assert n = 1, 'overnight shift linked to the overnight request';
  -- Wed 2026-10-07 09:00-12:00 PDT = 16:00-19:00Z: linked by LOCAL time (UTC 16:00 would miss 09:00-13:00).
  insert into public.shifts (organization_id, client_id, starts_at, ends_at)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3', '2026-10-07T16:00:00Z', '2026-10-07T19:00:00Z');
  select count(*) into n from public.shifts s join public.client_requested_schedule c on c.id = s.source_requested_schedule_id
   where s.starts_at = '2026-10-07T16:00:00Z' and c.day_of_week = 'wednesday';
  assert n = 1, 'daytime shift linked using the agency timezone';
  -- Wed 18:00-20:00 PDT matches nothing.
  insert into public.shifts (organization_id, client_id, starts_at, ends_at)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c3', '2026-10-08T01:00:00Z', '2026-10-08T03:00:00Z');
  select count(*) into n from public.shifts where starts_at = '2026-10-08T01:00:00Z' and source_requested_schedule_id is null;
  assert n = 1, 'unrelated shift not linked';
  raise notice 'overnight availability assertions: all passed';
end $$;
