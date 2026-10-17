-- ROLLBACK 0074 | CLASS: BACKUP REQUIRED (client documents, versions, requirements, holds and preparation stages are dropped; evidence files stay in the bucket; audit events are kept). Restores the 0073 issue rows.
create or replace function ogevia.action_issue_rows(p_organization_id uuid, p_can_cover boolean, p_can_visits boolean, p_can_docs boolean, p_can_comp boolean, p_can_bill boolean, p_urgent_hours integer default 48)
returns table (issue_key text, kind text, reason text, queue text, category text, severity text, deadline timestamptz, since timestamptz,
               client_id uuid, caregiver_record_id uuid, service_id uuid, shift_id uuid, visit_id uuid, entity_id uuid)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_win interval := make_interval(hours => p_urgent_hours);
begin
  return query
  with raw as (
    -- uncovered shifts: now / inside the window / beyond it
    select 'shift'::text k, case when ogevia.shift_is_called_out(sh.id) then 'uncovered_called_out' else 'uncovered_open' end r,
           case when sh.starts_at > now() + v_win then 'upcoming_staffing' else 'needs_attention_now' end q, 'coverage'::text cat,
           case when sh.starts_at > now() + v_win then 'routine' else ogevia.attention_shift_tier(sh.starts_at, now()) end sev,
           sh.starts_at dl, sh.starts_at sn, sh.client_id cl, null::uuid cg, sh.service_id sv, sh.id sf, null::uuid vs, sh.id en
    from ogevia.shifts sh
    where p_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now()
      and ogevia.shift_coverage_state(sh) = 'needs_coverage'
    union all
    -- shifts whose caregiver is blocked (compliance hold or a required document)
    select 'shift', case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end,
           case when sh.starts_at > now() + v_win then 'upcoming_staffing' else 'needs_attention_now' end, 'compliance',
           case when sh.starts_at > now() + v_win then 'routine' else ogevia.attention_shift_tier(sh.starts_at, now()) end,
           sh.starts_at, sh.starts_at, sh.client_id, f.caregiver_record_id, sh.service_id, sh.id, null::uuid, sh.id
    from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
    where (p_can_comp or p_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
      and sh.status = 'scheduled' and sh.ends_at > now() and not ogevia.shift_is_called_out(sh.id)
    union all
    select 'visit', 'missing_clock_out', 'needs_attention_now', 'visits', 'urgent', coalesce(s.ends_at, v.time_in + interval '12 hours'), v.time_in, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v left join ogevia.shifts s on s.id = v.scheduled_shift_id
    where p_can_visits and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
      and ((s.id is not null and s.ends_at < now()) or (s.id is null and v.time_in <= now() - interval '12 hours'))
    union all
    select 'visit', 'in_progress_on_hold', 'needs_attention_now', 'compliance', 'critical', v.time_in, v.time_in, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v
    join ogevia.caregiver_records cr on cr.organization_id = v.organization_id and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id))
    where (p_can_comp or p_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null and ogevia.caregiver_blocked_now(v.organization_id, cr.id)
    union all
    -- visit review stream
    select 'visit', 'pending_confirmation', 'visit_review', 'visits', 'routine', v.time_out + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue')), v.time_out, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
      and v.time_out > now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
    union all
    select 'visit', 'confirmation_overdue', 'visit_review', 'visits', 'urgent', v.time_out + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue')), v.time_out, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
      and v.time_out <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
    union all
    select 'visit', 'needs_review', 'visit_review', 'visits',
           case when ogevia.visit_review_entered_at(v.id) <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')) then 'urgent' else 'routine' end,
           ogevia.visit_review_entered_at(v.id) + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')), ogevia.visit_review_entered_at(v.id), v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'administrator_review'
      and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null) and ogevia.visit_recovery_state(v.id) is null
    union all
    select 'visit', 'late_response', 'visit_review', 'visits',
           case when ogevia.visit_late_response_at(v.id) <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')) then 'urgent' else 'routine' end,
           ogevia.visit_late_response_at(v.id) + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')), ogevia.visit_late_response_at(v.id), v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'administrator_review' and ogevia.visit_recovery_state(v.id) = 'response_to_review'
    union all
    select 'visit', 'ready_for_approval', 'ready_for_approval', 'visits', 'routine', null::timestamptz, v.signed_at, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_bill and v.organization_id = p_organization_id and v.status in ('signed', 'administrator_review') and ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
    union all
    select 'visit', 'authorization_decreased', 'visit_review', 'authorization', 'routine', null::timestamptz, h.created_at, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.visit_authorization_reviews h join ogevia.service_visits v on v.id = h.visit_id and v.status in ('signed', 'administrator_review')
    where p_can_visits and h.organization_id = p_organization_id and h.resolved_at is null
    union all
    -- pickup requests, reconciliation, amendment impacts
    select 'pickup_request', 'pending_pickup', 'pickup_requests', 'staffing', 'routine', null::timestamptz, r.requested_at, sh.client_id, null::uuid, sh.service_id, sh.id, null::uuid, r.id
    from ogevia.shift_pickup_requests r join ogevia.shifts sh on sh.id = r.shift_id
    where p_can_cover and r.organization_id = p_organization_id and r.status = 'pending' and sh.status = 'scheduled' and sh.ends_at > now()
    union all
    select 'shift', 'reconcile_' || ogevia.reservation_bucket(r.id)::text, 'reconciliation', 'authorization', 'routine', null::timestamptz, sh.ends_at, sh.client_id, null::uuid, sh.service_id, sh.id, null::uuid, sh.id
    from ogevia.authorization_reservations r join ogevia.shifts sh on sh.id = r.shift_id
    where p_can_cover and r.organization_id = p_organization_id and r.released_at is null and ogevia.reservation_bucket(r.id) in ('unreconciled', 'awaiting_record')
    union all
    select 'impact', i.impact_kind::text, 'authorization_changes', 'authorization', 'routine', null::timestamptz, i.created_at,
           coalesce(sh.client_id, v.client_id), null::uuid, coalesce(sh.service_id, v.service_id), i.shift_id, i.visit_id, i.id
    from ogevia.authorization_amendment_impacts i
    left join ogevia.shifts sh on sh.id = i.shift_id left join ogevia.service_visits v on v.id = i.visit_id
    where p_can_cover and i.organization_id = p_organization_id
      and not exists (select 1 from ogevia.authorization_amendment_impact_acks k where k.impact_id = i.id)
      and case when i.shift_id is not null then ogevia.reservation_bucket(i.reservation_id) is not null
               else exists (select 1 from ogevia.service_visits v2 where v2.id = i.visit_id and v2.status in ('signed', 'administrator_review')) end
  ), docs as (
    select d.document_id, d.caregiver_record_id, d.display_status, d.latest_uploaded_at, d.due_on, d.expires_on, d.currency_status
    from ogevia_api.list_staff_documents(p_organization_id, null) d where p_can_docs
  )
  select ('' || x.k || ':' || x.r || ':' || x.en::text)::text, x.k, x.r, x.q, x.cat, x.sev, x.dl, x.sn, x.cl, x.cg, x.sv, x.sf, x.vs, x.en
  from raw x
  union all
  select 'document:' || (case when d.display_status in ('expired', 'overdue') then d.display_status
                               when d.display_status = 'awaiting_review' then (case when esc.escalated then 'review_overdue' else 'awaiting_review' end)
                               when d.display_status = 'expiring' then 'expiring' else 'rejected' end) || ':' || d.document_id::text,
         'document', case when d.display_status in ('expired', 'overdue') then d.display_status
                          when d.display_status = 'awaiting_review' then (case when esc.escalated then 'review_overdue' else 'awaiting_review' end)
                          when d.display_status = 'expiring' then 'expiring' else 'rejected' end,
         'documents_compliance', 'documents',
         case when d.display_status in ('expired', 'overdue') or (d.display_status = 'awaiting_review' and esc.escalated) then 'urgent' else 'routine' end,
         case when d.display_status = 'awaiting_review' then d.latest_uploaded_at + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'))
              else coalesce(d.expires_on::timestamptz, d.due_on::timestamptz) end,
         coalesce(d.latest_uploaded_at, now()), null::uuid, d.caregiver_record_id, null::uuid, null::uuid, null::uuid, d.document_id
  from docs d
  cross join lateral (select (d.display_status = 'awaiting_review'
              and (d.latest_uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'))
                   or d.currency_status = 'expired'
                   or exists (select 1 from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
                               where f.organization_id = p_organization_id and f.caregiver_record_id = d.caregiver_record_id and f.kind = 'document' and f.resolved_at is null
                                 and sh.status = 'scheduled' and sh.ends_at > now() and not ogevia.shift_is_called_out(sh.id)))) as escalated) esc
  where d.display_status in ('expired', 'overdue', 'expiring', 'awaiting_review', 'rejected')
  union all
  select 'caregiver:compliance_hold:' || h.caregiver_record_id::text, 'caregiver', 'compliance_hold', 'documents_compliance', 'compliance', 'routine', null::timestamptz, h.opened_at,
         null::uuid, h.caregiver_record_id, null::uuid, null::uuid, null::uuid, h.caregiver_record_id
  from ogevia.caregiver_compliance_holds h where p_can_comp and h.organization_id = p_organization_id and h.released_at is null;
end;
$$;
drop trigger client_gate_reservation on ogevia.authorization_reservations;
drop function ogevia.client_gate_reservation();
drop function ogevia.client_gate(uuid, uuid, uuid);
drop function ogevia_api.find_possible_duplicate_clients(uuid, text, text, uuid);
drop function ogevia_api.get_client_issue_history(uuid, uuid);
drop function ogevia_api.list_client_audit(uuid, uuid, integer);
drop function ogevia_api.release_client_service_hold(uuid, uuid, text, uuid);
drop function ogevia_api.open_client_service_hold(uuid, uuid, uuid, text, uuid);
drop function ogevia_api.set_client_preparation(uuid, uuid, text, text, uuid);
drop function ogevia_api.get_client_readiness(uuid, uuid);
drop function ogevia_api.open_client_document_version(uuid);
drop function ogevia_api.review_client_document_version(uuid, text, text, uuid);
drop function ogevia_api.register_client_document_version(uuid, uuid, text, text, text, integer, text, date, date, uuid);
drop function ogevia_api.get_client_document_upload_replay(uuid, uuid);
drop function ogevia_api.ensure_client_document(uuid, uuid, uuid);
drop function ogevia_api.list_client_documents(uuid, uuid);
drop function ogevia_api.set_client_document_requirement(uuid, uuid, uuid, boolean, uuid);
drop function ogevia_api.save_client_document_type(uuid, text, text, boolean, boolean, uuid);
drop function ogevia_api.list_client_document_types(uuid);
drop function ogevia.client_document_state(uuid, uuid, uuid);
drop table ogevia.client_preparation;
drop table ogevia.client_service_holds;
drop table ogevia.client_document_versions;
drop table ogevia.client_documents;
drop table ogevia.client_document_requirements;
drop table ogevia.client_document_types;
drop function ogevia.client_document_versions_guard_update();
drop function ogevia.stable_uuid(text);
