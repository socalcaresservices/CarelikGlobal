-- ROLLBACK 0006_service_verification_api  |  CLASS: SAFE AUTOMATED (functions only)
-- Dropping the API stops all writes; it touches no rows. Prefer a FORWARD FIX
-- (create or replace) for behavior bugs: removing the API takes the service down.
drop function if exists ogevia_api.amend_client_authorization(uuid, integer, date, date, text, text, text, date, text, uuid);
drop function if exists ogevia_api.correct_service_visit(uuid, timestamptz, timestamptz, text, uuid);
drop function if exists ogevia_api.void_service_visit(uuid, text);
drop function if exists ogevia_api.confirm_service_visit(uuid, ogevia.visit_signer_role, text, uuid, text, text, text, uuid);
drop function if exists ogevia_api.register_visit_evidence(uuid, text, text, text, integer, text, uuid);
drop function if exists ogevia_api.end_service_visit(uuid, text[], text);
drop function if exists ogevia_api.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text, uuid);
drop function if exists ogevia_api.list_authorized_services_for_client(uuid, uuid);
drop function if exists ogevia_api.list_assigned_visit_clients(uuid);
drop function if exists ogevia_api.get_active_service_visit(uuid);
drop function if exists ogevia.idempotency_finish(text, uuid, uuid, text, jsonb);
drop function if exists ogevia.idempotency_begin(text, uuid, uuid, text);
delete from ogevia_meta.schema_migrations where version = '0006';
