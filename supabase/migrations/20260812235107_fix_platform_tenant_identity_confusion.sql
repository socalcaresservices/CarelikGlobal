update public.organizations
set
  display_name = 'Ogevia Demo Agency',
  legal_name = 'Ogevia Demo Agency',
  slug = 'ogevia-demo'
where id = '119c0cdb-fb7c-49aa-9dd3-35c04db71b1b';

insert into public.organization_memberships (organization_id, user_id, role, status, joined_at)
select '8475971f-1b91-4ebc-ae07-0cb230278f6e', up.id, 'organization_owner', 'active', now()
from public.user_profiles up
where up.platform_role = 'platform_owner'
on conflict (organization_id, user_id) do update set role = excluded.role, status = excluded.status, joined_at = excluded.joined_at;
