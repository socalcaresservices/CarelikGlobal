-- ROLLBACK 0020_workspace_identity_attention_utilisation | CLASS: SAFE AUTOMATED
-- Functions and one nullable column only. Dropping accent_color discards the
-- agency colour (cosmetic; the audit rows keep the history). Display names
-- set through set_my_display_name stay on app_users (that column predates 0020).
drop function if exists ogevia_api.get_utilisation_overview(uuid, date);
drop function if exists ogevia_api.get_attention_summary(uuid, integer, integer);
drop function if exists ogevia_api.set_organization_branding(uuid, text, text, uuid);
drop function if exists ogevia_api.get_organization_branding(uuid);
drop function if exists ogevia.contrast_with_white(text);
alter table ogevia.organizations drop column if exists accent_color;
delete from ogevia.role_permissions where permission_key = 'organization.update';
delete from ogevia.permissions where key = 'organization.update';
drop function if exists ogevia_api.set_my_display_name(text);
drop function if exists ogevia_api.get_my_profile();
