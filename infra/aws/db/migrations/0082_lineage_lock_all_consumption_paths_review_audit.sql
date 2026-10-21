-- 0082 Authorization-lineage lock on every path that changes consumed minutes; before/after values in the review audit rows (owner go-live readiness directive, 2026-10-19).
--
-- 1. LOCKS (proved by db/test/lineage-lock-race.db.test.ts, a real two-connection test that fails on 0081). The scheduling guards (create_shift, reschedule_shift, the
--    series and make-up evaluators, assign_shift_caregiver, pickup_open_shift, assign_care_request) read authorization_month_usage + authorization_month_reserved (which
--    includes the unreserved Pending time of 0081) AFTER taking ogevia.lock_authorization_lineage, and then write a reservation. confirm_service_visit,
--    correct_service_visit, review_late_visit_confirmation, reconcile_ended_shift, approve_billing_rounding_adjustment and amend_client_authorization already take the
--    same lock. Six other paths changed the minutes those guards read WITHOUT it, so a guard could read around a change that was already written but not yet committed
--    (an unscheduled visit ended, a closed review reopened, a missed visit closed by a manager: 45 minutes of Pending the guard could not see, so a 600-minute shift
--    was promised on top of them: committed 645 of 600). NOW each takes the SAME lock (key 'ogevia.authorization-lineage:' || lineage_id) before it writes:
--      end_service_visit, close_missed_service_visit  - shift row first (the scheduling order: shift, then lineage), then the lineage lock
--      decide_visit_review, revoke_visit_review_decision, void_service_visit - after the visit/decision row lock and their checks, before the write
--      void_billing_rounding_adjustment - after the adjustment row lock
--    (review_late_visit_confirmation already took the lock; 0082 only adds its audit values, below.)
--    through the new helper ogevia.lock_visit_lineage(visit) (the lineage of the authorization version the visit is bound to), as confirm already derives it.
--    Lock order everywhere: visit/decision/adjustment row -> shift row -> lineage (advisory). No function waits for a row AFTER taking the lineage lock except as it
--    already did; the random-interleaving test (40 rounds, both orders, random pauses) saw no deadlock.
--    What the lock can and cannot do: ending a visit, closing a missed visit and reopening a review are NEVER refused for capacity (the work happened; refusing would lose
--    the record), so when such a write is serialised AFTER a scheduling operation that already took the last minutes, the committed total exceeds the authorization and
--    the screens read Over limit (existing 0079 behaviour, per authorization, never offset). The lock closes the other order (the write is seen by the guard).
--    cancel_shift, public_cancel_care_request and the series cancel/change paths only RELEASE reservations; a guard that read a moment before them is merely
--    conservative, so they were left unchanged.
-- 2. AUDIT. visit.review_decided and visit.late_confirmation_reviewed used to carry no previous values and visit.review_revoked no visit or minutes; billing.rounding_adjustment_voided carried the minutes only.
--    Now before_state/after_state of decide_visit_review, revoke_visit_review_decision, review_late_visit_confirmation and void_billing_rounding_adjustment carry the visit, its status, worked and
--    billable minutes and the billability classification before and after. Actor, timestamp (occurred_at), reason and request id were already stored; audit_events
--    rejects UPDATE and DELETE (triggers audit_events_append_only / audit_events_no_delete).
-- No policy change: a review closed as not billable still keeps its reservation (see HOURS_ACCOUNTING.md, policy question). Functions only: no table, column or stored row
-- changes; existing errors, error codes and idempotency keys are unchanged. Rollback restores the 0081 definitions.

create function ogevia.lock_visit_lineage(p_visit_id uuid)
returns void
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_lineage uuid;
begin
  select a.lineage_id into v_lineage
  from ogevia.service_visits v
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where v.id = p_visit_id;
  if v_lineage is not null then
    perform ogevia.lock_authorization_lineage(v_lineage);
  end if;
end;
$$;
revoke all on function ogevia.lock_visit_lineage(uuid) from public;

CREATE OR REPLACE FUNCTION ogevia_api.end_service_visit(p_visit_id uuid, p_task_categories text[] DEFAULT NULL::text[], p_service_notes text DEFAULT NULL::text)
 RETURNS TABLE(visit_id uuid, worked_minutes integer, time_in timestamp with time zone, time_out timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_ended_at timestamptz := now();
  v_minutes integer;
begin
  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if v_visit.caregiver_user_id is distinct from v_actor
     and not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'You cannot end another caregiver''s visit' using errcode = 'OGA03';
  end if;

  if v_visit.status = 'awaiting_signature' and v_visit.time_out is not null then
    return query select v_visit.id, v_visit.worked_minutes, v_visit.time_in, v_visit.time_out;
    return;
  end if;
  if v_visit.status <> 'draft' then
    raise exception 'Visit has already been ended' using errcode = 'OGC09';
  end if;

  v_minutes := floor(extract(epoch from (v_ended_at - v_visit.time_in)) / 60)::integer;
  if v_minutes < 1 then
    raise exception 'A visit must last at least one minute before it can be ended' using errcode = 'OGC09';
  end if;
  if v_minutes > 1440 then
    raise exception 'This visit has been open for over 24 hours - contact a manager to resolve it'
      using errcode = 'OGC09';
  end if;

  -- 0082: ending a visit changes consumed minutes (an unscheduled visit's worked time becomes Pending). Take the shift row first (the order every scheduling path uses:
  -- shift, then lineage), then the SAME authorization-lineage lock the scheduling guards take, so a guard never reads around an end that is already written.
  -- Ending is never refused for capacity: the work has happened.
  if v_visit.scheduled_shift_id is not null then
    perform 1 from ogevia.shifts sh where sh.id = v_visit.scheduled_shift_id and sh.organization_id = v_visit.organization_id for update;
  end if;
  perform ogevia.lock_visit_lineage(v_visit.id);

  update ogevia.service_visits sv
  set time_out = v_ended_at,
      worked_minutes = v_minutes,
      caregiver_attested_at = v_ended_at,
      status = 'awaiting_signature',
      task_categories = coalesce(p_task_categories, sv.task_categories),
      service_notes = coalesce(nullif(btrim(p_service_notes), ''), sv.service_notes)
  where sv.id = v_visit.id;

  -- The linked shift has been delivered. Only a still-scheduled shift moves;
  -- a cancelled or already-completed shift is left as it is.
  if v_visit.scheduled_shift_id is not null then
    update ogevia.shifts sh
    set status = 'completed', updated_at = now()
    where sh.id = v_visit.scheduled_shift_id
      and sh.organization_id = v_visit.organization_id
      and sh.status = 'scheduled';
  end if;

  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.ended', 'service_visits', v_visit.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'awaiting_signature', 'time_out', v_ended_at, 'worked_minutes', v_minutes));
  return query select v_visit.id, v_minutes, v_visit.time_in, v_ended_at;
end;
$function$;

CREATE OR REPLACE FUNCTION ogevia_api.close_missed_service_visit(p_visit_id uuid, p_time_out timestamp with time zone, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(visit_id uuid, worked_minutes integer, time_in timestamp with time zone, time_out timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_fingerprint text := concat_ws('|', p_visit_id, p_time_out, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_minutes integer;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to close a missed visit' using errcode = 'OGV22';
  end if;
  if p_time_out is null or p_time_out > now() then
    raise exception 'The Time Out cannot be in the future' using errcode = 'OGV22';
  end if;

  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'Only a visit manager can close a missed visit' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('close_missed_visit', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return query select (v_prior ->> 'visit_id')::uuid, (v_prior ->> 'worked_minutes')::integer,
      (v_prior ->> 'time_in')::timestamptz, (v_prior ->> 'time_out')::timestamptz;
    return;
  end if;

  if v_visit.status <> 'draft' or v_visit.time_out is not null then
    raise exception 'Only an open visit (no Time Out) can be closed this way' using errcode = 'OGC09';
  end if;
  v_minutes := floor(extract(epoch from (p_time_out - v_visit.time_in)) / 60)::integer;
  if v_minutes < 1 then
    raise exception 'The Time Out must be after the Time In' using errcode = 'OGV22';
  end if;
  if v_minutes > 1440 then
    raise exception 'A visit cannot be longer than 24 hours' using errcode = 'OGV22';
  end if;
  if exists (
    select 1 from ogevia.service_visits o
    where o.organization_id = v_visit.organization_id
      and o.id <> v_visit.id
      and o.status not in ('voided', 'corrected')
      and (
        (v_visit.caregiver_record_id is not null and o.caregiver_record_id = v_visit.caregiver_record_id)
        or (v_visit.caregiver_user_id is not null and o.caregiver_user_id = v_visit.caregiver_user_id)
      )
      and o.time_in < p_time_out
      and coalesce(o.time_out, now()) > v_visit.time_in
  ) then
    raise exception 'The Time Out overlaps another visit for this caregiver' using errcode = 'OGC09';
  end if;

  -- 0082: closing a missed visit changes consumed minutes (an unscheduled visit's worked time becomes Pending). Take the shift row first (the order every scheduling path uses:
  -- shift, then lineage), then the SAME authorization-lineage lock the scheduling guards take, so a guard never reads around a close that is already written.
  -- Closing a missed visit is never refused for capacity: the work has happened.
  if v_visit.scheduled_shift_id is not null then
    perform 1 from ogevia.shifts sh where sh.id = v_visit.scheduled_shift_id and sh.organization_id = v_visit.organization_id for update;
  end if;
  perform ogevia.lock_visit_lineage(v_visit.id);

  update ogevia.service_visits sv
  set time_out = p_time_out,
      worked_minutes = v_minutes,
      status = 'awaiting_signature',
      time_out_entered_by = v_actor,
      time_out_reason = btrim(p_reason)
  where sv.id = v_visit.id;

  if v_visit.scheduled_shift_id is not null then
    update ogevia.shifts sh
    set status = 'completed', updated_at = now()
    where sh.id = v_visit.scheduled_shift_id
      and sh.organization_id = v_visit.organization_id
      and sh.status = 'scheduled';
  end if;

  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.closed_by_manager', 'service_visits', v_visit.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'awaiting_signature', 'time_out', p_time_out, 'worked_minutes', v_minutes,
                       'time_out_entered_by', v_actor, 'scheduled_shift_id', v_visit.scheduled_shift_id),
    btrim(p_reason));
  perform ogevia.idempotency_finish('close_missed_visit', p_idempotency_key, v_visit.organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit.id, 'worked_minutes', v_minutes, 'time_in', v_visit.time_in, 'time_out', p_time_out));
  return query select v_visit.id, v_minutes, v_visit.time_in, p_time_out;
end;
$function$;

CREATE OR REPLACE FUNCTION ogevia_api.void_service_visit(p_visit_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to void a visit' using errcode = 'OGV22';
  end if;
  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'Only an administrator can void a visit' using errcode = 'OGA03';
  end if;
  if v_visit.status not in ('draft', 'awaiting_signature') then
    raise exception 'A signed visit cannot be voided - use a correction instead' using errcode = 'OGC09';
  end if;
  -- 0082: voiding releases Pending minutes; serialised with the scheduling guards by the same lineage lock.
  perform ogevia.lock_visit_lineage(v_visit.id);
  update ogevia.service_visits sv
  set status = 'voided', voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason)
  where sv.id = v_visit.id;
  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.voided', 'service_visits', v_visit.id,
    jsonb_build_object('status', v_visit.status), jsonb_build_object('status', 'voided'), btrim(p_reason));
end;
$function$;

CREATE OR REPLACE FUNCTION ogevia_api.decide_visit_review(p_visit_id uuid, p_decision text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_fingerprint text := concat_ws('|', p_visit_id, p_decision, v_reason);
  v_prior jsonb;
  v_allowed text[];
  v_reasons text[];
  v_method text;
  v_id uuid;
begin
  select * into v_visit from ogevia.service_visits v where v.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to review visits' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('decide_visit_review', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'decision_id')::uuid;
  end if;
  if p_decision is null or p_decision not in ('accept_capped_billable', 'close_not_billable') then
    raise exception 'Choose a review decision' using errcode = 'OGV22';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Give the reason for this review decision' using errcode = 'OGV22';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'The reason is too long (1000 characters at most)' using errcode = 'OGV22';
  end if;
  if v_visit.status <> 'administrator_review' then
    raise exception 'Only a visit that needs review can be reviewed' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v_visit.id and d.revoked_at is null) then
    raise exception 'This visit already has a review decision; revoke it first' using errcode = 'OGC09';
  end if;
  v_allowed := ogevia.visit_review_allowed(v_visit.id);
  if not (p_decision = any (v_allowed)) then
    raise exception 'Billable minutes can be accepted only when the client signed or marked the visit; record the review as not billable, or obtain a signature'
      using errcode = 'OGC09';
  end if;
  v_reasons := coalesce(ogevia.visit_review_reasons(v_visit.id), array[]::text[]);
  select c.confirmation_method into v_method from ogevia.visit_confirmations c where c.visit_id = coalesce(v_visit.original_visit_id, v_visit.id);

  -- 0082: a review decision moves minutes between Pending, the closed-not-billable hold and Billable; serialised with the scheduling guards by the lineage lock.
  perform ogevia.lock_visit_lineage(v_visit.id);

  insert into ogevia.visit_review_decisions (
    organization_id, visit_id, decision, reason, review_reasons, visit_snapshot, decided_by, request_id
  ) values (
    v_visit.organization_id, v_visit.id, p_decision, v_reason, v_reasons,
    jsonb_build_object('status', v_visit.status, 'workedMinutes', v_visit.worked_minutes,
      'verifiedMinutes', v_visit.verified_minutes, 'billableMinutes', v_visit.billable_minutes,
      'authorizationStatus', v_visit.authorization_status, 'confirmationMethod', v_method,
      'timeIn', v_visit.time_in, 'timeOut', v_visit.time_out),
    v_actor, ogevia.current_request_id()
  ) returning id into v_id;

  -- 0082: the audit row carries the PREVIOUS values as well (0031 wrote none): visit state and billability before, and the classification after.
  perform ogevia.write_audit(v_visit.organization_id, 'visit.review_decided', 'visit_review_decisions', v_id,
    jsonb_build_object('visit_id', v_visit.id, 'status', v_visit.status, 'billability', 'in_review', 'worked_minutes', v_visit.worked_minutes,
      'billable_minutes', v_visit.billable_minutes, 'authorization_status', v_visit.authorization_status),
    jsonb_build_object('visit_id', v_visit.id, 'decision', p_decision, 'review_reasons', v_reasons, 'billable_minutes', v_visit.billable_minutes,
      'billability', case p_decision when 'close_not_billable' then 'closed_not_billable' else 'accepted_capped_billable' end,
      'worked_minutes', v_visit.worked_minutes), v_reason);
  perform ogevia.idempotency_finish('decide_visit_review', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, jsonb_build_object('decision_id', v_id));
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION ogevia_api.revoke_visit_review_decision(p_decision_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
declare
  v_actor uuid := ogevia.require_actor();
  v_d ogevia.visit_review_decisions%rowtype;
  v_visit ogevia.service_visits%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_fingerprint text := concat_ws('|', p_decision_id, v_reason);
  v_prior jsonb;
begin
  select * into v_d from ogevia.visit_review_decisions d where d.id = p_decision_id for update;
  if v_d.id is null or not ogevia.is_active_member(v_d.organization_id) then
    raise exception 'Review decision not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_d.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to review visits' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('revoke_visit_review', p_idempotency_key, v_d.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'decision_id')::uuid;
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Give the reason for revoking this decision' using errcode = 'OGV22';
  end if;
  if v_d.revoked_at is not null then
    raise exception 'This decision was already revoked' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.billing_approvals b where b.visit_id = v_d.visit_id and b.voided_at is null) then
    raise exception 'This visit has an active billing approval; void the approval first' using errcode = 'OGC09';
  end if;
  -- 0082: reopening can return Pending minutes; serialised with the scheduling guards by the lineage lock.
  perform ogevia.lock_visit_lineage(v_d.visit_id);
  select * into v_visit from ogevia.service_visits v where v.id = v_d.visit_id;
  update ogevia.visit_review_decisions set revoked_at = now(), revoked_by = v_actor, revoke_reason = v_reason
  where id = v_d.id;
  -- 0082: before/after carry the visit and the classification (0031 recorded only the decision name and revoked = true).
  perform ogevia.write_audit(v_d.organization_id, 'visit.review_revoked', 'visit_review_decisions', v_d.id,
    jsonb_build_object('decision', v_d.decision, 'visit_id', v_d.visit_id, 'status', v_visit.status, 'worked_minutes', v_visit.worked_minutes,
      'billable_minutes', v_visit.billable_minutes, 'accepted_minutes', v_d.accepted_minutes,
      'billability', case v_d.decision when 'close_not_billable' then 'closed_not_billable' when 'accept_late_confirmation' then 'late_confirmation_accepted' else 'accepted_capped_billable' end),
    jsonb_build_object('revoked', true, 'visit_id', v_d.visit_id, 'status', v_visit.status, 'billability', 'in_review'), v_reason);
  perform ogevia.idempotency_finish('revoke_visit_review', p_idempotency_key, v_d.organization_id,
    v_fingerprint, jsonb_build_object('decision_id', v_d.id));
  return v_d.id;
end;
$function$;

CREATE OR REPLACE FUNCTION ogevia_api.void_billing_rounding_adjustment(p_adjustment_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
declare
  v_actor uuid := ogevia.require_actor();
  v_row ogevia.billing_rounding_adjustments%rowtype;
  v_fp text := concat_ws('|', p_adjustment_id, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to void a rounding adjustment' using errcode = 'OGV22';
  end if;
  select * into v_row from ogevia.billing_rounding_adjustments r where r.id = p_adjustment_id for update;
  if v_row.id is null or not ogevia.is_active_member(v_row.organization_id) then
    raise exception 'Rounding adjustment not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_row.organization_id, 'billing.approve') then
    raise exception 'You do not have permission to void billing approvals for this organization' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('void_rounding_adjustment', p_idempotency_key, v_row.organization_id, v_fp);
  if v_prior is not null then
    return (v_prior ->> 'adjustment_id')::uuid;
  end if;
  if v_row.voided_at is not null then
    raise exception 'This rounding adjustment is already voided' using errcode = 'OGC09';
  end if;
  -- 0082: voiding a rounding adjustment returns its minutes to Hours left; serialised with the scheduling guards by the lineage lock.
  perform ogevia.lock_authorization_lineage(v_row.authorization_lineage_id);
  update ogevia.billing_rounding_adjustments set voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason) where id = v_row.id;
  perform ogevia.write_audit(v_row.organization_id, 'billing.rounding_adjustment_voided', 'billing_rounding_adjustments', v_row.id,
    jsonb_build_object('adjustment_minutes', v_row.adjustment_minutes, 'proposed_minutes', v_row.proposed_minutes, 'base_minutes', v_row.base_minutes,
                       'service_date', v_row.service_date, 'authorization_lineage_id', v_row.authorization_lineage_id, 'voided', false),
    jsonb_build_object('voided', true, 'adjustment_minutes', 0), btrim(p_reason));
  perform ogevia.idempotency_finish('void_rounding_adjustment', p_idempotency_key, v_row.organization_id, v_fp,
    jsonb_build_object('adjustment_id', v_row.id));
  return v_row.id;
end;
$function$;

CREATE OR REPLACE FUNCTION ogevia_api.review_late_visit_confirmation(p_late_confirmation_id uuid, p_outcome text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(review_id uuid, decision_id uuid, accepted_minutes integer, capped_by_authorization boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $function$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_lc ogevia.visit_late_confirmations%rowtype;
  v_visit ogevia.service_visits%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_fp text := concat_ws('|', p_late_confirmation_id, p_outcome, v_reason);
  v_prior jsonb;
  v_room bigint;
  v_minutes integer;
  v_capped boolean;
  v_review uuid;
  v_decision uuid;
begin
  select * into v_lc from ogevia.visit_late_confirmations lc where lc.id = p_late_confirmation_id;
  if v_lc.id is null or not ogevia.is_active_member(v_lc.organization_id) then
    raise exception 'Response not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_lc.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to review visits' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('review_late_confirmation', p_idempotency_key, v_lc.organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'review_id')::uuid, (v_prior ->> 'decision_id')::uuid,
      (v_prior ->> 'accepted_minutes')::integer, (v_prior ->> 'capped')::boolean;
    return;
  end if;
  if p_outcome is null or p_outcome not in ('accepted', 'rejected') then
    raise exception 'Choose accept or reject' using errcode = 'OGV22';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 1000 then
    raise exception 'Give the reason for this decision' using errcode = 'OGV22';
  end if;
  select * into v_visit from ogevia.service_visits v where v.id = v_lc.visit_id for update;
  if exists (select 1 from ogevia.visit_late_confirmation_reviews rv where rv.late_confirmation_id = v_lc.id) then
    raise exception 'This response was already reviewed' using errcode = 'OGC09';
  end if;
  if p_outcome = 'accepted' then
    if v_lc.outcome <> 'confirmed' then
      raise exception 'A reported problem cannot be accepted as a confirmation; record it as reviewed, then correct or close the visit' using errcode = 'OGC09';
    end if;
    if not ogevia.visit_matches_snapshot(v_visit.id, v_lc.confirmed_visit_snapshot) then
      raise exception 'The visit changed after this confirmation was given; it no longer confirms the visit as it is now. Reject it and request a new confirmation' using errcode = 'OGC09';
    end if;
    if exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v_visit.id and d.revoked_at is null) then
      raise exception 'This visit already has a review decision; revoke it first' using errcode = 'OGC09';
    end if;
    select a.* into v_auth from ogevia.client_authorizations a where a.id = v_visit.service_authorization_id;
    perform ogevia.lock_authorization_lineage(v_auth.lineage_id);
    select a.* into v_auth from ogevia.client_authorizations a
    where a.lineage_id = v_auth.lineage_id and a.is_current and a.deleted_at is null
      and v_visit.service_date between a.period_start and a.period_end;
    v_room := coalesce(v_auth.monthly_authorized_minutes, 0) - ogevia.authorization_month_usage(v_auth.lineage_id, v_visit.service_date, v_visit.id);
    v_minutes := greatest(0, least(v_visit.worked_minutes::bigint, v_room))::integer;
    v_capped := v_minutes < v_visit.worked_minutes;
    if v_minutes = 0 then
      raise exception 'No authorized time remains this month for this service, so nothing could become billable. Reject the response or close the visit not billable, or record an authorization amendment first' using errcode = 'OGC09';
    end if;
  end if;

  insert into ogevia.visit_late_confirmation_reviews (organization_id, late_confirmation_id, visit_id, outcome, reason,
    accepted_minutes, capped_by_authorization, decided_by, request_id)
  values (v_lc.organization_id, v_lc.id, v_visit.id, p_outcome, v_reason,
    case when p_outcome = 'accepted' then v_minutes end, case when p_outcome = 'accepted' then v_capped end,
    v_actor, ogevia.current_request_id())
  returning id into v_review;

  if p_outcome = 'accepted' then
    insert into ogevia.visit_review_decisions (organization_id, visit_id, decision, reason, review_reasons, visit_snapshot,
      decided_by, request_id, late_confirmation_review_id, accepted_minutes)
    values (v_visit.organization_id, v_visit.id, 'accept_late_confirmation', v_reason,
      coalesce(ogevia.visit_review_reasons(v_visit.id), array[]::text[]),
      jsonb_build_object('status', v_visit.status, 'workedMinutes', v_visit.worked_minutes, 'billableMinutes', v_visit.billable_minutes,
        'authorizationStatus', v_visit.authorization_status, 'timeIn', v_visit.time_in, 'timeOut', v_visit.time_out,
        'lateConfirmationId', v_lc.id, 'lateMethod', v_lc.method, 'acceptedMinutes', v_minutes, 'capped', v_capped),
      v_actor, ogevia.current_request_id(), v_review, v_minutes)
    returning id into v_decision;
  end if;

  -- 0082: the previous values (0036 wrote none) and the classification before and after.
  perform ogevia.write_audit(v_lc.organization_id, 'visit.late_confirmation_reviewed', 'visit_late_confirmation_reviews', v_review,
    jsonb_build_object('visit_id', v_visit.id, 'status', v_visit.status, 'billability', 'in_review', 'worked_minutes', v_visit.worked_minutes,
      'billable_minutes', v_visit.billable_minutes),
    jsonb_build_object('visit_id', v_visit.id, 'late_confirmation_id', v_lc.id, 'outcome', p_outcome,
      'accepted_minutes', v_minutes, 'capped', v_capped, 'decision_id', v_decision,
      'billability', case when p_outcome = 'accepted' then 'late_confirmation_accepted' else 'in_review' end), v_reason);
  perform ogevia.idempotency_finish('review_late_confirmation', p_idempotency_key, v_lc.organization_id, v_fp,
    jsonb_build_object('review_id', v_review, 'decision_id', v_decision, 'accepted_minutes', v_minutes, 'capped', v_capped));
  return query select v_review, v_decision, v_minutes, v_capped;
end;
$function$;
