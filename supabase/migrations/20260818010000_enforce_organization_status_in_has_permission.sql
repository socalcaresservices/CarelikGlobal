begin;

-- has_permission() is the actual gate behind virtually every tenant
-- operational table's RLS policy and every list_*()/set_*() RPC's
-- internal permission check (see the comment in
-- 20260809021702_gate_has_permission_bypass_on_active_support_access.sql
-- for the fuller list). It has never checked organizations.status.
-- Concretely: 20260809141427_carelik_ownership_realignment_phase1.sql
-- marked an org 'suspended' and its own comment already flagged that
-- "no RLS policy or permission function in this schema currently checks
-- organizations.status" - a pure lifecycle label with zero enforcement
-- behind it. A suspended tenant's own members have kept full read/write
-- access to their org's operational data ever since organizations.status
-- was introduced.
--
-- This closes that for the regular-membership path: a member's
-- organization must be 'active' for has_permission() to grant anything.
-- The platform-owner-with-active-support-access branch is deliberately
-- left untouched - that path is how platform staff are meant to reach
-- into a tenant regardless of its lifecycle state (investigating why it
-- was suspended, handling an offboarding, etc.), and it's already
-- separately time-boxed, reasoned, and audited by the
-- support_access_grants system. Suspending an org should not need to
-- also lock out the mechanism used to administer suspended orgs.
--
-- Known residual gap, not addressed here: a handful of RLS policies
-- (caregiver_records, caregiver_record_availability,
-- caregiver_record_credentials, caregiver_availability) grant read
-- access via "has_permission(...) or <self-referential column> =
-- auth.uid()" - the self-referential branch lets a caregiver read their
-- own row without going through has_permission() at all, so it isn't
-- covered by this fix. That's a narrower, lower-severity gap (a
-- suspended org's caregiver can still see their own single record, not
-- write anything or see anyone else's data) and is left as a follow-up
-- rather than folded in here.
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
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = target_organization_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = requested_permission
      and o.status = 'active'
  );
$$;

commit;
