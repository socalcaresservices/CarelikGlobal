-- ROLLBACK 0072 | CLASS: BACKUP REQUIRED (the export event history -- requested / generated / failed -- is dropped; ledger rows and audit events are kept). Restores the 0069 functions.
drop function ogevia_api.list_report_exports(uuid, integer);
drop function ogevia_api.fail_report_export(uuid, uuid, text);
drop function ogevia_api.complete_report_export(uuid, uuid, integer, integer, text);
drop function ogevia_api.request_report_export(uuid, text, jsonb);
drop table ogevia.report_export_events;
alter table ogevia.report_exports disable trigger report_exports_no_update;
update ogevia.report_exports set row_count = 0 where row_count is null;
alter table ogevia.report_exports enable trigger report_exports_no_update;
alter table ogevia.report_exports alter column row_count set not null;
create function ogevia_api.record_report_export(p_organization_id uuid, p_report_key text, p_params jsonb, p_row_count integer, p_delivery text default 'browser_assembled')
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
  if not ogevia.has_permission(p_organization_id, 'reports.export') then raise exception 'You do not have permission to export reports' using errcode = 'OGA03'; end if;
  if not ogevia.has_permission(p_organization_id, 'visits.read') then raise exception 'You do not have permission to export reports' using errcode = 'OGA03'; end if;
  if p_report_key is null or p_report_key not in ('client_service_calendar', 'monthly_service_reconciliation', 'correction_history', 'monthly_chain') then
    raise exception 'Unknown report' using errcode = 'OGV22';
  end if;
  if p_row_count is null or p_row_count < 0 or p_row_count > 1000000 then raise exception 'Invalid row count' using errcode = 'OGV22'; end if;
  if p_delivery is null or p_delivery not in ('browser_assembled', 'server_generated') then raise exception 'Invalid delivery' using errcode = 'OGV22'; end if;
  if p_params is not null and pg_column_size(p_params) > 4000 then raise exception 'Export details are too large' using errcode = 'OGV22'; end if;
  insert into ogevia.report_exports (organization_id, report_key, params, row_count, delivery, exported_by)
  values (p_organization_id, p_report_key, coalesce(p_params, '{}'::jsonb), p_row_count, p_delivery, v_actor) returning id, exported_at into v_id, v_at;
  perform ogevia.write_audit(p_organization_id, 'report.exported', 'report_exports', v_id, null,
    jsonb_build_object('report', p_report_key, 'row_count', p_row_count, 'delivery', p_delivery, 'params', coalesce(p_params, '{}'::jsonb)), null);
  return jsonb_build_object('exportId', v_id, 'exportedAt', v_at);
end;
$$;
create function ogevia_api.list_report_exports(p_organization_id uuid, p_limit integer default 100)
returns table (export_id uuid, exported_at timestamptz, report_key text, params jsonb, row_count integer, delivery text, exported_by_name text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'You do not have permission to see the export history' using errcode = 'OGA03'; end if;
  return query
  select e.id, e.exported_at, e.report_key, e.params, e.row_count, e.delivery, u.display_name
  from ogevia.report_exports e left join ogevia.app_users u on u.id = e.exported_by
  where e.organization_id = p_organization_id
  order by e.exported_at desc, e.id
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function ogevia_api.record_report_export(uuid, text, jsonb, integer, text) from public;
revoke all on function ogevia_api.list_report_exports(uuid, integer) from public;
grant execute on function ogevia_api.record_report_export(uuid, text, jsonb, integer, text) to ogevia_app;
grant execute on function ogevia_api.list_report_exports(uuid, integer) to ogevia_app;
