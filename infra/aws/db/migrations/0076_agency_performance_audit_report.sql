-- 0076 Agency performance (counts, no missed-visits metric), the general audit report (G14), and two more server-generated exports (Board 5 requirements 3, 12, 13, 14).
--
-- AGENCY PERFORMANCE: one month, by shift start date in the agency's time zone. Counts only, each with its plain definition:
--   shifts            every shift that starts in the month, whatever its status
--   covered_now       scheduled shifts that have a caregiver today; uncovered_now: scheduled shifts still to come that need a caregiver
--   call_outs         call-outs recorded on those shifts (a shift can have more than one)
--   cancelled         shifts cancelled (a reason is required to cancel); WHO cancelled is not recorded, so the count is not split by party
--   no_show           shifts marked no-show (Ogevia does not set this itself; a person does)
--   ended_without_record  shifts that ended with no visit record and no decision yet (the same list Home calls "To reconcile")
--   utilization       committed minutes divided by authorized minutes, rounded down to a whole percent, using the approved committed definition (billable + approved rounding
--                     adjustments + reserved). When nothing is authorized the figure is null, never zero or 100.
-- A MISSED-VISITS metric is deliberately not computed: Board 5 rule 6 keeps it unpublished until the owner approves a definition and event tracking.
-- AUDIT REPORT: audit events with the action, the actor, the entity type, the reason and the NAMES of the fields that changed, never their values. Owner only (organization.update).
-- EXPORTS: billing_review (the month's visits with their billing state; approval is not submission or payment) and audit_report join the server-generated, ledgered exports.
-- Rollback: SAFE AUTOMATED (functions only; the 0072 export request function is restored).

-- the ledger's report list (a CHECK from 0069) learns the two new reports
alter table ogevia.report_exports drop constraint report_exports_report_key_check;
alter table ogevia.report_exports add constraint report_exports_report_key_check
  check (report_key in ('client_service_calendar', 'monthly_service_reconciliation', 'correction_history', 'monthly_chain', 'billing_review', 'audit_report'));

create function ogevia_api.get_agency_performance(p_organization_id uuid, p_month_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_tz text;
  v_from date := date_trunc('month', p_month_start)::date;
  v_to date := (date_trunc('month', p_month_start) + interval '1 month - 1 day')::date;
  v_shifts jsonb;
  v_util jsonb;
  v_auth bigint := 0; v_comm bigint := 0;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'visits.read') and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage'))) then
    raise exception 'You do not have permission to see agency performance' using errcode = 'OGA03';
  end if;
  if p_month_start is null then raise exception 'Choose a month' using errcode = 'OGV22'; end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select jsonb_build_object(
           'shifts', count(*),
           'coveredNow', count(*) filter (where s.status::text = 'scheduled' and s.ends_at > now() and ogevia.shift_coverage_state(s) = 'covered'),
           'uncoveredNow', count(*) filter (where s.status::text = 'scheduled' and s.ends_at > now() and ogevia.shift_coverage_state(s) = 'needs_coverage'),
           'callOuts', coalesce(sum((select count(*) from ogevia.shift_coverage_events e where e.shift_id = s.id and e.event_type = 'called_out')), 0),
           'cancelled', count(*) filter (where s.status::text = 'cancelled'),
           'noShow', count(*) filter (where s.status::text = 'no_show'),
           'endedWithoutRecord', count(*) filter (where s.status::text = 'scheduled' and s.ends_at < now() and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
                                                   and exists (select 1 from ogevia.authorization_reservations r where r.shift_id = s.id and r.released_at is null)))
    into v_shifts
  from ogevia.shifts s where s.organization_id = p_organization_id and (s.starts_at at time zone v_tz)::date between v_from and v_to;
  select coalesce(sum(x.authorized_minutes), 0), coalesce(sum(x.committed_minutes), 0) into v_auth, v_comm
  from ogevia_api.list_monthly_service_summary(p_organization_id, v_from, null) x;
  v_util := jsonb_build_object('authorizedMinutes', v_auth, 'committedMinutes', v_comm, 'percent', case when v_auth > 0 then floor(v_comm * 100.0 / v_auth)::int end);
  return jsonb_build_object('monthStart', v_from, 'monthEnd', v_to, 'counts', v_shifts, 'utilization', v_util,
    'missedVisits', null, 'missedVisitsNote', 'Not published. A missed-visits figure needs a definition and event tracking that the owner has not approved yet.',
    'cancellationNote', 'A reason is required to cancel a shift, but who cancelled is not recorded, so cancellations are not split by party.',
    'noShowNote', 'No-show is set by a person; Ogevia never sets it on its own.');
end;
$$;

create function ogevia_api.list_audit_report(p_organization_id uuid, p_date_from date, p_date_to date, p_action_prefix text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_tz text;
  v_total bigint;
  v_events jsonb;
  v_prefix text := nullif(btrim(coalesce(p_action_prefix, '')), '');
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'You do not have permission to see the audit report' using errcode = 'OGA03'; end if;
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from or p_date_to - p_date_from > 400 then raise exception 'Choose a date range of at most 400 days' using errcode = 'OGV22'; end if;
  if v_prefix is not null and v_prefix !~ '^[a-z_.]{1,60}$' then raise exception 'Invalid action filter' using errcode = 'OGV22'; end if;
  p_limit := greatest(1, least(coalesce(p_limit, 100), 500));
  p_offset := greatest(0, coalesce(p_offset, 0));
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select count(*) into v_total from ogevia.audit_events e
   where e.organization_id = p_organization_id and (e.occurred_at at time zone v_tz)::date between p_date_from and p_date_to and (v_prefix is null or e.action like v_prefix || '%');
  select coalesce(jsonb_agg(jsonb_build_object('occurredAt', t.occurred_at, 'action', t.action, 'actorName', t.actor_name, 'entityType', t.entity_type, 'reason', t.reason, 'fields', to_jsonb(t.fields)) order by t.occurred_at desc, t.id desc), '[]'::jsonb)
    into v_events
  from (select e.id, e.occurred_at, e.action, u.display_name as actor_name, e.entity_type, e.reason,
               coalesce((select array_agg(k order by k) from jsonb_object_keys(case when jsonb_typeof(e.after_state) = 'object' then e.after_state else '{}'::jsonb end) k), array[]::text[]) as fields
          from ogevia.audit_events e left join ogevia.app_users u on u.id = e.actor_user_id
         where e.organization_id = p_organization_id and (e.occurred_at at time zone v_tz)::date between p_date_from and p_date_to and (v_prefix is null or e.action like v_prefix || '%')
         order by e.occurred_at desc, e.id desc limit p_limit offset p_offset) t;
  return jsonb_build_object('total', v_total, 'limit', p_limit, 'offset', p_offset, 'events', v_events,
    'note', 'Field names only, never values. Reasons are the notes staff typed.');
end;
$$;
revoke all on function ogevia_api.get_agency_performance(uuid, date) from public;
revoke all on function ogevia_api.list_audit_report(uuid, date, date, text, integer, integer) from public;
grant execute on function ogevia_api.get_agency_performance(uuid, date) to ogevia_app;
grant execute on function ogevia_api.list_audit_report(uuid, date, date, text, integer, integer) to ogevia_app;

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
  if p_report_key is null or p_report_key not in ('client_service_calendar', 'monthly_service_reconciliation', 'correction_history', 'monthly_chain', 'billing_review', 'audit_report') then
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
