-- ROLLBACK 0071 | CLASS: BACKUP REQUIRED (the authorization review history is dropped). Restores the 0050, 0062, 0067 and 0068 definitions and constraints.
-- Impact rows of the new visit kinds are re-labelled decrease_now_exceeds (the distinction is lost; no row is deleted). Visits that were returned to review lose that state; rows in shift_reconciliations with the delivered_unverified outcome are re-labelled hold_service_may_have_occurred
-- (the stricter meaning is lost), because the earlier constraint does not know the third outcome.
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
  v_recon jsonb := null;
  v_imp jsonb := null;
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
      -- a visit in progress for a caregiver who is on a compliance hold (or blocked right now, before the sweep has opened the hold): the office must arrange safe coverage. The visit is never ended or reassigned by the system.
      select 'visit', v.id, v.time_in, null::timestamptz, 'in_progress_on_hold', 'critical', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      join ogevia.caregiver_records cr on cr.organization_id = v.organization_id
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id))
      where (v_can_comp or v_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
        and ogevia.caregiver_blocked_now(v.organization_id, cr.id)
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

  -- RECONCILIATION (0067): shifts that ended with no visit record and still hold a reservation. Nothing is released automatically; a person decides.
  if ogevia.has_permission(p_organization_id, 'shifts.manage') then
    select jsonb_build_object('count', count(*), 'minutes', coalesce(sum(r.reserved_minutes), 0), 'oldestEndedAt', min(sh.ends_at)) into v_recon
    from ogevia.authorization_reservations r join ogevia.shifts sh on sh.id = r.shift_id
    where r.organization_id = p_organization_id and r.released_at is null and ogevia.reservation_bucket(r.id) in ('unreconciled', 'awaiting_record');
  end if;

  -- AUTHORIZATION AMENDMENT IMPACTS (0068): reserved shifts and visits an amendment affected, not yet acknowledged and still applicable.
  if ogevia.has_permission(p_organization_id, 'authorizations.update') or ogevia.has_permission(p_organization_id, 'shifts.manage') then
    select jsonb_build_object('count', count(*), 'oldestAt', min(i.created_at)) into v_imp
    from ogevia.authorization_amendment_impacts i
    where i.organization_id = p_organization_id
      and not exists (select 1 from ogevia.authorization_amendment_impact_acks k where k.impact_id = i.id)
      and case when i.shift_id is not null then ogevia.reservation_bucket(i.reservation_id) is not null
               else exists (select 1 from ogevia.service_visits v where v.id = i.visit_id and v.status in ('signed', 'administrator_review')) end;
  end if;

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours, 'pickups', v_pick, 'reconciliation', v_recon, 'amendmentImpacts', v_imp,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;
drop function ogevia_api.list_authorization_amendment_impacts(uuid, boolean);
create function ogevia_api.list_authorization_amendment_impacts(p_organization_id uuid, p_include_acknowledged boolean default false)
returns table (
  impact_id uuid, created_at timestamptz, impact_kind text, client_code text, service_code text, service_name text, new_version_number integer, new_monthly_minutes integer,
  shift_id uuid, shift_starts_at timestamptz, shift_ends_at timestamptz, visit_id uuid, service_date date, minutes integer, bucket text, still_applicable boolean,
  acknowledged_at timestamptz, acknowledged_by_name text, acknowledgement_note text, amended_by_name text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'authorizations.update') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'You do not have permission to see authorization amendment impacts' using errcode = 'OGA03';
  end if;
  return query
  select i.id, i.created_at, i.impact_kind, c.client_code, sv.code, sv.name, na.version_number, na.monthly_authorized_minutes,
         i.shift_id, sh.starts_at, sh.ends_at, i.visit_id, i.service_date, i.minutes,
         (select ogevia.reservation_bucket(i.reservation_id)) as bucket,
         case when i.shift_id is not null then coalesce(ogevia.reservation_bucket(i.reservation_id), '') <> ''
              else exists (select 1 from ogevia.service_visits v where v.id = i.visit_id and v.status in ('signed', 'administrator_review')) end,
         k.acknowledged_at, ku.display_name, k.note, cu.display_name
  from ogevia.authorization_amendment_impacts i
  join ogevia.client_authorizations na on na.id = i.to_authorization_id
  join ogevia.clients c on c.id = na.client_id
  join ogevia.services sv on sv.id = na.service_id
  left join ogevia.shifts sh on sh.id = i.shift_id
  left join ogevia.authorization_amendment_impact_acks k on k.impact_id = i.id
  left join ogevia.app_users ku on ku.id = k.acknowledged_by
  left join ogevia.app_users cu on cu.id = i.created_by
  where i.organization_id = p_organization_id and (p_include_acknowledged or k.impact_id is null)
  order by i.created_at desc, i.service_date, i.id;
end;
$$;
revoke all on function ogevia_api.list_authorization_amendment_impacts(uuid, boolean) from public;
grant execute on function ogevia_api.list_authorization_amendment_impacts(uuid, boolean) to ogevia_app;
create or replace function ogevia.record_amendment_impacts(p_old ogevia.client_authorizations, p_new_id uuid, p_actor uuid)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_new ogevia.client_authorizations%rowtype;
  v_up boolean;
begin
  select * into v_new from ogevia.client_authorizations a where a.id = p_new_id;
  v_up := v_new.monthly_authorized_minutes > p_old.monthly_authorized_minutes;
  insert into ogevia.authorization_amendment_impacts (organization_id, lineage_id, from_authorization_id, to_authorization_id, impact_kind, visit_id, service_date, minutes, detail, created_by)
  select p_old.organization_id, p_old.lineage_id, p_old.id, p_new_id,
         case when v_up then 'increase_may_allow_more' else 'decrease_now_exceeds' end, v.id, v.service_date, v.billable_minutes,
         jsonb_build_object('visit_status', v.status, 'worked_minutes', v.worked_minutes), p_actor
  from ogevia.service_visits v
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where a.lineage_id = p_old.lineage_id and v.status not in ('voided', 'corrected')
    and ((v_up and v.authorization_status in ('exceeds_authorization', 'limit_reached')) or (not v_up and v.status in ('signed', 'administrator_review')));

  if v_new.monthly_authorized_minutes < p_old.monthly_authorized_minutes or v_new.period_start > p_old.period_start or v_new.period_end < p_old.period_end then
    insert into ogevia.authorization_amendment_impacts (organization_id, lineage_id, from_authorization_id, to_authorization_id, impact_kind, shift_id, reservation_id, service_date, minutes, detail, created_by)
    select p_old.organization_id, p_old.lineage_id, p_old.id, p_new_id,
           case when x.outside then 'reserved_shift_outside_period' else 'reserved_shift_over_cap' end,
           x.shift_id, x.reservation_id, x.service_date, x.reserved_minutes,
           jsonb_build_object('bucket', x.bucket, 'new_monthly_minutes', v_new.monthly_authorized_minutes, 'used_minutes', x.used, 'cumulative_reserved_minutes', x.cum,
                              'new_period_start', v_new.period_start, 'new_period_end', v_new.period_end), p_actor
    from (
      select y.*, sum(case when y.outside then 0 else y.reserved_minutes end) over (partition by y.m order by y.starts_at, y.reservation_id) as cum
      from (
        select r.id as reservation_id, r.shift_id, r.service_date, r.reserved_minutes, s.starts_at, ogevia.reservation_bucket(r.id) as bucket,
               date_trunc('month', r.service_date::timestamp)::date as m,
               (r.service_date < v_new.period_start or r.service_date > v_new.period_end) as outside,
               ogevia.authorization_month_usage(p_old.lineage_id, r.service_date) as used
        from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id
        where r.authorization_lineage_id = p_old.lineage_id and r.released_at is null and not ogevia.reservation_counted_as_used(r.shift_id)
      ) y
    ) x
    where x.outside or x.cum > v_new.monthly_authorized_minutes - x.used;
  end if;
end;
$$;
create or replace function ogevia_api.reconcile_ended_shift(p_organization_id uuid, p_shift_id uuid, p_outcome text, p_note text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_note text := btrim(coalesce(p_note, ''));
  v_fp text := concat_ws('|', p_shift_id, p_outcome, v_note);
  v_prior jsonb;
  v_shift ogevia.shifts%rowtype;
  v_res ogevia.authorization_reservations%rowtype;
  v_bucket text;
  v_id uuid;
  v_result jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'shifts.manage') then raise exception 'You do not have permission to reconcile shifts' using errcode = 'OGA03'; end if;
  if p_outcome is null or p_outcome not in ('no_service_delivered', 'hold_service_may_have_occurred') then raise exception 'Choose an outcome' using errcode = 'OGV22'; end if;
  if length(v_note) < 10 then raise exception 'Enter a note of at least 10 characters saying what you checked' using errcode = 'OGV22'; end if;
  v_prior := ogevia.idempotency_begin('reconcile_ended_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;

  -- lock order (shared with pickup confirmation and office assignment): shift, then the reservation row, then the authorization lineage
  select * into v_shift from ogevia.shifts s where s.id = p_shift_id and s.organization_id = p_organization_id for update;
  if v_shift.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  select * into v_res from ogevia.authorization_reservations r where r.shift_id = p_shift_id and r.organization_id = p_organization_id for update;
  if v_res.id is null or v_res.released_at is not null then
    raise exception 'This shift has no open reservation to reconcile (already released or reconciled).' using errcode = 'OGC09';
  end if;
  perform ogevia.lock_authorization_lineage(v_res.authorization_lineage_id);
  v_bucket := ogevia.reservation_bucket(v_res.id);
  if v_bucket is null or v_bucket not in ('unreconciled', 'awaiting_record') then
    raise exception 'Only a shift that has ended with no visit record can be reconciled here. A visit exists or the shift has not ended.' using errcode = 'OGC09';
  end if;
  if p_outcome = 'hold_service_may_have_occurred' and v_bucket = 'awaiting_record' and
     (select d.outcome from ogevia.shift_reconciliations d where d.shift_id = p_shift_id order by d.decided_at desc, d.id desc limit 1) = p_outcome then
    raise exception 'This shift is already marked as awaiting a record.' using errcode = 'OGC09';
  end if;

  insert into ogevia.shift_reconciliations (organization_id, shift_id, reservation_id, outcome, note, reserved_minutes, decided_by)
  values (p_organization_id, p_shift_id, v_res.id, p_outcome, v_note, v_res.reserved_minutes, v_actor) returning id into v_id;
  if p_outcome = 'no_service_delivered' then
    update ogevia.authorization_reservations r set released_at = now(), release_reason = 'reconciled_no_service' where r.id = v_res.id;
    perform ogevia.write_audit(p_organization_id, 'authorization_reservation.reconciled_released', 'authorization_reservations', v_res.id,
      jsonb_build_object('released_at', null, 'bucket', v_bucket),
      jsonb_build_object('release_reason', 'reconciled_no_service', 'shift_id', p_shift_id, 'reserved_minutes', v_res.reserved_minutes, 'reconciliation_id', v_id), v_note);
  else
    perform ogevia.write_audit(p_organization_id, 'authorization_reservation.reconciliation_held', 'authorization_reservations', v_res.id,
      jsonb_build_object('bucket', v_bucket),
      jsonb_build_object('shift_id', p_shift_id, 'reserved_minutes', v_res.reserved_minutes, 'reconciliation_id', v_id, 'outcome', p_outcome), v_note);
  end if;
  v_result := jsonb_build_object('reconciliationId', v_id, 'outcome', p_outcome, 'reservedMinutes', v_res.reserved_minutes, 'released', p_outcome = 'no_service_delivered');
  perform ogevia.idempotency_finish('reconcile_ended_shift', p_idempotency_key, p_organization_id, v_fp, v_result);
  return v_result;
end;
$$;
create or replace function ogevia.reservation_bucket(p_reservation_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when r.released_at is not null then null
    when ogevia.reservation_counted_as_used(r.shift_id) then null
    when v.id is not null then case when v.status = 'draft' then 'underway' else 'held_review' end
    when s.status = 'scheduled' and s.starts_at > now() then 'ahead'
    when s.status = 'scheduled' and s.ends_at >= now() then 'underway'
    when (select d.outcome from ogevia.shift_reconciliations d where d.shift_id = r.shift_id order by d.decided_at desc, d.id desc limit 1) = 'hold_service_may_have_occurred' then 'awaiting_record'
    else 'unreconciled'
  end
  from ogevia.authorization_reservations r
  join ogevia.shifts s on s.id = r.shift_id
  left join lateral (
    select x.id, x.status from ogevia.service_visits x
    where x.scheduled_shift_id = r.shift_id and x.status not in ('voided', 'corrected') order by x.created_at desc limit 1
  ) v on true
  where r.id = p_reservation_id;
$$;
create or replace function ogevia_api.approve_visit_for_billing(
  p_visit_id uuid,
  p_approved_minutes integer,
  p_notes text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_rate integer;
  v_amount integer;
  v_fingerprint text := concat_ws('|', p_visit_id, p_approved_minutes, btrim(coalesce(p_notes, '')));
  v_prior jsonb;
  v_id uuid;
  v_after jsonb;
  v_review_accepted boolean;
  v_limit integer;
  v_late_minutes integer;
begin
  select * into v_visit from ogevia.service_visits v where v.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'billing.approve') then
    raise exception 'You do not have permission to approve billing for this organization' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('approve_billing', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'billing_approval_id')::uuid;
  end if;

  v_review_accepted := v_visit.status = 'administrator_review' and exists (
    select 1 from ogevia.visit_review_decisions d
    where d.visit_id = v_visit.id and d.revoked_at is null and d.decision in ('accept_capped_billable', 'accept_late_confirmation'));
  -- 0036: a late confirmation accepted in review is eligible up to its accepted minutes.
  select d.accepted_minutes into v_late_minutes from ogevia.visit_review_decisions d
  where d.visit_id = v_visit.id and d.revoked_at is null and d.decision = 'accept_late_confirmation';
  v_limit := coalesce(v_late_minutes, v_visit.billable_minutes);
  if v_visit.status <> 'signed' and not v_review_accepted then
    raise exception 'Only a visit that is Ready for Review can be approved for billing; a visit that Needs Correction must be resolved first'
      using errcode = 'OGC09';
  end if;
  if p_approved_minutes is null or p_approved_minutes < 0 or p_approved_minutes > v_limit then
    raise exception 'Approved minutes must be between 0 and the billable minutes (%)', v_limit
      using errcode = 'OGV22';
  end if;
  if exists (select 1 from ogevia.billing_approvals b where b.visit_id = v_visit.id and b.voided_at is null) then
    raise exception 'This visit already has an active billing approval' using errcode = 'OGC09';
  end if;

  select a.hourly_rate_cents into v_rate from ogevia.client_authorizations a where a.id = v_visit.service_authorization_id;
  if v_rate is not null then
    v_amount := round(p_approved_minutes / 60.0 * v_rate)::integer;
  end if;

  insert into ogevia.billing_approvals (
    organization_id, visit_id, approved_by, approved_minutes, billable_minutes_at_approval,
    notes, rate_cents, amount_cents, source_snapshot
  ) values (
    v_visit.organization_id, v_visit.id, v_actor, p_approved_minutes, v_limit,
    nullif(btrim(coalesce(p_notes, '')), ''), v_rate, v_amount,
    jsonb_build_object(
      'visitId', v_visit.id, 'visitNumber', v_visit.visit_number_snapshot,
      'clientId', v_visit.client_id, 'clientCode', v_visit.client_code_snapshot,
      'serviceId', v_visit.service_id, 'serviceDate', v_visit.service_date,
      'timeIn', v_visit.time_in, 'timeOut', v_visit.time_out,
      'workedMinutes', v_visit.worked_minutes, 'billableMinutes', v_visit.billable_minutes,
      'serviceAuthorizationId', v_visit.service_authorization_id,
      'reviewAccepted', v_review_accepted, 'lateAcceptedMinutes', v_late_minutes)
  ) returning id into v_id;

  -- The audit row carries minutes only; dollar values stay in the owner-only columns.
  v_after := jsonb_build_object('billing_approval_id', v_id, 'visit_id', v_visit.id,
    'approved_minutes', p_approved_minutes, 'billable_minutes', v_limit);
  perform ogevia.write_audit(v_visit.organization_id, 'billing.approved', 'billing_approvals', v_id,
    null, v_after, nullif(btrim(coalesce(p_notes, '')), ''));
  perform ogevia.idempotency_finish('approve_billing', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, jsonb_build_object('billing_approval_id', v_id));
  return v_id;
end;
$$;
create or replace function ogevia.visit_review_reasons(p_visit_id uuid)
returns text[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select array_remove(array[
    case when coalesce(c.confirmation_method, '') not in ('draw', 'assisted_mark') then 'no_client_signature' end,
    case when v.authorization_status = 'exceeds_authorization'
           or (v.billable_minutes < v.worked_minutes and c.confirmation_method in ('draw', 'assisted_mark'))
         then 'over_authorization' end,
    case when v.scheduled_shift_id is null then 'unscheduled' end,
    case when e.outcome = 'over' then 'schedule_variance' end
  ], null)
  from ogevia.service_visits v
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.visit_rule_evaluations e on e.visit_id = v.id and e.rule_key = 'schedule_variance_minutes'
  where v.id = p_visit_id and v.status = 'administrator_review';
$$;
create or replace function ogevia.visit_billing_state(p_visit_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when exists (select 1 from ogevia.billing_approvals b where b.visit_id = v.id and b.voided_at is null) then 'approved_for_billing'
    when v.status not in ('signed', 'administrator_review') then null
    when d.decision = 'close_not_billable' then 'reviewed_not_billable'
    when v.status = 'signed' or d.decision in ('accept_capped_billable', 'accept_late_confirmation') then
      case when exists (select 1 from ogevia.billing_approvals b where b.visit_id = v.id and b.voided_at is not null) then 'voided' else 'ready_for_review' end
    when ogevia.visit_recovery_state(v.id) = 'awaiting_response' then 'waiting_for_signature'
    when ogevia.visit_recovery_state(v.id) = 'response_to_review' then 'late_response_to_review'
    else 'needs_correction'
  end
  from ogevia.service_visits v
  left join ogevia.visit_review_decisions d on d.visit_id = v.id and d.revoked_at is null
  where v.id = p_visit_id;
$$;
drop function ogevia_api.get_visit_authorization_review(uuid);
drop function ogevia_api.resolve_visit_authorization_review(uuid, text, uuid);
drop table ogevia.visit_authorization_reviews;
drop function ogevia.visit_authorization_reviews_guard();
alter table ogevia.shift_reconciliations disable trigger shift_reconciliations_no_update;
update ogevia.shift_reconciliations set outcome = 'hold_service_may_have_occurred' where outcome = 'delivered_unverified';
alter table ogevia.shift_reconciliations enable trigger shift_reconciliations_no_update;
alter table ogevia.shift_reconciliations drop constraint shift_reconciliations_outcome_check;
alter table ogevia.shift_reconciliations add constraint shift_reconciliations_outcome_check check (outcome in ('no_service_delivered', 'hold_service_may_have_occurred'));
alter table ogevia.authorization_amendment_impacts disable trigger authorization_amendment_impacts_no_update;
update ogevia.authorization_amendment_impacts set impact_kind = 'decrease_now_exceeds' where impact_kind in ('visit_over_cap', 'visit_outside_period');
alter table ogevia.authorization_amendment_impacts enable trigger authorization_amendment_impacts_no_update;
alter table ogevia.authorization_amendment_impacts drop constraint authorization_amendment_impacts_impact_kind_check;
alter table ogevia.authorization_amendment_impacts add constraint authorization_amendment_impacts_impact_kind_check
  check (impact_kind in ('reserved_shift_over_cap', 'reserved_shift_outside_period', 'decrease_now_exceeds', 'increase_may_allow_more'));
