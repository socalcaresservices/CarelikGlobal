-- 0072 Export REQUEST is separate from successful GENERATION; the three older exports become server-generated (owner request 2026-10-17, item 3).
--
-- 0069 recorded an export in one step, claimed by the browser. Now an export is a short life in the ledger, all of it written by the server:
--   requested   the server checked reports.export (and visits.read) and accepted the request. Nothing has been produced yet.
--   generated   the server built the file from the report functions and handed it back to the requester; the event records the row count, the byte count and the SHA-256 of the
--               file. This is NOT proof that anything was downloaded, opened, saved or received: the browser can fail after this point and the server cannot know.
--   failed      the server could not build the file; the event records an error code and nothing was returned.
-- A request that never reaches generated or failed (the server stopped) stays "requested" in the history, visibly. A REFUSED request (no permission) writes nothing to the
-- ledger: the refusal is an error response and appears in the API logs only.
-- The browser-assembled path (record_report_export) is removed: no function accepts a row count or a delivery claim from a browser any more. The ledger rows written by 0069
-- (delivery browser_assembled, or the first server_generated chain exports) are kept and are shown as "recorded before request/generation were separated".
-- Rollback (BACKUP REQUIRED: the event history is dropped) restores the 0069 functions.

alter table ogevia.report_exports alter column row_count drop not null;

create table ogevia.report_export_events (
  id bigserial primary key,
  export_id uuid not null,
  organization_id uuid not null references ogevia.organizations(id),
  event text not null check (event in ('requested', 'generated', 'failed')),
  row_count integer check (row_count is null or (row_count >= 0 and row_count <= 1000000)),
  byte_count integer check (byte_count is null or byte_count >= 0),
  sha256_hex text check (sha256_hex is null or sha256_hex ~ '^[0-9a-f]{64}$'),
  error_code text check (error_code is null or length(error_code) <= 80),
  actor_user_id uuid not null references ogevia.app_users(id),
  occurred_at timestamptz not null default now(),
  check ((event = 'generated') = (sha256_hex is not null and row_count is not null and byte_count is not null))
);
create unique index report_export_events_requested on ogevia.report_export_events (export_id) where event = 'requested';
create unique index report_export_events_terminal on ogevia.report_export_events (export_id) where event in ('generated', 'failed');
create index report_export_events_org on ogevia.report_export_events (organization_id, occurred_at desc);
create trigger report_export_events_no_update before update on ogevia.report_export_events for each row execute function ogevia.forbid_update();
create trigger report_export_events_no_delete before delete on ogevia.report_export_events for each row execute function ogevia.forbid_delete();
alter table ogevia.report_export_events enable row level security;
create policy readonly_select on ogevia.report_export_events for select to ogevia_readonly using (true);
grant select on ogevia.report_export_events to ogevia_readonly;

drop function ogevia_api.record_report_export(uuid, text, jsonb, integer, text);
drop function ogevia_api.list_report_exports(uuid, integer);

create function ogevia_api.request_report_export(p_organization_id uuid, p_report_key text, p_params jsonb)
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

create function ogevia_api.complete_report_export(p_organization_id uuid, p_export_id uuid, p_row_count integer, p_byte_count integer, p_sha256_hex text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_e ogevia.report_exports%rowtype;
  v_at timestamptz;
begin
  select * into v_e from ogevia.report_exports e where e.id = p_export_id and e.organization_id = p_organization_id and e.exported_by = v_actor for update;
  if v_e.id is null or not ogevia.is_active_member(p_organization_id) then raise exception 'Export not found' using errcode = 'OGN04'; end if;
  if exists (select 1 from ogevia.report_export_events x where x.export_id = p_export_id and x.event in ('generated', 'failed')) then
    raise exception 'This export was already closed' using errcode = 'OGC09';
  end if;
  insert into ogevia.report_export_events (export_id, organization_id, event, row_count, byte_count, sha256_hex, actor_user_id)
  values (p_export_id, p_organization_id, 'generated', p_row_count, p_byte_count, p_sha256_hex, v_actor) returning occurred_at into v_at;
  perform ogevia.write_audit(p_organization_id, 'report.export_generated', 'report_exports', p_export_id, null,
    jsonb_build_object('report', v_e.report_key, 'row_count', p_row_count, 'byte_count', p_byte_count, 'sha256', p_sha256_hex,
                       'note', 'The server generated and returned the file. Delivery to the device is not recorded.'), null);
  return jsonb_build_object('exportId', p_export_id, 'generatedAt', v_at);
end;
$$;

create function ogevia_api.fail_report_export(p_organization_id uuid, p_export_id uuid, p_error_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_e ogevia.report_exports%rowtype;
begin
  select * into v_e from ogevia.report_exports e where e.id = p_export_id and e.organization_id = p_organization_id and e.exported_by = v_actor for update;
  if v_e.id is null or not ogevia.is_active_member(p_organization_id) then raise exception 'Export not found' using errcode = 'OGN04'; end if;
  if exists (select 1 from ogevia.report_export_events x where x.export_id = p_export_id and x.event in ('generated', 'failed')) then
    raise exception 'This export was already closed' using errcode = 'OGC09';
  end if;
  insert into ogevia.report_export_events (export_id, organization_id, event, error_code, actor_user_id)
  values (p_export_id, p_organization_id, 'failed', left(coalesce(nullif(btrim(p_error_code), ''), 'error'), 80), v_actor);
  perform ogevia.write_audit(p_organization_id, 'report.export_failed', 'report_exports', p_export_id, null,
    jsonb_build_object('report', v_e.report_key, 'error_code', left(coalesce(nullif(btrim(p_error_code), ''), 'error'), 80)), null);
  return jsonb_build_object('exportId', p_export_id, 'failed', true);
end;
$$;

create function ogevia_api.list_report_exports(p_organization_id uuid, p_limit integer default 100)
returns table (
  export_id uuid, requested_at timestamptz, report_key text, params jsonb, requested_by_name text,
  status text, generated_at timestamptz, row_count integer, byte_count integer, sha256_hex text, error_code text, delivery text
)
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
  select e.id, e.exported_at, e.report_key, e.params, u.display_name,
         -- 'recorded' = written by 0069, before request and generation were separated
         case when t.event is not null then t.event when exists (select 1 from ogevia.report_export_events x where x.export_id = e.id) then 'requested' else 'recorded' end,
         t.occurred_at, coalesce(t.row_count, e.row_count), t.byte_count, t.sha256_hex, t.error_code, e.delivery
  from ogevia.report_exports e
  left join ogevia.app_users u on u.id = e.exported_by
  left join ogevia.report_export_events t on t.export_id = e.id and t.event in ('generated', 'failed')
  where e.organization_id = p_organization_id
  order by e.exported_at desc, e.id
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function ogevia_api.request_report_export(uuid, text, jsonb) from public;
revoke all on function ogevia_api.complete_report_export(uuid, uuid, integer, integer, text) from public;
revoke all on function ogevia_api.fail_report_export(uuid, uuid, text) from public;
revoke all on function ogevia_api.list_report_exports(uuid, integer) from public;
grant execute on function ogevia_api.request_report_export(uuid, text, jsonb) to ogevia_app;
grant execute on function ogevia_api.complete_report_export(uuid, uuid, integer, integer, text) to ogevia_app;
grant execute on function ogevia_api.fail_report_export(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.list_report_exports(uuid, integer) to ogevia_app;
