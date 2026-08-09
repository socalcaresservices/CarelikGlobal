begin;

-- has_permission() is the actual gate behind virtually every tenant
-- operational table's RLS policy (clients, caregivers, shifts,
-- credentials, authorizations, incidents, applicants, documents,
-- organization_memberships writes, organization_settings, files,
-- audit_logs) and every list_*()/set_*() RPC's internal permission
-- check. Its previous "is_platform_owner() or exists(membership...)"
-- shape meant ANY platform owner could read or write ANY tenant's
-- operational data at ANY time, with no per-org scoping and no time
-- limit - the support_access_grants system built in
-- 20260807000000_support_access.sql had no actual teeth here, since
-- this blanket bypass made it irrelevant to whether that grant existed.
--
-- This also silently broke approve_support_access()'s own stated intent
-- ("a platform owner cannot self-approve their own access into a
-- tenant") - since has_permission(any_org, 'settings.update') already
-- returned true for a platform owner via this bypass, a platform owner
-- could approve/deny their own requests today. Requiring
-- has_active_support_access() closes that at the same time.
--
-- Deliberately NOT touching is_organization_member() here - it isn't
-- the gate for any operational table (feature_flags and user_profiles
-- have their own independent is_platform_owner() policies; operational
-- tables all use has_permission()), and tightening it would only
-- collaterally shrink the platform owner's organizations list in
-- OrganizationProvider (used by the org picker on the platform Feature
-- Flags page), which is a platform-administration concern, not tenant
-- operational data access.
create or replace function public.has_permission(
  target_organization_id uuid,
  requested_permission text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    public.is_platform_owner() and public.has_active_support_access(target_organization_id)
  ) or exists (
    select 1
    from public.organization_memberships m
    join public.role_permissions rp on rp.role = m.role
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = requested_permission
  );
$$;

commit;
