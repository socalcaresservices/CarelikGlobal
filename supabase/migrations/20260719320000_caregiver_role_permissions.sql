begin;

-- Gives the new "caregiver" role the same permission set as "staff" -
-- that's what people invited as "staff" from the Team page have
-- actually been used for so far, so this keeps behavior identical for
-- anyone added going forward with the more accurate label.
insert into public.role_permissions (role, permission_key)
select 'caregiver'::public.system_role, key
from public.permissions
where key in ('organization.read', 'files.read', 'files.create', 'incidents.create', 'clients.read')
on conflict do nothing;

commit;
