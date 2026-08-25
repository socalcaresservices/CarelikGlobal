begin;

-- Owners retain the complete billing workflow. The manager/owner separation
-- migration intentionally leaves managers with operational visit review but
-- accidentally omitted the same operational permission from owners.
insert into public.role_permissions (role, permission_key)
values ('organization_owner', 'billing.visits.read')
on conflict (role, permission_key) do nothing;

commit;
