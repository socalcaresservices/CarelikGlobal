drop trigger if exists service_visits_human_visit_number on ogevia.service_visits;
drop function if exists ogevia.set_human_visit_number();
drop function if exists ogevia_api.list_monthly_service_summary(uuid, uuid, date);
drop function if exists ogevia_api.list_correction_history_report(uuid, date, date, uuid, uuid);
