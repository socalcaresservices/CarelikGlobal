-- ROLLBACK 0002_identity_tenancy  |  CLASS: BACKUP REQUIRED
do $$ begin
  if exists (select 1 from ogevia.organizations) or exists (select 1 from ogevia.app_users) then
    raise exception 'Refusing: identity/tenant data exists. Snapshot + owner approval required.';
  end if;
end $$;
drop function if exists ogevia.organization_local_date(uuid, timestamptz);
drop function if exists ogevia.is_active_caregiver(uuid);
drop function if exists ogevia.has_permission(uuid, text);
drop function if exists ogevia.is_active_member(uuid);
drop function if exists ogevia.organization_is_active(uuid);
drop function if exists ogevia.require_actor();
drop function if exists ogevia_api.begin_request(text, uuid);
drop function if exists ogevia.current_request_id();
drop function if exists ogevia.current_user_id();
drop table if exists ogevia.role_permissions;
drop table if exists ogevia.permissions;
drop table if exists ogevia.organization_memberships;
drop table if exists ogevia.organizations;
drop table if exists ogevia.app_users;
drop type if exists ogevia.system_role;
drop type if exists ogevia.membership_status;
drop type if exists ogevia.organization_status;
delete from ogevia_meta.schema_migrations where version = '0002';
