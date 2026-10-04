-- ROLLBACK 0023_caregiver_service_admin | CLASS: SAFE AUTOMATED
-- Removes the Care Team and service administration functions, their two
-- permissions and the per-agency unique service-code index. Caregiver records,
-- services, assignments and memberships changed through these screens are rows
-- in tables that predate 0023, so they stay exactly as they are.
drop function if exists ogevia_api.set_service_active(uuid, uuid, boolean, text, uuid);
drop function if exists ogevia_api.rename_service(uuid, uuid, text, uuid);
drop function if exists ogevia_api.create_service(uuid, text, text, uuid);
drop function if exists ogevia_api.set_caregiver_status(uuid, uuid, text, text, uuid);
drop function if exists ogevia_api.update_caregiver(uuid, uuid, text, text, text, uuid);
drop function if exists ogevia_api.create_caregiver(uuid, text, text, text, text, uuid);
drop function if exists ogevia_api.list_caregivers(uuid);
drop function if exists ogevia.service_admin_guard(uuid);
drop function if exists ogevia.check_caregiver_names(text, text, text);
drop function if exists ogevia.caregiver_admin_guard(uuid);
drop index if exists ogevia.services_org_code_unique;
delete from ogevia.role_permissions where permission_key in ('caregivers.manage', 'services.manage');
delete from ogevia.permissions where key in ('caregivers.manage', 'services.manage');
