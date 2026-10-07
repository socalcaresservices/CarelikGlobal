-- ROLLBACK 0005_service_visits  |  CLASS: IRREVERSIBLE WITHOUT DATA LOSS
-- Drops visits, confirmations, evidence metadata, corrections, audit events
-- and idempotency records. NEVER run against a database holding real visits:
-- take an RDS snapshot first and prefer a FORWARD FIX. The guard below refuses
-- to run while any visit or audit row exists.
do $$ begin
  if exists (select 1 from ogevia.service_visits) or exists (select 1 from ogevia.audit_events) then
    raise exception 'Refusing: visit/audit data exists. Snapshot + owner approval + forward fix required.';
  end if;
end $$;
drop function if exists ogevia.authorization_month_usage(uuid, date, uuid);
drop table if exists ogevia.idempotency_records;
drop function if exists ogevia.write_audit(uuid, text, text, uuid, jsonb, jsonb, text);
drop table if exists ogevia.audit_events;
drop table if exists ogevia.visit_corrections;
drop table if exists ogevia.visit_confirmations;
drop table if exists ogevia.visit_evidence;
drop table if exists ogevia.service_visits;
drop function if exists ogevia.forbid_update();
drop function if exists ogevia.service_visits_guard_update();
drop type if exists ogevia.visit_signer_role;
drop type if exists ogevia.visit_authorization_status;
drop type if exists ogevia.service_visit_status;
delete from ogevia_meta.schema_migrations where version = '0005';
