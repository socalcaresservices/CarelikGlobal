-- Align the three existing subscribers with separate tenant identities.
update public.organization_memberships m
set status = 'active', joined_at = coalesce(joined_at, now())
from auth.users u, public.organizations o
where m.user_id = u.id and m.organization_id = o.id
  and lower(u.email) = 'ogethinks@gmail.com'
  and o.display_name = 'Ogethinks'
  and m.role = 'organization_owner';

update public.organization_memberships m
set status = 'revoked'
from auth.users u, public.organizations o
where m.user_id = u.id and m.organization_id = o.id
  and lower(u.email) = 'socalcaresservices@gmail.com'
  and o.display_name = 'Ogethinks';

update public.organization_memberships m
set status = 'revoked'
from auth.users u, public.user_profiles p, public.organizations o
where m.user_id = u.id and p.id = u.id and m.organization_id = o.id
  and p.platform_role = 'platform_owner'
  and o.display_name = 'Socal Care Services llc';
