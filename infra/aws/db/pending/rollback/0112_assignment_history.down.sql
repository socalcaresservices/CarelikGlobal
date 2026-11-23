-- Rollback of 0112 (PENDING). Drops the one read function. Nothing is lost: the audit events stay in the audit trail.
drop function if exists ogevia_api.list_assignment_history(uuid, text, uuid, integer);
