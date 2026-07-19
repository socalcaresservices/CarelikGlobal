begin;

-- Lets an invited user activate their own membership once they have
-- authenticated (GitHub OAuth linked by matching email, or the invite
-- email link). Mirrors the security-definer pattern used by
-- is_platform_owner / is_organization_member / has_permission.
create or replace function public.accept_organization_invitation(
  target_organization_id uuid
)
returns public.organization_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row public.organization_memberships;
begin
  update public.organization_memberships
  set status = 'active',
      joined_at = coalesce(joined_at, now())
  where organization_id = target_organization_id
    and user_id = auth.uid()
    and status = 'invited'
  returning * into updated_row;

  return updated_row;
end;
$$;

revoke all on function public.accept_organization_invitation(uuid) from public;
grant execute on function public.accept_organization_invitation(uuid) to authenticated;

commit;
