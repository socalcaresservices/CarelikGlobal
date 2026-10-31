-- ROLLBACK 0086 | CLASS: BACKUP REQUIRED (drops staff_types and staff_profiles WITH their rows). Take a snapshot first.
-- Removes staff management: the API functions, the default-staff-type trigger, both tables and the staff.read / staff.manage permissions.
-- Sign-ins, memberships and system roles are NOT touched: a person invited as staff keeps the access and role they were given (use the accounts
-- screen to disable them if they should not have it). Audit history (staff.* and staff_type.* events) is kept. note_my_sign_in is restored to 0025.
create or replace function ogevia_api.note_my_sign_in()
returns void
language sql
security definer
set search_path = ogevia, pg_temp
as $$
  update ogevia.caregiver_invitations set first_signed_in_at = now()
  where user_id = ogevia.require_actor() and first_signed_in_at is null;
$$;
drop function if exists ogevia_api.list_staff_audit(uuid, uuid);
drop function if exists ogevia_api.list_role_permissions(uuid);
drop function if exists ogevia_api.set_staff_role(uuid, uuid, text, text);
drop function if exists ogevia_api.record_staff_invitation_resent(uuid, uuid);
drop function if exists ogevia_api.begin_staff_invitation_resend(uuid, uuid);
drop function if exists ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text);
drop function if exists ogevia_api.begin_staff_invitation(uuid, uuid, text, text);
drop function if exists ogevia_api.update_staff(uuid, uuid, text, uuid, text, text, text);
drop function if exists ogevia_api.add_member_to_staff(uuid, uuid, uuid);
drop function if exists ogevia_api.create_staff(uuid, text, uuid, text, text);
drop function if exists ogevia_api.list_staff(uuid);
drop function if exists ogevia_api.set_staff_type_active(uuid, uuid, boolean);
drop function if exists ogevia_api.rename_staff_type(uuid, uuid, text);
drop function if exists ogevia_api.create_staff_type(uuid, text);
drop function if exists ogevia_api.list_staff_types(uuid);
drop function if exists ogevia.staff_validate_contact(text, text);
drop function if exists ogevia.staff_role_change_allowed(uuid, uuid, text, text);
drop function if exists ogevia.assignable_staff_role(text);
drop function if exists ogevia.staff_guard(uuid, boolean);
drop trigger if exists organizations_seed_staff_types on ogevia.organizations;
drop function if exists ogevia.organizations_seed_staff_types();
drop function if exists ogevia.seed_default_staff_types(uuid);
drop table if exists ogevia.staff_profiles;
drop table if exists ogevia.staff_types;
delete from ogevia.role_permissions where permission_key in ('staff.read', 'staff.manage');
delete from ogevia.permissions where key in ('staff.read', 'staff.manage');
