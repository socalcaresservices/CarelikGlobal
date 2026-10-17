-- ROLLBACK 0064 | CLASS: BACKUP REQUIRED (the background-check event history is dropped). Restores the 0055 hold logic, "Check now" permission and counts, and the 0063 overview.
drop trigger caregiver_compliance_holds_guard_update on ogevia.caregiver_compliance_holds;
drop function ogevia.caregiver_compliance_holds_guard();
drop trigger caregiver_compliance_holds_no_delete on ogevia.caregiver_compliance_holds;
drop function ogevia_api.get_background_check_history(uuid, uuid);
drop trigger caregiver_background_checks_history on ogevia.caregiver_background_checks;
drop function ogevia.caregiver_background_checks_history();
drop table ogevia.caregiver_background_check_events;
create or replace function ogevia.compliance_evaluate(p_organization_id uuid, p_caregiver_record_id uuid, p_actor uuid default null, p_now timestamptz default now())
returns text
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_hold ogevia.caregiver_compliance_holds%rowtype;
  v_reasons jsonb;
  v_closed boolean;
  v_impact jsonb;
begin
  if not ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start') then return 'not_enforced'; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null or v_rec.status not in ('ready', 'active') then return 'not_applicable'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('requirement', b.requirement, 'code', b.code, 'message', b.message, 'dueDate', b.due_date)
                            order by b.requirement), '[]'::jsonb),
         coalesce(bool_or(b.code like '%\_after\_deadline'), false)
    into v_reasons, v_closed
  from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id, p_now) b where b.blocking;

  select * into v_hold from ogevia.caregiver_compliance_holds h where h.caregiver_record_id = p_caregiver_record_id and h.released_at is null for update;

  if jsonb_array_length(v_reasons) > 0 then
    if v_hold.id is null then
      insert into ogevia.caregiver_compliance_holds (organization_id, caregiver_record_id, reasons, grace_closed, opened_at, opened_by)
      values (p_organization_id, p_caregiver_record_id, v_reasons, v_closed, p_now, p_actor)
      returning * into v_hold;
      v_impact := ogevia.compliance_flag_impact(p_organization_id, p_caregiver_record_id, v_hold.id, v_reasons, p_actor);
      perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_opened', 'caregiver_compliance_holds', v_hold.id, null,
        jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'reasons', v_reasons, 'automatic', p_actor is null) || v_impact, null);
      return 'opened';
    end if;
    -- A hold that was opened because the period ended stays that way even if a later hire date would put the caregiver back in it.
    update ogevia.caregiver_compliance_holds h
       set reasons = v_reasons, grace_closed = h.grace_closed or v_closed, updated_at = now()
     where h.id = v_hold.id and (h.reasons is distinct from v_reasons or (v_closed and not h.grace_closed));
    if found then
      perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_updated', 'caregiver_compliance_holds', v_hold.id,
        jsonb_build_object('reasons', v_hold.reasons), jsonb_build_object('reasons', v_reasons), null);
    end if;
    perform ogevia.compliance_flag_impact(p_organization_id, p_caregiver_record_id, v_hold.id, v_reasons, p_actor);
    return 'updated';
  end if;

  if v_hold.id is not null then
    update ogevia.caregiver_compliance_holds h
       set released_at = p_now, released_by = p_actor, updated_at = now(),
           release_note = 'Every blocking requirement is resolved. Shifts that were cancelled or reassigned while the hold was open were not restored.'
     where h.id = v_hold.id;
    update ogevia.shift_readiness_flags f
       set resolved_at = now(), resolved_by = p_actor,
           resolution = 'Compliance hold released: every blocking requirement is resolved. This shift was not changed.'
     where f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null;
    update ogevia.assignment_readiness_flags f
       set resolved_at = now(), resolved_by = p_actor,
           resolution = 'Compliance hold released: every blocking requirement is resolved.'
     where f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null;
    perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_released', 'caregiver_compliance_holds', v_hold.id,
      jsonb_build_object('reasons', v_hold.reasons), jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'automatic', p_actor is null), null);
    return 'released';
  end if;
  return 'none';
end;
$$;
create or replace function ogevia.compliance_blockers(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
returns table (requirement text, code text, message text, blocking boolean, due_date date)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  g record;
  c record;
  r text;
  v_bg text;
  v_base text;
  v_days text := ogevia.compliance_grace_days()::text || '-day';
begin
  select * into g from ogevia.compliance_grace(p_organization_id, p_caregiver_record_id, p_as_of);
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg <> 'approved' then
    return query select 'background'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg), true, null::date;
  end if;
  for r in select x from unnest(array['cpr', 'tb']) as x loop
    select * into c from ogevia.document_requirement_check(p_organization_id, p_caregiver_record_id, r, null, null);
    if c.status = 'ok' then continue; end if;
    if c.status in ('missing', 'awaiting_review') then
      v_base := ogevia.readiness_message(r, c.status);
      if g.in_grace then
        return query select r, c.status || '_pending', v_base || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', false, g.due_date;
      elsif g.hire_date is null then
        return query select r, c.status || '_no_hire_date',
          v_base || ' Hire date is not recorded, so the ' || v_days || ' period cannot be applied.', true, null::date;
      elsif g.sticky and p_as_of < g.grace_ends_at then
        return query select r, c.status || '_after_deadline',
          v_base || ' The ' || v_days || ' period already ended and a hold is open; changing the hire date does not reopen it.', true, g.due_date;
      else
        return query select r, c.status || '_after_deadline',
          v_base || ' The ' || v_days || ' period ended ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', true, g.due_date;
      end if;
    else
      -- rejected, expired, expires_during, expiry_missing, type_not_set, policy_not_set: unchanged strict behaviour
      return query select r, c.status, ogevia.readiness_message(r, c.status), true, null::date;
    end if;
  end loop;
end;
$$;
create or replace function ogevia_api.run_compliance_sweep(p_organization_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  return ogevia.compliance_sweep(p_organization_id, v_actor);
end;
$$;
create or replace function ogevia_api.get_compliance_attention(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) or not ogevia.has_permission(p_organization_id, 'readiness.read') then
    return null;
  end if;
  return jsonb_build_object(
    'holds', (select count(*) from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null),
    'affectedShifts', (select count(*) from ogevia.shift_readiness_flags f
                       where f.organization_id = p_organization_id and f.kind = 'compliance' and f.resolved_at is null),
    'inProgressVisits', (select count(*) from ogevia.service_visits v
                         join ogevia.caregiver_compliance_holds h on h.organization_id = v.organization_id and h.released_at is null
                          and (h.caregiver_record_id = v.caregiver_record_id
                               or (v.caregiver_record_id is null
                                   and v.caregiver_user_id = (select r.linked_user_id from ogevia.caregiver_records r where r.id = h.caregiver_record_id)))
                         where v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null));
end;
$$;
create or replace function ogevia_api.get_attention_overview(p_organization_id uuid, p_urgent_hours integer default 48)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_win interval;
  v_can_visits boolean;
  v_can_cover boolean;
  v_can_docs boolean;
  v_can_comp boolean;
  v_can_bill boolean;
  v_urgent jsonb := null;
  v_upcoming jsonb := null;
  v_docs jsonb := null;
  v_review jsonb := null;
  v_pick jsonb := null;
  v_holds integer;
  v_pending integer;
begin
  if p_urgent_hours is null or p_urgent_hours < 1 or p_urgent_hours > 168 then
    raise exception 'The urgent window must be 1 to 168 hours' using errcode = 'OGV22';
  end if;
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_win := make_interval(hours => p_urgent_hours);
  v_can_visits := ogevia.has_permission(p_organization_id, 'visits.read');
  v_can_cover := ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  v_can_docs := ogevia.has_permission(p_organization_id, 'documents.read');
  v_can_comp := ogevia.has_permission(p_organization_id, 'readiness.read');
  v_can_bill := ogevia.has_permission(p_organization_id, 'billing.visits.read');
  if not (v_can_visits or v_can_cover or v_can_docs or v_can_comp) then
    raise exception 'You do not have permission to see attention items' using errcode = 'OGA03';
  end if;

  -- NEEDS ATTENTION NOW -------------------------------------------------------------------------------------------
  if v_can_cover or v_can_visits or v_can_comp then
    with reasons as (
      -- an uncovered shift that starts inside the window or is already running
      select 'shift'::text as kind, sh.id as id, sh.starts_at as at, sh.ends_at as ends_at,
             case when ogevia.shift_is_called_out(sh.id) then 'uncovered_called_out' else 'uncovered_open' end as reason,
             ogevia.attention_shift_tier(sh.starts_at, now()) as severity, null::uuid as caregiver_id, sh.client_id as client_id, sh.service_id as service_id
      from ogevia.shifts sh
      where v_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at <= now() + v_win
        and ogevia.shift_coverage_state(sh) = 'needs_coverage'
      union all
      -- a shift inside the window whose caregiver is blocked (0055 hold, or a required-document problem flagged by 0041)
      select 'shift', sh.id, sh.starts_at, sh.ends_at,
             case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end, ogevia.attention_shift_tier(sh.starts_at, now()), f.caregiver_record_id, sh.client_id, sh.service_id
      from ogevia.shift_readiness_flags f
      join ogevia.shifts sh on sh.id = f.shift_id
      where (v_can_comp or v_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
        and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at <= now() + v_win and not ogevia.shift_is_called_out(sh.id)
      union all
      -- a visit still open past its shift end (or 12 h without a schedule): the worked time is unknown
      select 'visit', v.id, v.time_in, null::timestamptz, 'missing_clock_out', 'urgent', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      left join ogevia.shifts s on s.id = v.scheduled_shift_id
      where v_can_visits and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
        and ((s.id is not null and s.ends_at < now()) or (s.id is null and v.time_in <= now() - interval '12 hours'))
      union all
      -- a visit in progress for a caregiver who is on a compliance hold: the office must arrange safe coverage
      select 'visit', v.id, v.time_in, null::timestamptz, 'in_progress_on_hold', 'critical', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      join ogevia.caregiver_compliance_holds h on h.organization_id = v.organization_id and h.released_at is null
       and (h.caregiver_record_id = v.caregiver_record_id
            or (v.caregiver_record_id is null and v.caregiver_user_id = (select r.linked_user_id from ogevia.caregiver_records r where r.id = h.caregiver_record_id)))
      where (v_can_comp or v_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
    ), items as (
      select r.kind, r.id, min(r.at) as at, max(r.ends_at) as ends_at,
             (array_agg(distinct r.reason order by r.reason)) as reasons,
             case when bool_or(r.severity = 'critical') then 'critical' else 'urgent' end as tier,
             max(r.caregiver_id::text)::uuid as caregiver_id, max(r.client_id::text)::uuid as client_id, max(r.service_id::text)::uuid as service_id
      from reasons r group by r.kind, r.id
    )
    select jsonb_build_object(
             'items', coalesce(jsonb_agg(jsonb_build_object(
                'kind', i.kind, 'id', i.id, 'startsAt', i.at, 'endsAt', i.ends_at, 'reasons', to_jsonb(i.reasons), 'tier', i.tier, 'severity', case when i.tier = 'critical' then 'red' else 'amber' end,
                'inProgress', i.at <= now() and (i.ends_at is null or i.ends_at > now()),
                'caregiverRecordId', i.caregiver_id, 'caregiverCode', (select r2.caregiver_code from ogevia.caregiver_records r2 where r2.id = i.caregiver_id),
                'clientCode', (select c.client_code from ogevia.clients c where c.id = i.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = i.service_id)) order by (i.tier = 'critical') desc, i.at), '[]'::jsonb),
             'itemCount', count(*),
             'issueCount', coalesce(sum(cardinality(i.reasons)), 0),
             'shifts', count(*) filter (where i.kind = 'shift'),
             'visits', count(*) filter (where i.kind = 'visit'),
             'critical', count(*) filter (where i.tier = 'critical'),
             'urgent', count(*) filter (where i.tier = 'urgent'))
      into v_urgent
    from items i;
  end if;

  -- UPCOMING STAFFING: shifts that start after the window and still need a person's attention: uncovered, or whose caregiver is blocked
  -- (0055 hold, required document). Same timing rule as Needs attention now: Upcoming beyond the window (more than 48 h), Urgent inside it, Critical at/after start.
  -- A hold is enforced immediately whatever the display tier; this only decides where the shift is listed.
  if v_can_cover or v_can_comp then
    select jsonb_build_object(
             'count', count(*),
             'nextStartsAt', min(x.starts_at),
             'shifts', coalesce(jsonb_agg(jsonb_build_object(
                'shiftId', x.id, 'startsAt', x.starts_at, 'endsAt', x.ends_at, 'reason', x.reason,
                'clientCode', (select c.client_code from ogevia.clients c where c.id = x.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = x.service_id),
                'serviceName', (select s2.name from ogevia.services s2 where s2.id = x.service_id)) order by x.starts_at, x.id) filter (where x.rn <= 200), '[]'::jsonb))
      into v_upcoming
    from (
      select y.*, row_number() over (order by y.starts_at, y.id) as rn
      from (
        select distinct on (u.id) u.* from (
          select sh.id, sh.starts_at, sh.ends_at, sh.client_id, sh.service_id,
                 case when ogevia.shift_is_called_out(sh.id) then 'called_out' else 'open' end as reason
          from ogevia.shifts sh
          where v_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.starts_at > now() + v_win
            and ogevia.shift_coverage_state(sh) = 'needs_coverage'
          union all
          select sh.id, sh.starts_at, sh.ends_at, sh.client_id, sh.service_id,
                 case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end
          from ogevia.shift_readiness_flags f
          join ogevia.shifts sh on sh.id = f.shift_id
          where (v_can_comp or v_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
            and sh.status = 'scheduled' and sh.starts_at > now() + v_win and not ogevia.shift_is_called_out(sh.id)
        ) u order by u.id, u.reason
      ) y
    ) x;
  end if;

  -- DOCUMENTS & COMPLIANCE -----------------------------------------------------------------------------------------------
  if v_can_docs then
    -- Routine review (awaiting a person, inside the deadline) is reported apart from review that has escalated: more than 48 hours since
    -- the upload, OR the document is expired, OR its caregiver has an upcoming shift flagged for documents (it blocks care).
    with d as (
      select x.display_status,
             (x.display_status = 'awaiting_review'
              and (x.latest_uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours('document_review_overdue'))
                   or x.currency_status = 'expired'
                   or exists (select 1 from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
                               where f.organization_id = p_organization_id and f.caregiver_record_id = x.caregiver_record_id
                                 and f.kind = 'document' and f.resolved_at is null and sh.status = 'scheduled' and sh.ends_at > now()
                                 and not ogevia.shift_is_called_out(sh.id)))) as escalated
      from ogevia_api.list_staff_documents(p_organization_id, null) x
    )
    select jsonb_build_object(
             'overdue', count(*) filter (where d.display_status in ('expired', 'overdue')),
             'dueSoon', count(*) filter (where d.display_status = 'expiring'),
             'awaitingReview', count(*) filter (where d.display_status = 'awaiting_review'),
             'reviewOverdue', count(*) filter (where d.escalated),
             'reviewRoutine', count(*) filter (where d.display_status = 'awaiting_review' and not d.escalated),
             'rejected', count(*) filter (where d.display_status = 'rejected'))
      into v_docs
    from d;
  end if;
  if v_can_comp then
    select count(*)::int into v_holds from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null;
    select count(*)::int into v_pending from ogevia.caregiver_records r
    where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active')
      and exists (select 1 from ogevia.compliance_blockers(p_organization_id, r.id) b where not b.blocking);
    v_docs := coalesce(v_docs, '{}'::jsonb) || jsonb_build_object('caregiversOnHold', v_holds, 'caregiversWithPendingRequirements', v_pending);
  end if;

  -- VISIT REVIEW: unique visits. What needs a person (administrator review from the moment it starts, a late answer, a confirmation more than 48 h
  -- overdue) is counted in visitsNeedingAttention. Pending Confirmation (inside 48 h of the visit end) and Ready for Approval are counted apart and
  -- never added to it. Administrator review is Urgent after 24 h in the queue (reviewOverdue).
  if v_can_visits then
    with u as (
      select v.id, 'pending_confirmation'::text as kind, v.time_out as at from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
         and v.time_out > now() - make_interval(hours => ogevia.attention_rule_hours('confirmation_overdue'))
      union all
      select v.id, 'confirmation_overdue', v.time_out from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
         and v.time_out <= now() - make_interval(hours => ogevia.attention_rule_hours('confirmation_overdue'))
      union all
      select v.id, 'needs_review', ogevia.visit_review_entered_at(v.id) from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review'
         and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
         and ogevia.visit_recovery_state(v.id) is null
      union all
      select v.id, 'late_response', ogevia.visit_late_response_at(v.id) from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review' and ogevia.visit_recovery_state(v.id) = 'response_to_review'
      union all
      select v.id, 'ready_for_approval', v.signed_at from ogevia.service_visits v
       where v_can_bill and v.organization_id = p_organization_id and v.status in ('signed', 'administrator_review')
         and ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
    )
    select jsonb_build_object(
             'visitsNeedingAttention', count(distinct u.id) filter (where u.kind in ('needs_review', 'late_response', 'confirmation_overdue')),
             'pendingConfirmation', count(distinct u.id) filter (where u.kind = 'pending_confirmation'),
             'confirmationOverdue', count(distinct u.id) filter (where u.kind = 'confirmation_overdue'),
             'awaitingConfirmation', count(distinct u.id) filter (where u.kind in ('pending_confirmation', 'confirmation_overdue')),
             'needsReview', count(distinct u.id) filter (where u.kind = 'needs_review'),
             'reviewOverdue', count(distinct u.id) filter (where u.kind in ('needs_review', 'late_response') and u.at <= now() - make_interval(hours => ogevia.attention_rule_hours('review_overdue'))),
             'lateResponses', count(distinct u.id) filter (where u.kind = 'late_response'),
             'readyForApproval', case when v_can_bill then count(distinct u.id) filter (where u.kind = 'ready_for_approval') end,
             'reviewIssues', coalesce(sum(cardinality(coalesce(ogevia.visit_review_reasons(u.id), array[]::text[]))) filter (where u.kind = 'needs_review'), 0),
             'awaitingResponse', (select count(*) from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'administrator_review'
                                   and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
                                   and ogevia.visit_recovery_state(v.id) = 'awaiting_response'))
      into v_review
    from u;
  end if;

  -- PICKUP REQUESTS (0063): a caregiver asked for an open shift and no one has confirmed it yet. Routine: counted here, never added to the urgent total.
  if ogevia.has_permission(p_organization_id, 'shifts.manage') then
    select jsonb_build_object('count', count(*), 'oldestRequestedAt', min(r.requested_at)) into v_pick
    from ogevia.shift_pickup_requests r join ogevia.shifts sh on sh.id = r.shift_id
    where r.organization_id = p_organization_id and r.status = 'pending' and sh.status = 'scheduled' and sh.ends_at > now();
  end if;

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours, 'pickups', v_pick,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;
drop function ogevia.caregiver_blocked_now(uuid, uuid);
