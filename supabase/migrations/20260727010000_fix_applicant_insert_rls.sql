begin;

-- Bug fix: both public-insert policies on the applicant tables checked
-- an EXISTS(...) subquery against a table anon has no RLS-granted read
-- access to (organizations, job_applicants) - RLS applies to subqueries
-- inside a policy expression the same as any other query, so those
-- EXISTS checks silently evaluated false for every anon request and
-- blocked every public submission. Fixed with SECURITY DEFINER helper
-- functions that check the condition internally, bypassing RLS for
-- just that narrow check - same pattern has_permission() and
-- get_organization_by_slug() already use.

create or replace function public.organization_accepts_applications(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = target_organization_id and o.status = 'active' and o.deleted_at is null
  );
$$;

revoke all on function public.organization_accepts_applications(uuid) from public;
grant execute on function public.organization_accepts_applications(uuid) to anon, authenticated;

create or replace function public.applicant_open_for_submission(target_applicant_id uuid, target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.job_applicants ja
    where ja.id = target_applicant_id
      and ja.organization_id = target_organization_id
      and ja.status = 'new'
  );
$$;

revoke all on function public.applicant_open_for_submission(uuid, uuid) from public;
grant execute on function public.applicant_open_for_submission(uuid, uuid) to anon, authenticated;

drop policy "public_submit_applications" on public.job_applicants;
create policy "public_submit_applications"
on public.job_applicants for insert
to anon, authenticated
with check (
  status = 'new'
  and reviewed_by is null
  and reviewed_at is null
  and hired_caregiver_user_id is null
  and public.organization_accepts_applications(organization_id)
);

drop policy "public_submit_application_availability" on public.job_applicant_availability;
create policy "public_submit_application_availability"
on public.job_applicant_availability for insert
to anon, authenticated
with check (public.applicant_open_for_submission(applicant_id, organization_id));

commit;
