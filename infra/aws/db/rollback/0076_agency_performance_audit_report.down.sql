-- ROLLBACK 0076 | CLASS: SAFE AUTOMATED (functions only; restores the 0072 export request function)
-- the ledger is append-only: rows written with the new keys stay, so the old list is restored as NOT VALID (it checks new rows only)
alter table ogevia.report_exports drop constraint report_exports_report_key_check;
alter table ogevia.report_exports add constraint report_exports_report_key_check
  check (report_key in ('client_service_calendar', 'monthly_service_reconciliation', 'correction_history', 'monthly_chain')) not valid;
drop function ogevia_api.list_audit_report(uuid, date, date, text, integer, integer);
drop function ogevia_api.get_agency_performance(uuid, date);
create or replace function ogevia_api.request_report_export(p_organization_id uuid, p_report_key text, p_params jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_id uuid;
  v_at timestamptz;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'reports.export') and ogevia.has_permission(p_organization_id, 'visits.read')) then
    raise exception 'You do not have permission to export reports' using errcode = 'OGA03';
  end if;
  if p_report_key is null or p_report_key not in ('client_service_calendar', 'monthly_service_reconciliation', 'correction_history', 'monthly_chain') then
    raise exception 'Unknown report' using errcode = 'OGV22';
  end if;
  if p_params is not null and pg_column_size(p_params) > 4000 then raise exception 'Export details are too large' using errcode = 'OGV22'; end if;
  insert into ogevia.report_exports (organization_id, report_key, params, row_count, delivery, exported_by)
  values (p_organization_id, p_report_key, coalesce(p_params, '{}'::jsonb), null, 'server_generated', v_actor) returning id, exported_at into v_id, v_at;
  insert into ogevia.report_export_events (export_id, organization_id, event, actor_user_id) values (v_id, p_organization_id, 'requested', v_actor);
  perform ogevia.write_audit(p_organization_id, 'report.export_requested', 'report_exports', v_id, null,
    jsonb_build_object('report', p_report_key, 'params', coalesce(p_params, '{}'::jsonb)), null);
  return jsonb_build_object('exportId', v_id, 'requestedAt', v_at);
end;
$$;
