begin;

-- Adding a new output column to a set-returning function is a *return
-- type* change, which `create or replace function` refuses to make
-- (unlike ordinary column-list changes on a table). Has to be a real
-- drop + recreate. The signature (target_organization_id uuid) is
-- unchanged, so this is a clean replace, not a new overload - see
-- 20260727090000_drop_legacy_create_organization_overload.sql for what
-- happens when an overload's parameter list *does* change and the old
-- one isn't dropped.
drop function if exists public.list_organization_members(uuid);

-- Email only lives on auth.users - user_profiles deliberately has no
-- email column (see platform_foundation.sql) - and auth.users isn't
-- exposed to authenticated/anon at all. This function can still read it
-- because it's security definer (runs as its owner, not the caller),
-- same reasoning as the existing user_profiles join two lines below.
create function public.list_organization_members(
  target_organization_id uuid
)
returns table (
  membership_id uuid,
  user_id uuid,
  display_name text,
  email text,
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
  order by m.created_at;
$$;

revoke all on function public.list_organization_members(uuid) from public, anon;
grant execute on function public.list_organization_members(uuid) to authenticated;

commit;
