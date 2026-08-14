-- Non-production QA fixture for Candidate/Hiring V1.
-- Run with psql after setting the target organization explicitly:
--   psql "$DATABASE_URL" -v organization_id="<demo-org-uuid>" -f supabase/demo/candidate_hiring_demo_data.sql
-- The script refuses to run without organization_id and is idempotent by its
-- clearly synthetic @example.test email addresses.

\if :{?organization_id}
\else
  \echo 'organization_id is required; no data was written'
  \quit
\endif

begin;

delete from public.clients
where organization_id = :'organization_id'::uuid
  and email like 'random.client.%@example.test';

insert into public.clients (organization_id, first_name, last_name, email, phone, address, care_notes, status)
select :'organization_id'::uuid, 'Random', 'Client ' || n,
  'random.client.' || n || '@example.test', '555-010' || n,
  (100 + n) || ' Demo Street', 'TEST DATA ONLY - client workflow fixture ' || n, 'active'
from generate_series(1, 5) n;

delete from public.caregiver_records
where organization_id = :'organization_id'::uuid
  and email like 'random.caregiver.%@example.test';

with caregivers as (
  insert into public.caregiver_records (
    organization_id, first_name, last_name, email, phone, status,
    employment_type, desired_weekly_hours, min_weekly_hours, max_weekly_hours,
    min_shift_hours, max_shift_hours, max_travel_minutes, languages
  )
  select :'organization_id'::uuid, 'Random', 'Caregiver ' || n,
    'random.caregiver.' || n || '@example.test', '555-020' || n, 'active',
    case when n % 2 = 0 then 'part_time' else 'full_time' end,
    20 + (n * 4), 16, 40, 4, 12, 30, array['English']::text[]
  from generate_series(1, 5) n
  returning id, email
)
insert into public.caregiver_record_availability (
  organization_id, caregiver_record_id, day_of_week, start_time, end_time, preference
)
select :'organization_id'::uuid, id, day_name::public.weekday, start_at::time, end_at::time, preference::public.availability_preference
from caregivers
cross join (values
  ('monday', '08:00', '12:00', 'preferred'),
  ('monday', '14:00', '18:00', 'available'),
  ('tuesday', '09:00', '17:00', 'available')
) slots(day_name, start_at, end_at, preference);

commit;
