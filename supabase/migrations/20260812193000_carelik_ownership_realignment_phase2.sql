begin;

-- Ownership realignment, phase 2 - the cleanup
-- 20260809141427_carelik_ownership_realignment_phase1.sql deferred:
-- "socalcaresservices@gmail.com keeps both its platform_owner flag and
-- its existing memberships for now, per explicit instruction to defer
-- any removal until both new logins are confirmed working."
--
-- admin.carelik@gmail.com's platform_owner login has since been
-- confirmed working, and admin.ogevia@gmail.com now has its own
-- platform_owner grant (20260812190000_grant_admin_ogevia_platform_owner.sql).
-- Explicit confirmation received to revoke socalcaresservices@gmail.com's
-- platform_owner flag now. Its organization_owner memberships are
-- untouched - this only removes platform administration access, not
-- organization access.
update public.user_profiles
set platform_role = null
where id = '55a38d4c-375a-475a-9e90-a8b9f0c9acc3';

commit;
