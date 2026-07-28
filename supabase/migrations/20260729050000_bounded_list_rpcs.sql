begin;

-- Same unbounded-growth class already fixed for list_audit_logs, list_incidents
-- (keyset pagination) and list_shifts (rolling window) - these three RPCs return
-- every non-deleted row for the organization with no limit at all. An agency
-- with years of authorization history, caregiver credentials, or applicant
-- volume will eventually feel this as a slow-loading page and an ever-growing
-- RPC payload.
--
-- This is the minimal fix: a default-capped result_limit (200, ceiling 500),
-- same shape list_shifts originally shipped with before later getting a
-- dedicated windowing scheme. No cursor/keyset param is added here - none of
-- the three callers (authorizations-page.tsx, credentials-page.tsx,
-- applicants-page.tsx) currently need "load more" UX the way audit-page.tsx
-- and incidents-page.tsx did, since none of them showed signs of routinely
-- exceeding a couple hundred rows. If that changes, a follow-up build can
-- extend these the same way list_incidents was extended, without breaking
-- this signature (result_limit already defaults to preserve today's
-- behavior for any caller that doesn't pass it).
--
-- list_client_authorizations here is redefined from its current live shape
-- (per 20260721010000_services_and_authorization_usage.sql, which itself
-- superseded 20260719260000's original version) - only the limit clause is
-- new, every column/join/computation is unchanged.

drop function if exists public.list_client_authorizations(uuid);

create function public.list_client_authorizations(
  target_organization_id uuid,
  result_limit integer default 200
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  service_id uuid,
  service_name text,
  payer text,
  authorization_number text,
  max_monthly_hours numeric,
  period_start date,
  period_end date,
  notes text,
  hours_used_this_month numeric,
  hours_scheduled_this_month numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.client_id,
    c.first_name || ' ' || c.last_name,
    a.service_id,
    sv.name,
    a.payer,
    a.authorization_number,
    a.max_monthly_hours,
    a.period_start,
    a.period_end,
    a.notes,
    usage.hours_used_this_month,
    usage.hours_scheduled_this_month
  from public.client_authorizations a
  join public.clients c on c.id = a.client_id
  join public.services sv on sv.id = a.service_id
  cross join lateral (
    select
      coalesce(
        sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
          filter (where s.status = 'completed'),
        0
      ) as hours_used_this_month,
      coalesce(
        sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
          filter (where s.status = 'scheduled'),
        0
      ) as hours_scheduled_this_month
    from (
      select
        greatest(date_trunc('month', now()), a.period_start::timestamptz) as window_start,
        least(date_trunc('month', now()) + interval '1 month', a.period_end::timestamptz + interval '1 day') as window_end
    ) w
    left join public.shifts s
      on s.client_id = a.client_id
     and s.service_id = a.service_id
     and s.organization_id = a.organization_id
     and s.status in ('completed', 'scheduled')
     and s.starts_at < w.window_end
     and s.ends_at > w.window_start
  ) usage
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and public.has_permission(target_organization_id, 'authorizations.read')
  order by a.period_start desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_client_authorizations(uuid, integer) from public;
grant execute on function public.list_client_authorizations(uuid, integer) to authenticated;
revoke execute on function public.list_client_authorizations(uuid, integer) from anon;

drop function if exists public.list_caregiver_credentials(uuid);

create function public.list_caregiver_credentials(
  target_organization_id uuid,
  result_limit integer default 200
)
returns table (
  id uuid,
  caregiver_user_id uuid,
  caregiver_name text,
  credential_type text,
  issued_date date,
  expires_at date,
  notes text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.caregiver_user_id,
    coalesce(p.display_name, 'Unknown member'),
    c.credential_type,
    c.issued_date,
    c.expires_at,
    c.notes,
    c.created_at
  from public.caregiver_credentials c
  join public.user_profiles p on p.id = c.caregiver_user_id
  where c.organization_id = target_organization_id
    and c.deleted_at is null
    and (
      public.has_permission(target_organization_id, 'credentials.read')
      or c.caregiver_user_id = auth.uid()
    )
  order by c.expires_at nulls last, c.credential_type
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_caregiver_credentials(uuid, integer) from public;
grant execute on function public.list_caregiver_credentials(uuid, integer) to authenticated;
revoke execute on function public.list_caregiver_credentials(uuid, integer) from anon;

drop function if exists public.list_applicants(uuid);

create function public.list_applicants(
  target_organization_id uuid,
  result_limit integer default 200
)
returns table (
  id uuid,
  first_name text,
  last_name text,
  email citext,
  phone text,
  status public.applicant_status,
  desired_weekly_hours numeric,
  created_at timestamptz,
  reviewed_by uuid,
  reviewed_by_name text,
  hired_caregiver_user_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.first_name,
    a.last_name,
    a.email,
    a.phone,
    a.status,
    a.desired_weekly_hours,
    a.created_at,
    a.reviewed_by,
    rp.display_name,
    a.hired_caregiver_user_id
  from public.job_applicants a
  left join public.user_profiles rp on rp.id = a.reviewed_by
  where a.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'applicants.read')
  order by a.created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_applicants(uuid, integer) from public;
grant execute on function public.list_applicants(uuid, integer) to authenticated;
revoke execute on function public.list_applicants(uuid, integer) from anon;

commit;
