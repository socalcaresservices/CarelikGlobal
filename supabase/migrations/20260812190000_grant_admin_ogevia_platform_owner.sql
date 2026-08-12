begin;

-- admin.ogevia@gmail.com (auth user created 2026-08-12, already an
-- organization_owner of Ogevia per this session's earlier bootstrap) is
-- granted platform_role = 'platform_owner', same shape as
-- 20260809141427_carelik_ownership_realignment_phase1.sql's grant to
-- admin.carelik@gmail.com. Without this, PlatformShell (admin.ogevia.com)
-- displayed "Platform Super Admin" for this account purely because it was
-- an authenticated user on that host - is_platform_owner() and every
-- platform-only RLS policy/RPC that depends on it (Organizations,
-- Subscriptions, Feature Flags) correctly said no, since platform_role
-- was null. This migration makes the account's real access match the
-- fixed frontend's guard rather than papering over the mismatch in the UI.
update public.user_profiles
set platform_role = 'platform_owner'
where id = 'd45999b9-b2a5-46cd-a168-9847ad65c9a2';

commit;
