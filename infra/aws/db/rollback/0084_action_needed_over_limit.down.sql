-- ROLLBACK 0084 | CLASS: SAFE AUTOMATED (functions only; no table, column or stored row changes). Restores the 0074 action_issue_rows and the 0073 list_action_issues (no Over limit
-- item) and drops over_limit_lineages. Issue-state rows and events already written for over_limit issues stay as history; they are never listed again.
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
  -- client documents (0074): a REQUIRED document that is expired is urgent; one waiting for review or rejected is routine (the routine review deadline moves it up like a staff document)
  select 'client_document:' || cd.state || ':' || cd.document_type_id::text || ':' || cd.client_id::text, 'client_document', cd.state, 'documents_compliance', 'documents',
         case when cd.state = 'expired' or (cd.state = 'review_overdue') then 'urgent' else 'routine' end,
         case when cd.state in ('awaiting_review', 'review_overdue') then cd.uploaded_at + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue')) else cd.expires_on::timestamptz end,
         coalesce(cd.uploaded_at, now()), cd.client_id, null::uuid, null::uuid, null::uuid, null::uuid,
         ogevia.stable_uuid('client_document:' || cd.client_id::text || ':' || cd.document_type_id::text)
  from (
    select x.client_id, x.document_type_id, x.uploaded_at, x.expires_on,
           case when x.review_status is null then null
                when x.review_status = 'awaiting_review' then (case when x.uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue')) then 'review_overdue' else 'awaiting_review' end)
                when x.review_status = 'rejected' then 'rejected'
                when x.expires_on is not null and x.expires_on < ogevia.organization_local_date(p_organization_id, now()) then 'expired' end as state
    from (
      select d.client_id, d.document_type_id, v.uploaded_at, v.expires_on, v.review_status
      from ogevia.client_documents d
      join ogevia.client_document_versions v on v.document_id = d.id and v.version_number = (select max(v2.version_number) from ogevia.client_document_versions v2 where v2.document_id = d.id)
      join ogevia.clients c on c.id = d.client_id and c.status = 'active' and c.deleted_at is null
      where p_can_docs and d.organization_id = p_organization_id
        and exists (select 1 from ogevia.client_document_requirements r join ogevia.client_authorizations a on a.service_id = r.service_id and a.client_id = d.client_id and a.is_current
                     where r.document_type_id = d.document_type_id and r.removed_at is null)
    ) x
  ) cd
  where cd.state is not null
  union all
  select 'caregiver:compliance_hold:' || h.caregiver_record_id::text, 'caregiver', 'compliance_hold', 'documents_compliance', 'compliance', 'routine', null::timestamptz, h.opened_at,
         null::uuid, h.caregiver_record_id, null::uuid, null::uuid, null::uuid, h.caregiver_record_id
  from ogevia.caregiver_compliance_holds h where p_can_comp and h.organization_id = p_organization_id and h.released_at is null;
end;
$$;

create or replace function ogevia_api.list_action_issues(
  p_organization_id uuid, p_queue text default null, p_category text default null, p_severity text default null,
  p_client_id uuid default null, p_caregiver_record_id uuid default null, p_service_id uuid default null,
  p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_can_cover boolean; v_can_visits boolean; v_can_docs boolean; v_can_comp boolean; v_can_bill boolean;
  v_counts jsonb;
  v_items jsonb;
  v_total integer;
  v_tmp bigint;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_can_visits := ogevia.has_permission(p_organization_id, 'visits.read');
  v_can_cover := ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  v_can_docs := ogevia.has_permission(p_organization_id, 'documents.read');
  v_can_comp := ogevia.has_permission(p_organization_id, 'readiness.read');
  v_can_bill := ogevia.has_permission(p_organization_id, 'billing.visits.read');
  if not (v_can_visits or v_can_cover or v_can_docs or v_can_comp) then raise exception 'You do not have permission to see attention items' using errcode = 'OGA03'; end if;
  if p_queue is not null and p_queue not in ('needs_attention_now', 'upcoming_staffing', 'documents_compliance', 'visit_review', 'ready_for_approval', 'pickup_requests', 'reconciliation', 'authorization_changes') then
    raise exception 'Unknown queue' using errcode = 'OGV22'; end if;
  if p_category is not null and p_category not in ('coverage', 'visits', 'documents', 'compliance', 'authorization', 'staffing') then raise exception 'Unknown category' using errcode = 'OGV22'; end if;
  if p_severity is not null and p_severity not in ('critical', 'urgent', 'routine') then raise exception 'Unknown severity' using errcode = 'OGV22'; end if;
  p_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  p_offset := greatest(0, coalesce(p_offset, 0));
  perform pg_advisory_xact_lock(hashtextextended('action_issues:' || p_organization_id::text, 0));

  -- record transitions as OBSERVED now (opened, severity changed, resolved, reopened); the list below is the same snapshot
  with cur as (select * from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill)),
  prior as (select s.issue_key, s.status, s.last_severity from ogevia.action_issue_state s where s.organization_id = p_organization_id),
  ev as (
    insert into ogevia.action_issue_events (organization_id, issue_key, event, severity, observed_by)
    select p_organization_id, c.issue_key,
           case when pr.issue_key is null then 'opened' when pr.status = 'resolved' then 'reopened' else 'severity_changed' end, c.severity, v_actor
    from cur c left join prior pr on pr.issue_key = c.issue_key
    where pr.issue_key is null or pr.status = 'resolved' or pr.last_severity <> c.severity
    returning 1
  ), up as (
    insert into ogevia.action_issue_state (organization_id, issue_key, kind, reason, queue, category, entity_id, client_id, status, last_severity)
    select p_organization_id, c.issue_key, c.kind, c.reason, c.queue, c.category, c.entity_id, c.client_id, 'open', c.severity from cur c
    on conflict (organization_id, issue_key) do update
      set last_seen_at = now(), last_severity = excluded.last_severity, status = 'open', resolved_at = null, client_id = excluded.client_id,
          reopen_count = ogevia.action_issue_state.reopen_count + case when ogevia.action_issue_state.status = 'resolved' then 1 else 0 end
    returning 1
  )
  select count(*) into v_tmp from ev, up;
  -- anything this actor's view no longer contains is resolved only if the actor could see its whole queue; to keep one rule, resolution is recorded for the issues the
  -- actor's permissions cover (a person with fewer permissions never closes an issue that only another role can see)
  with cur as (select issue_key from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill)),
  gone as (
    update ogevia.action_issue_state s set status = 'resolved', resolved_at = now()
    where s.organization_id = p_organization_id and s.status = 'open' and not exists (select 1 from cur c where c.issue_key = s.issue_key)
      and case s.queue
            when 'needs_attention_now' then (v_can_cover or v_can_visits or v_can_comp) when 'upcoming_staffing' then (v_can_cover or v_can_comp)
            when 'documents_compliance' then (v_can_docs and v_can_comp) when 'visit_review' then v_can_visits when 'ready_for_approval' then v_can_bill
            else v_can_cover end
    returning s.issue_key, s.last_severity)
  insert into ogevia.action_issue_events (organization_id, issue_key, event, severity, observed_by)
  select p_organization_id, g.issue_key, 'resolved', g.last_severity, v_actor from gone g;

  with cur as (select * from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill)),
  f as (select * from cur c where (p_queue is null or c.queue = p_queue) and (p_category is null or c.category = p_category) and (p_severity is null or c.severity = p_severity)
          and (p_client_id is null or c.client_id = p_client_id) and (p_caregiver_record_id is null or c.caregiver_record_id = p_caregiver_record_id) and (p_service_id is null or c.service_id = p_service_id))
  select (select count(*) from f),
         (select jsonb_build_object(
            'total', count(*), 'critical', count(*) filter (where c.severity = 'critical'), 'urgent', count(*) filter (where c.severity = 'urgent'), 'routine', count(*) filter (where c.severity = 'routine'),
            'actionNeeded', count(*) filter (where c.severity in ('critical', 'urgent') and c.queue in ('needs_attention_now', 'documents_compliance', 'visit_review')),
            'byQueue', coalesce((select jsonb_object_agg(q.queue, q.n) from (select c2.queue, count(*) n from cur c2 group by c2.queue) q), '{}'::jsonb))
          from cur c)
    into v_total, v_counts;
  select coalesce(jsonb_agg(jsonb_build_object(
           'issueKey', t.issue_key, 'kind', t.kind, 'reason', t.reason, 'queue', t.queue, 'category', t.category, 'severity', t.severity,
           'deadline', t.deadline, 'since', t.since, 'shiftId', t.shift_id, 'visitId', t.visit_id, 'entityId', t.entity_id, 'caregiverRecordId', t.caregiver_record_id,
           'clientId', t.client_id, 'serviceId', t.service_id,
           'clientCode', (select cl.client_code from ogevia.clients cl where cl.id = t.client_id),
           'caregiverCode', (select cr.caregiver_code from ogevia.caregiver_records cr where cr.id = t.caregiver_record_id),
           'serviceCode', (select s2.code from ogevia.services s2 where s2.id = t.service_id),
           'status', 'open',
           'firstSeenAt', (select st.first_seen_at from ogevia.action_issue_state st where st.organization_id = p_organization_id and st.issue_key = t.issue_key),
           'reopenCount', (select st.reopen_count from ogevia.action_issue_state st where st.organization_id = p_organization_id and st.issue_key = t.issue_key),
           'action', case t.reason
              when 'uncovered_open' then 'assign_caregiver' when 'uncovered_called_out' then 'assign_caregiver' when 'compliance_hold' then 'review_hold' when 'documents_not_current' then 'review_documents'
              when 'missing_clock_out' then 'review_visit' when 'in_progress_on_hold' then 'arrange_coverage' when 'pending_confirmation' then 'wait_or_resend' when 'confirmation_overdue' then 'follow_up_confirmation'
              when 'needs_review' then 'review_visit' when 'late_response' then 'review_visit' when 'ready_for_approval' then 'approve_billing' when 'authorization_decreased' then 'review_authorization'
              when 'pending_pickup' then 'confirm_pickup' when 'expired' then 'renew_document' when 'overdue' then 'renew_document' when 'review_overdue' then 'review_document'
              when 'awaiting_review' then 'review_document' when 'expiring' then 'request_renewal' when 'rejected' then 'follow_up_document'
              when 'reconcile_unreconciled' then 'reconcile_shift' when 'reconcile_awaiting_record' then 'reconcile_shift' else 'review_authorization_change' end,
           'recommendedAction', case t.reason
              when 'uncovered_open' then 'Choose an eligible caregiver and confirm the assignment.' when 'uncovered_called_out' then 'The caregiver called out: choose a replacement and confirm.'
              when 'compliance_hold' then 'The assigned caregiver is on a compliance hold: review the hold or choose another caregiver.' when 'documents_not_current' then 'A required document is not current: review it or choose another caregiver.'
              when 'missing_clock_out' then 'The visit is still open: find out the real end time and correct the visit.' when 'in_progress_on_hold' then 'The caregiver on this visit is on a hold: arrange safe coverage. Nothing is ended for you.'
              when 'pending_confirmation' then 'Waiting for the client or representative. It moves up if no answer comes in time.' when 'confirmation_overdue' then 'No confirmation yet: contact the client or representative, or record why it cannot be obtained.'
              when 'needs_review' then 'Review the visit and record a decision.' when 'late_response' then 'A late response arrived: review it and decide.' when 'ready_for_approval' then 'Approve the billable minutes, or send it back.'
              when 'authorization_decreased' then 'The authorization was lowered after this visit: confirm it is still billable, or correct it.' when 'pending_pickup' then 'A caregiver asked for this shift: confirm or decline.'
              when 'expired' then 'The document is expired: get a current one.' when 'overdue' then 'The document is overdue: get it.' when 'review_overdue' then 'This upload has waited too long: approve or reject it.'
              when 'awaiting_review' then 'Review the upload.' when 'expiring' then 'Expires soon: ask for a renewal.' when 'rejected' then 'Rejected: make sure the caregiver knows what to fix.'
              when 'reconcile_unreconciled' then 'The shift ended with no visit record: decide what happened. Nothing is released automatically.' when 'reconcile_awaiting_record' then 'Still awaiting a decision about this ended shift.'
              else 'An authorization change affected this record: review it and acknowledge.' end)
         order by case t.severity when 'critical' then 0 when 'urgent' then 1 else 2 end, t.deadline nulls last, t.issue_key), '[]'::jsonb)
    into v_items
  from (select c.* from ogevia.action_issue_rows(p_organization_id, v_can_cover, v_can_visits, v_can_docs, v_can_comp, v_can_bill) c
         where (p_queue is null or c.queue = p_queue) and (p_category is null or c.category = p_category) and (p_severity is null or c.severity = p_severity)
           and (p_client_id is null or c.client_id = p_client_id) and (p_caregiver_record_id is null or c.caregiver_record_id = p_caregiver_record_id) and (p_service_id is null or c.service_id = p_service_id)
         order by case c.severity when 'critical' then 0 when 'urgent' then 1 else 2 end, c.deadline nulls last, c.issue_key
         limit p_limit offset p_offset) t;
  return jsonb_build_object('asOf', now(), 'matching', v_total, 'limit', p_limit, 'offset', p_offset, 'counts', v_counts, 'issues', v_items);
end;
$$;

drop function ogevia.over_limit_lineages(uuid, date);
