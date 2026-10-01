-- ROLLBACK 0009_api_context_evidence_read  |  CLASS: SAFE AUTOMATED
-- Read-only functions only. Audit rows they wrote are retained (append-only).
drop function if exists ogevia_api.get_visit_signature_evidence(uuid);
drop function if exists ogevia_api.get_my_context();
drop function if exists ogevia_api.get_confirmation_replay(uuid, uuid);
delete from ogevia_meta.schema_migrations where version = '0009';
