-- 0124 rollback (PENDING). BACKUP REQUIRED if 0124 was ever used: this drops every table below WITH its rows (labels, punches, exceptions, signature follow-ups and events, correction requests, locations, settings).
-- Visits, confirmations, corrections, authorizations and the audit trail are NOT touched; audit events written by 0124 functions stay.
-- Run only in an approved release step after a snapshot. Not applied to any database.
-- Tables first (CASCADE removes only objects that depend on these tables: their triggers and the settings row-type function), then every remaining 0124 function.
drop table if exists ogevia.punch_correction_requests cascade;
drop table if exists ogevia.visit_signature_sessions cascade;
drop table if exists ogevia.visit_signature_events cascade;
drop table if exists ogevia.visit_signature_followups cascade;
drop table if exists ogevia.visit_exception_events cascade;
drop table if exists ogevia.visit_exceptions cascade;
drop table if exists ogevia.visit_punches cascade;
drop table if exists ogevia.home_label_events cascade;
drop table if exists ogevia.home_labels cascade;
drop table if exists ogevia.shift_location_overrides cascade;
drop table if exists ogevia.service_location_rules cascade;
drop table if exists ogevia.client_service_locations cascade;
drop table if exists ogevia.visit_verification_settings cascade;
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'ogevia_api' and p.proname = any (array['save_service_location','list_service_locations','set_service_location_rule','set_shift_location_override','get_expected_locations','save_verification_settings','get_verification_settings','register_home_labels','assign_home_label','deactivate_home_label','replace_home_label','get_home_label_link','list_home_labels','list_home_label_history','preview_home_label','record_punch','open_signature_session','check_signature_session','consume_signature_session','defer_visit_signature','set_signature_followup_owner','log_signature_delivery','flag_overdue_visits','list_visit_exceptions','resolve_visit_exception','list_visit_exception_history','request_punch_correction','decide_punch_correction','list_unsigned_checkouts','list_time_signature_register','list_corrections_audit','list_punch_billing_review','resolve_home_label_code','authorize_verification_export'])) or (n.nspname = 'ogevia' and p.proname = any (array['vv_settings','vv_forbid_change','vv_distance_m','vv_location_result','vv_expected_kinds','vv_client_office','vv_open_exception','vv_sig_event','vv_revision_hash','vv_start_for_shift','vv_followup_resolved_by_signature','vv_sync_followups'])) loop
    execute 'drop function ' || r.sig;
  end loop; end $$;
