begin;

-- Ownership realignment, phase 1 (additive only - nothing removed yet).
--
-- admin.carelik@gmail.com (an existing, already-verified auth user -
-- created 2026-07-23, has signed in before, no new Auth identity
-- created here) becomes platform_owner and an organization_owner of
-- CareLik. socalcaresservices@gmail.com keeps both its platform_owner
-- flag and its existing memberships for now, per explicit instruction
-- to defer any removal until both new logins are confirmed working -
-- see the follow-up "phase 2" migration for that step.
--
-- admin@socalcareservices.com is NOT created here - that email has no
-- existing Auth user, and creating one is intentionally left to the
-- account owner via the app's own Invite flow, not done directly here.
update public.user_profiles
set platform_role = 'platform_owner'
where id = 'b1c5321a-cf78-45cf-a4a8-bd3a8365ac21';

insert into public.organization_memberships (organization_id, user_id, role, status, joined_at)
values (
  '119c0cdb-fb7c-49aa-9dd3-35c04db71b1b',
  'b1c5321a-cf78-45cf-a4a8-bd3a8365ac21',
  'organization_owner',
  'active',
  now()
)
on conflict (organization_id, user_id) do update set role = excluded.role, status = excluded.status;

-- Ogethinks: suspended (lifecycle label), not hard-deleted. Note this
-- does not by itself change what any member of Ogethinks can access -
-- no RLS policy or permission function in this schema currently checks
-- organizations.status - flagged separately, not addressed here since
-- it wasn't asked for.
update public.organizations
set status = 'suspended'
where slug = 'ogethinks';

commit;
