-- ROLLBACK 0024_assignment_admin | CLASS: SAFE AUTOMATED
-- Removes the assignment administration functions and their permission.
-- Assignments added or ended through these screens are rows in a table that
-- predates 0024, so they stay exactly as they are.
drop function if exists ogevia_api.end_assignment(uuid, uuid, date, text, uuid);
drop function if exists ogevia_api.create_assignment(uuid, uuid, uuid, uuid, date, date, uuid);
drop function if exists ogevia_api.list_assignments(uuid, uuid, uuid);
drop function if exists ogevia.assignment_admin_guard(uuid);
drop function if exists ogevia.authorization_covers(uuid, uuid, uuid, date, date);
delete from ogevia.role_permissions where permission_key = 'assignments.manage';
delete from ogevia.permissions where key = 'assignments.manage';
