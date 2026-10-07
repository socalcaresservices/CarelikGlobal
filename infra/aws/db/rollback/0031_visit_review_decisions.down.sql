-- ROLLBACK 0031_visit_review_decisions | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any review decision exists (the decisions and their reasons are
-- review records), or while a billing approval rests on an accepted review.
-- Otherwise restores approve_visit_for_billing (0019), get_attention_summary
-- (0020) and list_billing_review_visits (0030) exactly, and drops the 0031 objects.
do $$ begin
  if exists (select 1 from ogevia.visit_review_decisions) then
    raise exception 'ROLLBACK REFUSED: visit review decisions exist; export them first (they would be lost)';
  end if;
end $$;
drop function if exists ogevia_api.revoke_visit_review_decision(uuid, text, uuid);
drop function if exists ogevia_api.decide_visit_review(uuid, text, text, uuid);
drop function if exists ogevia_api.get_visit_review(uuid);
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

  if v_visit.status <> 'signed' then
    raise exception 'Only a Billing Ready visit can be approved; visits needing review must be reviewed first'
      using errcode = 'OGC09';
  end if;
  if p_approved_minutes is null or p_approved_minutes < 0 or p_approved_minutes > v_visit.billable_minutes then
    raise exception 'Approved minutes must be between 0 and the billable minutes (%)', v_visit.billable_minutes
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
    v_visit.organization_id, v_visit.id, v_actor, p_approved_minutes, v_visit.billable_minutes,
    nullif(btrim(coalesce(p_notes, '')), ''), v_rate, v_amount,
    jsonb_build_object(
      'visitId', v_visit.id, 'visitNumber', v_visit.visit_number_snapshot,
      'clientId', v_visit.client_id, 'clientCode', v_visit.client_code_snapshot,
      'serviceId', v_visit.service_id, 'serviceDate', v_visit.service_date,
      'timeIn', v_visit.time_in, 'timeOut', v_visit.time_out,
      'workedMinutes', v_visit.worked_minutes, 'billableMinutes', v_visit.billable_minutes,
      'serviceAuthorizationId', v_visit.service_authorization_id)
  ) returning id into v_id;

  -- The audit row carries minutes only; dollar values stay in the owner-only columns.
  v_after := jsonb_build_object('billing_approval_id', v_id, 'visit_id', v_visit.id,
    'approved_minutes', p_approved_minutes, 'billable_minutes', v_visit.billable_minutes);
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
  total integer
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
           ogevia.has_permission(p_organization_id, 'billing.visits.read') as can_bill
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
      count(*) filter (where v.status = 'administrator_review')::integer as needs_review,
      count(*) filter (
        where v.status = 'signed'
          and not exists (select 1 from ogevia.billing_approvals b where b.visit_id = v.id and b.voided_at is null)
      )::integer as ready_unapproved
    from ogevia.service_visits v
    left join ogevia.shifts s on s.id = v.scheduled_shift_id
    where v.organization_id = p_organization_id
      and v.status in ('draft', 'awaiting_signature', 'administrator_review', 'signed')
  )
  select c.missing_time_out, c.not_confirmed, c.needs_review,
         case when ctx.can_bill then c.ready_unapproved end,
         c.missing_time_out + c.not_confirmed + c.needs_review
  from ctx, c
  where ctx.actor is not null and ctx.can_read;
$$;

drop function ogevia_api.list_billing_review_visits(uuid, date, date);
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
  scheduled_shift_id uuid
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
    case v.status when 'signed' then 'ready' else 'needs_review' end,
    (select max(ae.id) from ogevia.audit_events ae where ae.entity_id = v.id),
    v.client_code_snapshot,
    -- Legal names only for clients.names.read (Administrator, manager); null otherwise.
    case when ogevia.has_permission(p_organization_id, 'clients.names.read')
         then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
    v.caregiver_name_snapshot,
    sv.name,
    (select cr.scheduling_mode from ogevia.caregiver_records cr where cr.organization_id = v.organization_id and cr.deleted_at is null
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id)) limit 1),
    v.scheduled_shift_id
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  left join ogevia.visit_confirmations root_conf
    on root_conf.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.client_private_names n on n.client_id = v.client_id
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.has_permission(p_organization_id, 'billing.visits.read')
    and v.status in ('signed', 'administrator_review')
    and v.service_date between p_date_from and p_date_to
  order by v.service_date, v.time_in;
$$;

revoke all on function ogevia_api.list_billing_review_visits(uuid, date, date) from public;
grant execute on function ogevia_api.list_billing_review_visits(uuid, date, date) to ogevia_app;
drop function if exists ogevia.visit_review_allowed(uuid);
drop function if exists ogevia.visit_review_reasons(uuid);
drop table ogevia.visit_review_decisions;
drop function if exists ogevia.visit_review_decisions_guard();
