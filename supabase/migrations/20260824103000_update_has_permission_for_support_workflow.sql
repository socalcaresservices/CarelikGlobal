begin;

-- Update has_permission() to respect access_level grants
-- Maps access_level ('read_only', 'edit') to specific permission keys

create or replace function public.has_permission(
  target_organization_id uuid,
  requested_permission text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  grant_record public.support_access_grants;
  has_membership_permission boolean;
begin
  -- Case 1: Check membership-based permissions first
  select exists (
    select 1
    from public.organization_memberships m
    join public.role_permissions rp on rp.role = m.role
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = requested_permission
  ) into has_membership_permission;

  if has_membership_permission then
    return true;
  end if;

  -- Case 2: Platform owner with active support grant
  if public.is_platform_owner() then
    select * into grant_record from public.support_access_grants
    where organization_id = target_organization_id
      and grantee_user_id = auth.uid()
      and status = 'active'
      and expires_at > now()
    limit 1;

    if grant_record is not null then
      -- Map access_level to permissions
      if grant_record.access_level = 'read_only' then
        return requested_permission in (
          'membership.read',
          'clients.read',
          'caregivers.read',
          'schedules.read',
          'audit.read',
          'settings.read',
          'authorizations.read'
        );
      elsif grant_record.access_level = 'edit' then
        return requested_permission in (
          'membership.read',
          'clients.read',
          'clients.update',
          'caregivers.read',
          'caregivers.update',
          'schedules.read',
          'schedules.update',
          'audit.read',
          'settings.read',
          'authorizations.read',
          'authorizations.update'
        );
      end if;
    end if;
  end if;

  return false;
end;
$$;

commit;
