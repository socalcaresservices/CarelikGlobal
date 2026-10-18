-- 0062 Billing states, decided on the server (owner directive 2026-10-17, requirement 8).
--
-- THE STATES (one function, ogevia.visit_billing_state, derived from three facts that already exist: the visit status, the active review decision and the
-- billing approval rows; no new column, nothing back-filled, nothing a screen can disagree about):
--   needs_correction        administrator_review with no decision and nothing in progress with the client: the office must correct or resolve it
--   waiting_for_signature   administrator_review while a confirmation request to the client is open            (kept from 0036)
--   late_response_to_review administrator_review with a late client response not yet reviewed                    (kept from 0036)
--   ready_for_review        signed, or administrator_review with an accepted decision; nobody has approved it yet
--   approved_for_billing    an ACTIVE billing approval exists (a person approved it)
--   voided                  it had an approval and the approval was voided; it is not approved now and can be approved again
--   reviewed_not_billable   the review was closed as not billable                                               (kept, unchanged)
-- APPROVAL IS NOT SUBMISSION OR PAYMENT: nothing here sends, invoices or marks anything billed. 'Already Billed' stays deferred: there is no such state,
-- column or label, and no code path can set one.
--
-- WHAT USES IT: the billing review list (adds billing_state, the active approval id and the last void: when, why and by whom), get_visit_review (billing_state,
-- only for someone who may see billing), and the two 'Ready for Approval' counts (Home overview and the action list), which now count the same visits as the
-- 'Ready for Review' state: signed or accepted-in-review, not yet approved, including a voided one that needs a person again. (Before, an accepted-in-review
-- visit was approvable but not counted, and the browser re-derived the state.) The approval error message now uses the new names.
-- Rollback restores the 0036/0059 definitions and removes the function.

create function ogevia.visit_billing_state(p_visit_id uuid)
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
revoke all on function ogevia.visit_billing_state(uuid) from public;

drop function ogevia_api.list_billing_review_visits(uuid, date, date);
drop function ogevia_api.get_visit_review(uuid);
create function ogevia_api.list_billing_review_visits(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  visit_id uuid,
  visit_number text,
  client_id uuid,
  service_id uuid,
  service_code text,
  authorization_id uuid,
  authorization_lineage_id uuid,
  authorization_version integer,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  visit_status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  has_administrator_override boolean,
  confirmation_method text,
  has_signature_evidence boolean,
  is_correction boolean,
  original_visit_id uuid,
  review_state text,
  latest_audit_event_id bigint,
  client_code text,
  client_name text,
  caregiver_name text,
  service_name text,
  caregiver_scheduling_mode text,
  scheduled_shift_id uuid,
  review_reasons text[],
  review_decision text,
  review_decided_at timestamptz,
  eligible_minutes integer,
  billing_state text,
  active_approval_id uuid,
  last_void_at timestamptz,
  last_void_reason text,
  last_voided_by_name text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.visit_number_snapshot, v.client_id, v.service_id, sv.code,
    a.id, a.lineage_id, a.version_number,
    v.service_date, v.time_in, v.time_out, v.worked_minutes, v.verified_minutes, v.billable_minutes,
    v.status, v.authorization_status,
    v.authorization_status = 'administrator_override',
    root_conf.confirmation_method,
    root_conf.evidence_id is not null,
    v.original_visit_id is not null,
    v.original_visit_id,
    case
      when v.status = 'signed' then 'ready'
      when d.decision in ('accept_capped_billable', 'accept_late_confirmation') then 'reviewed_eligible'
      when d.decision = 'close_not_billable' then 'reviewed_not_billable'
      when ogevia.visit_recovery_state(v.id) = 'awaiting_response' then 'awaiting_signature'
      when ogevia.visit_recovery_state(v.id) = 'response_to_review' then 'late_response_to_review'
      else 'needs_review'
    end,
    (select max(ae.id) from ogevia.audit_events ae where ae.entity_id = v.id),
    v.client_code_snapshot,
    -- Legal names only for clients.names.read (Administrator, manager); null otherwise.
    case when ogevia.has_permission(p_organization_id, 'clients.names.read')
         then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
    v.caregiver_name_snapshot,
    sv.name,
    (select cr.scheduling_mode from ogevia.caregiver_records cr where cr.organization_id = v.organization_id and cr.deleted_at is null
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id)) limit 1),
    v.scheduled_shift_id,
    coalesce(ogevia.visit_review_reasons(v.id), array[]::text[]),
    d.decision,
    d.decided_at,
    case when v.status = 'signed' then v.billable_minutes
         when d.decision = 'accept_capped_billable' then v.billable_minutes
         when d.decision = 'accept_late_confirmation' then d.accepted_minutes
         else 0 end,
    ogevia.visit_billing_state(v.id),
    ab.id, lv.voided_at, lv.void_reason, lv.display_name
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  left join ogevia.visit_confirmations root_conf
    on root_conf.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.client_private_names n on n.client_id = v.client_id
  left join ogevia.visit_review_decisions d on d.visit_id = v.id and d.revoked_at is null
  left join ogevia.billing_approvals ab on ab.visit_id = v.id and ab.voided_at is null
  left join lateral (
    select b.voided_at, b.void_reason, u.display_name
    from ogevia.billing_approvals b left join ogevia.app_users u on u.id = b.voided_by
    where b.visit_id = v.id and b.voided_at is not null
    order by b.voided_at desc limit 1
  ) lv on true
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.has_permission(p_organization_id, 'billing.visits.read')
    and v.status in ('signed', 'administrator_review')
    and v.service_date between p_date_from and p_date_to
  order by v.service_date, v.time_in;
$$;
create function ogevia_api.get_visit_review(p_visit_id uuid)
returns table (
  visit_id uuid,
  organization_id uuid,
  visit_number text,
  visit_status ogevia.service_visit_status,
  client_id uuid,
  client_code text,
  client_name text,
  caregiver_name text,
  service_code text,
  service_name text,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  authorization_status ogevia.visit_authorization_status,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  caregiver_scheduling_mode text,
  confirmation_method text,
  signer_role text,
  signer_name text,
  signer_relationship text,
  confirmation_reason text,
  confirmed_at timestamptz,
  has_signature_evidence boolean,
  is_correction boolean,
  original_visit_id uuid,
  review_reasons text[],
  decision_id uuid,
  decision text,
  decision_reason text,
  decided_by_name text,
  decided_at timestamptz,
  active_billing_approval_id uuid,
  approved_minutes integer,
  can_decide boolean,
  allowed_decisions text[],
  recovery_state text,
  can_request_confirmation boolean,
  decision_accepted_minutes integer,
  billing_state text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.organization_id, v.visit_number_snapshot, v.status, v.client_id, v.client_code_snapshot,
    case when ogevia.has_permission(v.organization_id, 'clients.names.read')
         then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
    v.caregiver_name_snapshot, sv.code, sv.name, v.service_date, v.time_in, v.time_out,
    v.worked_minutes, v.verified_minutes, v.billable_minutes, v.authorization_status,
    sh.starts_at, sh.ends_at,
    (select cr.scheduling_mode from ogevia.caregiver_records cr where cr.organization_id = v.organization_id and cr.deleted_at is null
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id)) limit 1),
    c.confirmation_method, c.signer_role::text, c.typed_signer_name, c.signer_relationship, c.confirmation_reason, c.confirmed_at,
    c.evidence_id is not null,
    v.original_visit_id is not null, v.original_visit_id,
    coalesce(ogevia.visit_review_reasons(v.id), array[]::text[]),
    d.id, d.decision, d.reason, du.display_name, d.decided_at,
    b.id, b.approved_minutes,
    ogevia.has_permission(v.organization_id, 'visits.manage'),
    case when ogevia.has_permission(v.organization_id, 'visits.manage')
         then coalesce(ogevia.visit_review_allowed(v.id), array[]::text[]) else array[]::text[] end,
    ogevia.visit_recovery_state(v.id),
    ogevia.has_permission(v.organization_id, 'visits.manage') and v.status = 'administrator_review'
      and 'no_client_signature' = any (coalesce(ogevia.visit_review_reasons(v.id), array[]::text[]))
      and d.id is null and ogevia.visit_recovery_state(v.id) is null,
    d.accepted_minutes,
    case when ogevia.has_permission(v.organization_id, 'billing.visits.read') then ogevia.visit_billing_state(v.id) end
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  left join ogevia.shifts sh on sh.id = v.scheduled_shift_id
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.client_private_names n on n.client_id = v.client_id
  left join ogevia.visit_review_decisions d on d.visit_id = v.id and d.revoked_at is null
  left join ogevia.app_users du on du.id = d.decided_by
  left join ogevia.billing_approvals b on b.visit_id = v.id and b.voided_at is null
  where v.id = p_visit_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(v.organization_id)
    and ogevia.has_permission(v.organization_id, 'visits.read');
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
create or replace function ogevia_api.get_attention_summary(
  p_organization_id uuid,
  p_unscheduled_open_hours integer default 12,
  p_unconfirmed_minutes integer default 60
)
returns table (
  missing_time_out integer,
  not_confirmed integer,
  needs_review integer,
  billing_ready_unapproved integer,
  total integer,
  uncovered_shifts integer,
  documents_blocking integer,
  documents_to_review integer,
  documents_expiring integer,
  awaiting_signature integer,
  late_responses_to_review integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id)
             and ogevia.has_permission(p_organization_id, 'visits.read') as can_read,
           ogevia.has_permission(p_organization_id, 'billing.visits.read') as can_bill,
           ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage') as can_cover,
           ogevia.has_permission(p_organization_id, 'documents.read') as can_docs
  ), c as (
    select
      count(*) filter (
        where v.status = 'draft' and v.time_out is null
          and ((s.id is not null and s.ends_at < now())
               or (s.id is null and v.time_in <= now() - make_interval(hours => p_unscheduled_open_hours)))
      )::integer as missing_time_out,
      count(*) filter (
        where v.status = 'awaiting_signature' and v.time_out is not null
          and v.time_out <= now() - make_interval(mins => p_unconfirmed_minutes)
      )::integer as not_confirmed,
      -- 0036: a visit waiting for a late confirmation is a reminder, not an action;
      -- a received response is its own action item.
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
          and ogevia.visit_recovery_state(v.id) is null
      )::integer as needs_review,
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
          and ogevia.visit_recovery_state(v.id) = 'awaiting_response'
      )::integer as awaiting_signature,
      count(*) filter (
        where v.status = 'administrator_review'
          and ogevia.visit_recovery_state(v.id) = 'response_to_review'
      )::integer as late_responses,
      count(*) filter (
        where ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
      )::integer as ready_unapproved
    from ogevia.service_visits v
    left join ogevia.shifts s on s.id = v.scheduled_shift_id
    where v.organization_id = p_organization_id
      and v.status in ('draft', 'awaiting_signature', 'administrator_review', 'signed')
  ), cov as (
    -- Upcoming shifts with nobody to work them (open, or called out and not replaced).
    select count(*)::integer as uncovered
    from ctx, ogevia.shifts sh
    where ctx.can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled'
      and sh.ends_at > now() and ogevia.shift_coverage_state(sh) = 'needs_coverage'
  ), docs as (
    select a.* from ctx, ogevia_api.get_document_alerts(p_organization_id) a where ctx.can_docs
  )
  select c.missing_time_out, c.not_confirmed, c.needs_review,
         case when ctx.can_bill then c.ready_unapproved end,
         c.missing_time_out + c.not_confirmed + c.needs_review + c.late_responses
           + case when ctx.can_cover then cov.uncovered else 0 end
           + coalesce((select d.expired + d.overdue + d.awaiting_review from docs d), 0),
         case when ctx.can_cover then cov.uncovered end,
         (select d.expired + d.overdue from docs d),
         (select d.awaiting_review from docs d),
         (select d.expiring from docs d),
         c.awaiting_signature,
         c.late_responses
  from ctx, c, cov
  where ctx.actor is not null and ctx.can_read;
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

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;

revoke all on function ogevia_api.list_billing_review_visits(uuid, date, date) from public;
grant execute on function ogevia_api.list_billing_review_visits(uuid, date, date) to ogevia_app;
revoke all on function ogevia_api.get_visit_review(uuid) from public;
grant execute on function ogevia_api.get_visit_review(uuid) to ogevia_app;
