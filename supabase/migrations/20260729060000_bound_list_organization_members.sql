begin;

-- Same missing-limit gap already fixed for list_audit_logs, list_incidents,
-- list_shifts, list_client_authorizations, list_caregiver_credentials, and
-- list_applicants (see 20260729050000_bounded_list_rpcs.sql's comment for
-- the shared rationale) - list_organization_members had no limit at all,
-- despite being the single most-called RPC in the app (action-center.tsx,
-- operational-snapshot.tsx, applicant-detail-page.tsx, access-page.tsx,
-- caregiver-detail-page.tsx, credentials-page.tsx, incidents-page.tsx,
-- owner-dashboard-page.tsx, schedule-page.tsx, team-page.tsx all call it,
-- none passing any limit).
--
-- Unlike those other RPCs, this one is a roster, not an activity log -
-- membership rows are never soft-deleted, so invited-and-lapsed, revoked,
-- and suspended memberships accumulate right alongside active staff
-- forever. A plain "most recently created, capped at 200" cutoff (the
-- pattern used everywhere else) would risk a real regression here that it
-- doesn't for the others: an agency with a couple hundred years-old
-- revoked/lapsed rows could have its *currently active* team silently
-- pushed past the cap and vanish from their own roster page. So the
-- ordering here puts active (and pending/invited - still meaningfully
-- "current") memberships ahead of revoked/suspended ones before applying
-- recency, then caps - active staff are never the rows that get truncated.
--
-- Today's production data doesn't come close to needing this (largest org
-- has 2 total membership rows), so this is purely future-proofing against
-- the same class of gap the last three builds closed, not a fix for an
-- active problem.
drop function if exists public.list_organization_members(uuid);

create function public.list_organization_members(
  target_organization_id uuid,
  result_limit integer default 200
)
returns table (
  membership_id uuid,
  user_id uuid,
  display_name text,
  email text,
  role system_role,
  status membership_status,
  invited_by uuid,
  joined_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id as membership_id,
    m.user_id,
    coalesce(p.display_name, 'Unknown member'),
    u.email,
    m.role,
    m.status,
    m.invited_by,
    m.joined_at,
    m.created_at
  from public.organization_memberships m
  join public.user_profiles p on p.id = m.user_id
  join auth.users u on u.id = m.user_id
  where m.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'membership.read')
  order by
    case when m.status in ('active', 'invited') then 0 else 1 end,
    m.created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_organization_members(uuid, integer) from public;
grant execute on function public.list_organization_members(uuid, integer) to authenticated;
revoke execute on function public.list_organization_members(uuid, integer) from anon;

commit;
