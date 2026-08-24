begin;

-- List active support grants for current support staff member (across all orgs)
create or replace function public.list_staff_active_grants(
  result_limit integer default 100
) returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  grantee_email text,
  access_level text,
  status text,
  expires_at timestamptz,
  reason text,
  requested_at timestamptz,
  approved_at timestamptz,
  emergency boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sag.id,
    sag.organization_id,
    o.display_name,
    u.email,
    sag.access_level,
    sag.status,
    sag.expires_at,
    sag.reason,
    sag.requested_at,
    sag.approved_at,
    sag.emergency
  from public.support_access_grants sag
  left join public.organizations o on sag.organization_id = o.id
  left join auth.users u on sag.grantee_user_id = u.id
  where public.is_platform_owner()
    and sag.grantee_user_id = auth.uid()
    and sag.status in ('active', 'pending_approval')
  order by sag.created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_staff_active_grants(integer) from public, anon;
grant execute on function public.list_staff_active_grants(integer) to authenticated;

commit;
