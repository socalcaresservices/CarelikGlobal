begin;

-- Employment Preferences step of the wizard redesign needs two fields
-- that didn't exist yet: the employment type an applicant is looking
-- for, and the date they're available to start. Both nullable - an
-- applicant who hasn't decided on a start date yet shouldn't be
-- blocked from submitting.

create type public.employment_type as enum ('full_time', 'part_time', 'per_diem', 'contractor');

alter table public.job_applicants
  add column employment_type public.employment_type,
  add column available_start_date date;

commit;
