-- ROLLBACK 0010_reporting_acceptance_improvements | CLASS: SAFE AUTOMATED
-- Removes reporting-only functions/trigger. Does not delete visit or audit data.
drop trigger if exists service_visits_human_visit_number on ogevia.service_visits;
drop function if exists ogevia.set_human_visit_number();
drop function if exists ogevia_api.list_monthly_service_summary(uuid, date, uuid);
drop function if exists ogevia_api.list_correction_history_report(uuid, date, date, uuid, uuid, uuid, uuid, ogevia.service_visit_status);
