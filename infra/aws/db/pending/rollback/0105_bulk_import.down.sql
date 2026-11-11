-- ROLLBACK 0092 | CLASS: BACKUP REQUIRED (drops import_batches with its rows). Records already created by an import are ordinary caregivers, staff and clients and are NOT removed;
-- the audit events stay. Run only after a verified backup.
drop function if exists ogevia_api.import_rows(uuid, text, jsonb, text, text, boolean);
drop table if exists ogevia.import_batches;
