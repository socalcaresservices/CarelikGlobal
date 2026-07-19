begin;

-- Closes every remaining get_advisors finding from verifying against the
-- live project (see docs/phase-1-foundation.md, Increment 10). None of
-- these were broken behavior - RLS still enforced the right access - but
-- they were real, fixable inefficiencies and one schema-hygiene warning.

-- 1. extension_in_public (WARN): citext lived in public instead of a
-- dedicated schema. No column currently uses citext and search_path
-- already includes extensions, so this is a safe, no-op-for-callers move.
create schema if not exists extensions;
alter extension citext set schema extensions;

-- 2. unindexed_foreign_keys (INFO): add covering indexes for FK columns
-- that had none. Plain CREATE INDEX is fine here - these tables are new
-- and effectively empty, no CONCURRENTLY/lock concerns.
create index if not exists audit_logs_actor_user_id_idx on public.audit_logs (actor_user_id);
create index if not exists feature_flags_created_by_idx on public.feature_flags (created_by);
create index if not exists feature_flags_organization_id_idx on public.feature_flags (organization_id);
create index if not exists feature_flags_updated_by_idx on public.feature_flags (updated_by);
create index if not exists files_uploaded_by_idx on public.files (uploaded_by);
create index if not exists notifications_recipient_user_id_idx on public.notifications (recipient_user_id);
create index if not exists organization_memberships_invited_by_idx on public.organization_memberships (invited_by);
create index if not exists organization_settings_updated_by_idx on public.organization_settings (updated_by);
create index if not exists organizations_created_by_idx on public.organizations (created_by);
create index if not exists organizations_updated_by_idx on public.organizations (updated_by);
create index if not exists role_permissions_permission_key_idx on public.role_permissions (permission_key);

-- 3. auth_rls_initplan (WARN): policies calling auth.uid() directly get
-- re-evaluated per row; wrapping in (select auth.uid()) lets Postgres
-- evaluate it once per statement instead.
alter policy users_read_own_profile on public.user_profiles
  using ((id = (select auth.uid())) or is_platform_owner());

alter policy users_update_own_profile on public.user_profiles
  using ((id = (select auth.uid())) or is_platform_owner())
  with check ((id = (select auth.uid())) or is_platform_owner());

alter policy members_read_notifications on public.notifications
  using ((recipient_user_id = (select auth.uid())) and is_organization_member(organization_id));

alter policy members_create_files on public.files
  with check ((uploaded_by = (select auth.uid())) and has_permission(organization_id, 'files.create'));

-- 4. multiple_permissive_policies (WARN): feature_flags, organization_memberships,
-- and organization_settings each had an ALL policy and a SELECT policy
-- that both applied to authenticated SELECTs, so Postgres had to evaluate
-- both for every read. Split each ALL policy into INSERT/UPDATE/DELETE and
-- fold its condition into the read policy's OR instead, so SELECT only
-- ever runs one policy. This also fixes members_read_memberships' own
-- direct auth.uid() call while it's being rewritten anyway.

drop policy if exists platform_owner_manage_feature_flags on public.feature_flags;

create policy platform_owner_insert_feature_flags on public.feature_flags
  for insert to authenticated
  with check (is_platform_owner());

create policy platform_owner_update_feature_flags on public.feature_flags
  for update to authenticated
  using (is_platform_owner())
  with check (is_platform_owner());

create policy platform_owner_delete_feature_flags on public.feature_flags
  for delete to authenticated
  using (is_platform_owner());

alter policy members_read_feature_flags on public.feature_flags
  using ((organization_id is null) or is_organization_member(organization_id) or is_platform_owner());

drop policy if exists authorized_manage_memberships on public.organization_memberships;

create policy authorized_insert_memberships on public.organization_memberships
  for insert to authenticated
  with check (has_permission(organization_id, 'membership.update'));

create policy authorized_update_memberships on public.organization_memberships
  for update to authenticated
  using (has_permission(organization_id, 'membership.update'))
  with check (has_permission(organization_id, 'membership.update'));

create policy authorized_delete_memberships on public.organization_memberships
  for delete to authenticated
  using (has_permission(organization_id, 'membership.update'));

alter policy members_read_memberships on public.organization_memberships
  using (
    (user_id = (select auth.uid()))
    or has_permission(organization_id, 'membership.read')
    or has_permission(organization_id, 'membership.update')
  );

drop policy if exists authorized_manage_settings on public.organization_settings;

create policy authorized_insert_settings on public.organization_settings
  for insert to authenticated
  with check (has_permission(organization_id, 'settings.update'));

create policy authorized_update_settings on public.organization_settings
  for update to authenticated
  using (has_permission(organization_id, 'settings.update'))
  with check (has_permission(organization_id, 'settings.update'));

create policy authorized_delete_settings on public.organization_settings
  for delete to authenticated
  using (has_permission(organization_id, 'settings.update'));

alter policy authorized_read_settings on public.organization_settings
  using (
    has_permission(organization_id, 'settings.read')
    or has_permission(organization_id, 'settings.update')
  );

commit;
