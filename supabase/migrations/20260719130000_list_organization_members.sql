begin;

-- Returns organization membership rows together with the member's display
-- name. This has to be security-definer: "users_read_own_profile" only
-- lets someone read their own user_profiles row (or a platform owner read
-- any), so an organization_admin cannot join user_profiles for other
-- members directly from the browser. Access is instead gated inline by
-- has_permission, the same authorization check RLS uses everywhere else.
create or replace function public.list_organization_members(
  target_organization_id uuid
)
returns table (
  membership_id uuid,
  user_id uuid,
  display_name text,
  role public.system_role,
  status public.membership_status,
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
    m.role,
    m.status,
    m.invited_by,
    m.joined_at,
    m.created_at
  from public.organization_memberships m
  join public.user_profiles p on p.id = m.user_id
  where m.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'membership.read')
  order by m.created_at;
$$;

revoke all on function public.list_organization_members(uuid) from public;
grant execute on function public.list_organization_members(uuid) to authenticated;

commit;
