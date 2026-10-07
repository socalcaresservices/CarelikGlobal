-- ROLLBACK 0007_reporting_billing_review  |  CLASS: SAFE AUTOMATED
-- Read-only functions only. No data is touched.
drop function if exists ogevia_api.list_billing_review_visits(uuid, date, date);
drop function if exists ogevia_api.list_visit_corrections(uuid);
drop function if exists ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status);
delete from ogevia_meta.schema_migrations where version = '0007';
