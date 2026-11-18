-- Rollback of 0109 (PENDING). Drops the three functions and the four added columns.
-- Cancelled requests stay closed (closed_at is kept); only who/why is lost, and the audit events keep it. Retired types stay inactive.
-- Take a backup first if 0109 was used: the cancel reasons and retired-by columns are dropped with their values.
drop function if exists ogevia_api.mark_staff_care_notifications_read(uuid, uuid[]);
drop function if exists ogevia_api.retire_document_type(uuid, uuid, text);
drop function if exists ogevia_api.cancel_staff_document_request(uuid, uuid, text, uuid);
alter table ogevia.document_types drop column if exists retired_at;
alter table ogevia.document_types drop column if exists retired_by;
alter table ogevia.staff_documents drop column if exists cancel_reason;
alter table ogevia.staff_documents drop column if exists cancelled_by;
