begin;

-- Identity model correction. The organization at id 119c0cdb... is the
-- original CareLik tenant, carried forward through the CareLik -> Ogevia
-- rebrand (20260810000000_carelik_to_ogevia_rename.sql) with its
-- display_name changed to literally "Ogevia" - the same name as the
-- platform itself. It has been sitting in every platform owner's
-- organization switcher indistinguishable from a real customer
-- (SoCal Care Services llc, Ogethinks), which is exactly backwards:
-- Ogevia is the platform that manages organizations, not one of the
-- organizations it manages. Renamed, not deleted - it has one real
-- client and two active memberships from earlier testing, and per
-- "don't delete, mark clearly instead" this becomes an explicitly-
-- labeled internal sandbox rather than removed data.
update public.organizations
set
  display_name = 'Ogevia Demo Agency',
  legal_name = 'Ogevia Demo Agency',
  slug = 'ogevia-demo'
where id = '119c0cdb-fb7c-49aa-9dd3-35c04db71b1b';

-- Both platform owners get real organization_owner membership in the
-- actual production tenant, SoCal Care Services llc - the same pattern
-- already used for the (renamed) demo org, not a new mechanism. This is
-- deliberately a real membership, not a support-access grant: SoCal Care
-- Services is the operator's own primary business running on Ogevia, not
-- an arbitrary customer a platform owner needs time-boxed, audited access
-- into. Support access (20260807000000_support_access.sql) stays the
-- right tool for a genuine third-party customer's tenant.
insert into public.organization_memberships (organization_id, user_id, role, status, joined_at)
select '8475971f-1b91-4ebc-ae07-0cb230278f6e', up.id, 'organization_owner', 'active', now()
from public.user_profiles up
where up.platform_role = 'platform_owner'
on conflict (organization_id, user_id) do update set role = excluded.role, status = excluded.status, joined_at = excluded.joined_at;

commit;
