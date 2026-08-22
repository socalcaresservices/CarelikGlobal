begin;

-- clients has client_code ('CL-XXXXXX') and caregiver_records has
-- caregiver_code ('CG-XXXXXX'), both auto-generated from the row's own
-- id with the same trigger shape and per-org unique index. Candidates
-- (job_applicants) never got the equivalent - no human-readable
-- operational ID anywhere, only the raw UUID. Adds candidate_code with
-- the exact same pattern, prefixed 'CA-' to avoid colliding with either
-- existing prefix. Display/reference identifier only (payroll,
-- interview scheduling, support conversations) - does not plug into any
-- existing lookup flow the way client_code does for Service
-- Verification, since candidates aren't looked up by code anywhere yet.
alter table public.job_applicants add column candidate_code text;

create or replace function public.set_default_candidate_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.candidate_code is null or trim(new.candidate_code) = '' then
    new.candidate_code := 'CA-' || upper(substr(replace(new.id::text, '-', ''), 1, 6));
  end if;
  return new;
end;
$$;

revoke all on function public.set_default_candidate_code() from public, anon, authenticated;

create trigger job_applicants_set_default_code
before insert on public.job_applicants
for each row execute function public.set_default_candidate_code();

-- Backfill existing rows the same way the trigger generates new ones.
-- Valid existing rows have no code yet at all (this is a brand new
-- column), so every row gets backfilled the same way - nothing to
-- preserve differently for "already-valid" rows here.
update public.job_applicants
set candidate_code = 'CA-' || upper(substr(replace(id::text, '-', ''), 1, 6))
where candidate_code is null;

alter table public.job_applicants alter column candidate_code set not null;

create unique index job_applicants_org_candidate_code_unique
on public.job_applicants (organization_id, lower(candidate_code));

-- list_candidates_v1 is the only RPC the Candidates list page reads from
-- (the detail page selects job_applicants directly with select("*"),
-- which already picks up the new column with no RPC change needed).
-- Dropped and recreated - adding a column to a RETURNS TABLE list
-- changes the function's OUT-parameter signature, which CREATE OR
-- REPLACE refuses.
drop function if exists public.list_candidates_v1(uuid);

create function public.list_candidates_v1(target_organization_id uuid)
returns table (
  id uuid,
  candidate_code text,
  first_name text,
  last_name text,
  email citext,
  phone text,
  pipeline_stage text,
  source text,
  position_applied_for text,
  applied_at timestamptz,
  desired_weekly_hours numeric,
  available_start_date date,
  imported_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id, a.candidate_code, a.first_name, a.last_name, a.email, a.phone, a.pipeline_stage, a.source,
    a.position_applied_for, coalesce(a.applied_at, a.created_at), a.desired_weekly_hours,
    a.available_start_date, a.imported_at, a.created_at
  from public.job_applicants a
  where a.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'applicants.read')
  order by coalesce(a.applied_at, a.created_at) desc;
$$;

revoke all on function public.list_candidates_v1(uuid) from public, anon;
grant execute on function public.list_candidates_v1(uuid) to authenticated;

commit;
