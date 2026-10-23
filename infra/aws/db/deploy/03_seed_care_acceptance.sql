-- TEST SLICE / care-request acceptance seed (after migration 0011).
-- SYNTHETIC ONLY. Adds one link-only replacement caregiver (no login; offers
-- reach it through caregiver links) with explicit weekly availability, so the
-- call-out -> replacement path can be accepted in the browser. Idempotent.
\set ON_ERROR_STOP on
-- Synthetic seed data is loaded ONLY into the TEST database. A production or any other database refuses before anything is written.
select current_database() = 'ogevia_sv_test' as in_test \gset
\if :in_test
\else
  do $$ begin raise exception 'Refusing: synthetic seed data is loaded only into ogevia_sv_test (this is a different database).'; end $$;
\endif
begin;
insert into ogevia.caregiver_records (id, organization_id, linked_user_id, caregiver_code, first_name, last_name, status)
values ('7e570000-0000-4000-8000-0000000000b2', '7e570000-0000-4000-8000-000000000001', null, 'TEST-CG-02', 'Replacement', 'Caregiver', 'active')
on conflict (organization_id, caregiver_code) do nothing;
insert into ogevia.caregiver_availability_windows (organization_id, caregiver_record_id, weekday, specific_date, start_local, end_local)
select '7e570000-0000-4000-8000-000000000001', '7e570000-0000-4000-8000-0000000000b2', d, null, '06:00', '22:00'
from generate_series(0, 6) d
where not exists (select 1 from ogevia.caregiver_availability_windows w
                  where w.caregiver_record_id = '7e570000-0000-4000-8000-0000000000b2' and w.weekday = d);
commit;
select count(*) as replacement_windows from ogevia.caregiver_availability_windows
where caregiver_record_id = '7e570000-0000-4000-8000-0000000000b2';
