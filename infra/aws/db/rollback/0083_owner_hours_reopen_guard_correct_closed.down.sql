-- ROLLBACK 0083 | CLASS: SAFE AUTOMATED (functions only; no table, column or stored row changes). Restores the 0082 revoke_visit_review_decision and void_billing_rounding_adjustment (no capacity check) and the 0018
-- correct_service_visit (a visit with an active close-not-billable decision can be corrected again). Decisions and corrections already recorded are untouched.
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

create or replace function ogevia_api.correct_service_visit(
  p_visit_id uuid,
  p_new_time_in timestamptz,
  p_new_time_out timestamptz,
  p_reason text,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_original ogevia.service_visits%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_auth_end ogevia.client_authorizations%rowtype;
  v_fingerprint text := concat_ws('|', p_visit_id, p_new_time_in, p_new_time_out, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_minutes integer;
  v_start_date date;
  v_end_date date;
  v_was_confirmed boolean;
  v_prior_minutes bigint;
  v_allowed integer;
  v_auth_status ogevia.visit_authorization_status;
  v_status ogevia.service_visit_status;
  v_before jsonb;
  v_after jsonb;
  v_corrected_id uuid;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to correct a visit' using errcode = 'OGV22';
  end if;
  if p_new_time_in is null or p_new_time_out is null or p_new_time_out <= p_new_time_in then
    raise exception 'Time out must be after time in' using errcode = 'OGV22';
  end if;
  if p_new_time_out > now() then
    raise exception 'Corrected time out cannot be in the future' using errcode = 'OGV22';
  end if;

  select * into v_original from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_original.id is null or not ogevia.is_active_member(v_original.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_original.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to correct visits for this organization' using errcode = 'OGA03';
  end if;

  -- 0018: a time the manager left unchanged keeps the stored value exactly.
  -- The API and forms carry at most milliseconds; the database keeps
  -- microseconds. Nobody corrects a time by less than a millisecond.
  if date_trunc('milliseconds', p_new_time_in) = date_trunc('milliseconds', v_original.time_in) then
    p_new_time_in := v_original.time_in;
  end if;
  if v_original.time_out is not null
     and date_trunc('milliseconds', p_new_time_out) = date_trunc('milliseconds', v_original.time_out) then
    p_new_time_out := v_original.time_out;
  end if;

  v_prior := ogevia.idempotency_begin('correct_visit', p_idempotency_key, v_original.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'corrected_visit_id')::uuid;
  end if;

  if v_original.status not in ('signed', 'administrator_review') then
    raise exception 'Only a submitted visit can be corrected' using errcode = 'OGC09';
  end if;

  v_minutes := floor(extract(epoch from (p_new_time_out - p_new_time_in)) / 60)::integer;
  if v_minutes < 1 or v_minutes > 1440 then
    raise exception 'Corrected duration must be between 1 minute and 24 hours' using errcode = 'OGV22';
  end if;

  v_start_date := ogevia.organization_local_date(v_original.organization_id, p_new_time_in);
  v_end_date := ogevia.organization_local_date(v_original.organization_id, p_new_time_out);
  -- M-1 fix: CURRENT authorization covering BOTH corrected dates.
  select * into v_auth from ogevia.resolve_current_authorization(
    v_original.organization_id, v_original.client_id, v_original.service_id, v_start_date);
  select * into v_auth_end from ogevia.resolve_current_authorization(
    v_original.organization_id, v_original.client_id, v_original.service_id, v_end_date);
  if v_auth.id is null or v_auth_end.id is distinct from v_auth.id then
    raise exception 'The corrected time is outside an active authorization period' using errcode = 'OGC09';
  end if;
  perform ogevia.lock_authorization_lineage(v_auth.lineage_id);

  if exists (
    select 1 from ogevia.service_visits v
    where v.organization_id = v_original.organization_id
      and v.id <> v_original.id
      and v.status not in ('voided', 'corrected')
      and ((v_original.caregiver_user_id is not null and v.caregiver_user_id = v_original.caregiver_user_id)
           or (v_original.caregiver_record_id is not null and v.caregiver_record_id = v_original.caregiver_record_id))
      and v.time_in < p_new_time_out
      and coalesce(v.time_out, now()) > p_new_time_in
  ) then
    raise exception 'The corrected time overlaps another visit for this caregiver' using errcode = 'OGC09';
  end if;

  -- A correction keeps the ORIGINAL client confirmation. Typed/verbal only
  -- counted as confirmed on legacy (version 1-2) records, as on current main.
  select exists (
    select 1 from ogevia.visit_confirmations vc
    where vc.visit_id in (v_original.id, v_original.original_visit_id)
      and (vc.confirmation_method in ('draw', 'assisted_mark')
           or (vc.confirmation_method in ('typed', 'verbal') and vc.confirmation_version <= 2))
  ) into v_was_confirmed;

  v_prior_minutes := ogevia.authorization_month_usage(v_auth.lineage_id, v_start_date, v_original.id);
  if v_was_confirmed then
    v_allowed := greatest(0, least(v_minutes::bigint, v_auth.monthly_authorized_minutes - v_prior_minutes))::integer;
  else
    v_allowed := 0;
  end if;

  if not v_was_confirmed then
    v_auth_status := case
      when greatest(0, least(v_minutes::bigint, v_auth.monthly_authorized_minutes - v_prior_minutes)) < v_minutes
        then 'exceeds_authorization'
      when v_prior_minutes + v_minutes >= v_auth.monthly_authorized_minutes then 'limit_reached'
      else 'within_authorization'
    end;
    v_status := 'administrator_review';
  elsif v_allowed < v_minutes then
    v_auth_status := 'exceeds_authorization';
    v_status := 'administrator_review';
  else
    v_auth_status := 'administrator_override';
    v_status := 'signed';
  end if;

  v_before := jsonb_build_object(
    'visitId', v_original.id, 'visitNumber', v_original.visit_number_snapshot,
    'timeIn', v_original.time_in, 'timeOut', v_original.time_out,
    'workedMinutes', v_original.worked_minutes, 'verifiedMinutes', v_original.verified_minutes,
    'billableMinutes', v_original.billable_minutes, 'status', v_original.status,
    'authorizationStatus', v_original.authorization_status,
    'authorizationId', v_original.service_authorization_id);
  v_after := jsonb_build_object(
    'timeIn', p_new_time_in, 'timeOut', p_new_time_out, 'workedMinutes', v_minutes,
    'verifiedMinutes', case when v_was_confirmed then v_minutes else 0 end,
    'billableMinutes', v_allowed, 'status', v_status, 'authorizationStatus', v_auth_status,
    'authorizationId', v_auth.id, 'managerCorrected', true,
    'clientConfirmationSourceVisitId',
      case when v_was_confirmed then coalesce(v_original.original_visit_id, v_original.id) end);

  update ogevia.service_visits sv set status = 'corrected' where sv.id = v_original.id;

  insert into ogevia.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id, service_id, service_date,
    time_in, time_out, worked_minutes, verified_minutes, billable_minutes, task_categories,
    service_notes, caregiver_attested_at, status, authorization_status, signed_at, locked_at,
    original_visit_id, correction_reason, created_by, visit_number_snapshot
  ) values (
    v_original.organization_id, v_original.client_id, v_original.client_code_snapshot,
    v_original.caregiver_user_id, v_original.caregiver_record_id, v_original.caregiver_name_snapshot,
    v_original.scheduled_shift_id, v_auth.id, v_original.service_id, v_start_date,
    p_new_time_in, p_new_time_out, v_minutes,
    case when v_was_confirmed then v_minutes else 0 end, v_allowed, v_original.task_categories,
    v_original.service_notes, v_original.caregiver_attested_at, v_status, v_auth_status, now(), now(),
    coalesce(v_original.original_visit_id, v_original.id), btrim(p_reason), v_actor,
    v_original.visit_number_snapshot
  ) returning id into v_corrected_id;

  insert into ogevia.visit_corrections (
    organization_id, original_visit_id, corrected_visit_id, corrected_by, reason,
    before_snapshot, after_snapshot, request_id
  ) values (
    v_original.organization_id, v_original.id, v_corrected_id, v_actor, btrim(p_reason),
    v_before, v_after, ogevia.current_request_id()
  );

  perform ogevia.write_audit(v_original.organization_id, 'service_visit.corrected', 'service_visits',
    v_corrected_id, v_before, v_after, btrim(p_reason));
  perform ogevia.idempotency_finish('correct_visit', p_idempotency_key, v_original.organization_id,
    v_fingerprint, jsonb_build_object('corrected_visit_id', v_corrected_id));
  return v_corrected_id;
end;
$$;
