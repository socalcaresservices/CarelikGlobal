-- ROLLBACK 0020_workspace_identity_attention_utilisation | CLASS: BACKUP REQUIRED
-- Refuses while any restricted client name exists (export first). Otherwise
-- drops functions and the branding columns: the agency colour and the logo
-- reference are discarded (the logo object stays in S3; audit rows keep the
-- history). Display names set through set_my_display_name stay on app_users.
do $$ begin
  if to_regclass('ogevia.client_private_names') is not null and exists (select 1 from ogevia.client_private_names) then
    raise exception 'Refusing: client names exist. Snapshot + owner approval + forward fix required.';
  end if;
end $$;
drop function if exists ogevia_api.set_client_legal_name(uuid, uuid, text, text, uuid);
drop function if exists ogevia_api.list_client_directory(uuid);
drop table if exists ogevia.client_private_names;
delete from ogevia.role_permissions where permission_key in ('clients.names.read', 'clients.names.manage');
delete from ogevia.permissions where key in ('clients.names.read', 'clients.names.manage');
drop function if exists ogevia_api.get_organization_logo(uuid);
drop function if exists ogevia_api.clear_organization_logo(uuid);
drop function if exists ogevia_api.set_organization_logo(uuid, uuid, text, text, text, integer, text, uuid);
drop function if exists ogevia_api.get_utilisation_overview(uuid, date);
drop function if exists ogevia_api.get_attention_summary(uuid, integer, integer);
drop function if exists ogevia_api.set_organization_branding(uuid, text, text, uuid);
drop function if exists ogevia_api.get_organization_branding(uuid);
drop function if exists ogevia.contrast_with_white(text);
alter table ogevia.organizations drop column if exists accent_color, drop column if exists logo_object_key,
  drop column if exists logo_s3_version_id, drop column if exists logo_content_type, drop column if exists logo_sha256,
  drop column if exists logo_updated_at;
delete from ogevia.role_permissions where permission_key = 'organization.update';
delete from ogevia.permissions where key = 'organization.update';
drop function if exists ogevia_api.set_my_display_name(text);
drop function if exists ogevia_api.get_my_profile();
