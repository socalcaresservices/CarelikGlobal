-- 0031 Visit review: a recorded, audited decision for a visit that needs review.
--
-- Before this migration (verified in the repository, 2026-10-05):
--   * confirm_service_visit (0006) puts a visit in administrator_review when the
--     client did not sign or mark (verbal, typed, unable_to_confirm: 0 billable)
--     or when it goes over the authorization (billable capped).
--   * approve_visit_for_billing (0019) accepts only 'signed' visits and says
--     "visits needing review must be reviewed first", but no review action
--     existed: a capped over-authorization visit could never be approved, and
--     a no-signer visit stayed in Needs attention for ever.
--   * Locked visits are immutable (service_visits_guard_update, 0005). That
--     stays: a review decision is a separate append-only record; the visit row,
--     its times and its billable minutes are never changed by it.
--
-- Decisions (visits.manage; one active decision per visit; reason required):
--   * accept_capped_billable: the client signed or marked, and the visit went
--     over the authorization. The capped billable minutes (already computed at
--     confirmation, never raised) become eligible for the separate human
--     billing approval. Not available without signature/mark evidence.
--   * close_not_billable: the review is closed with nothing billable beyond
--     what the visit already shows (0 for a visit without a client signature).
--     It never makes a visit billable.
-- A decision can be revoked with a reason (for example, when a late signature
-- is obtained) unless a billing approval is active for the visit.
-- Nothing here creates a signature, clears a flag on opening, or submits.
--
-- Changed functions:
--   * approve_visit_for_billing: also accepts an administrator_review visit
--     with an active accept_capped_billable decision (same minute limits).
--   * get_attention_summary: needs_review counts only visits without an
--     active decision.
--   * list_billing_review_visits (0030 shape + review fields): review_state is
--     ready | reviewed_eligible | reviewed_not_billable | needs_review.
-- New: get_visit_review (visits.read), decide_visit_review,
--      revoke_visit_review_decision.

create table ogevia.visit_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  visit_id uuid not null references ogevia.service_visits(id),
  decision text not null check (decision in ('accept_capped_billable', 'close_not_billable')),
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  review_reasons text[] not null,
  visit_snapshot jsonb not null,
  decided_by uuid not null references ogevia.app_users(id),
  decided_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references ogevia.app_users(id),
  revoke_reason text,
  request_id uuid,
  constraint visit_review_decisions_revoke_shape check (
    (revoked_at is null and revoked_by is null and revoke_reason is null)
    or (revoked_at is not null and revoked_by is not null and length(btrim(coalesce(revoke_reason, ''))) > 0)
  )
);
create unique index visit_review_decisions_one_active on ogevia.visit_review_decisions (visit_id) where revoked_at is null;
create index visit_review_decisions_org_idx on ogevia.visit_review_decisions (organization_id, decided_at desc);

-- Append-only, except recording a revocation once.
create function ogevia.visit_review_decisions_guard()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Review decisions cannot be deleted' using errcode = 'OGC09';
  end if;
  if old.revoked_at is not null
     or (to_jsonb(new) - array['revoked_at', 'revoked_by', 'revoke_reason'])
        is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'revoke_reason']) then
    raise exception 'A review decision cannot be changed; revoke it and record a new one' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger visit_review_decisions_guard before update or delete on ogevia.visit_review_decisions
for each row execute function ogevia.visit_review_decisions_guard();

alter table ogevia.visit_review_decisions enable row level security;
create policy readonly_select on ogevia.visit_review_decisions for select to ogevia_readonly using (true);
grant select on ogevia.visit_review_decisions to ogevia_readonly;

-- Why a visit is in review, from its own record (never from the browser).
create function ogevia.visit_review_reasons(p_visit_id uuid)
returns text[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select array_remove(array[
    case when coalesce(c.confirmation_method, '') not in ('draw', 'assisted_mark') then 'no_client_signature' end,
    case when v.authorization_status = 'exceeds_authorization'
           or (v.billable_minutes < v.worked_minutes and c.confirmation_method in ('draw', 'assisted_mark'))
         then 'over_authorization' end
  ], null)
  from ogevia.service_visits v
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  where v.id = p_visit_id and v.status = 'administrator_review';
$$;

-- Decisions this visit allows right now (empty unless it is in review without an active decision).
create function ogevia.visit_review_allowed(p_visit_id uuid)
returns text[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when v.status <> 'administrator_review'
      or exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
      then array[]::text[]
    when c.confirmation_method in ('draw', 'assisted_mark') and v.billable_minutes > 0
      then array['accept_capped_billable', 'close_not_billable']
    else array['close_not_billable']
  end
  from ogevia.service_visits v
  left join ogevia.visit_confirmations c on c.visit_id = coalesce(v.original_visit_id, v.id)
  where v.id = p_visit_id;
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
  allowed_decisions text[]
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
         then coalesce(ogevia.visit_review_allowed(v.id), array[]::text[]) else array[]::text[] end
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

create function ogevia_api.decide_visit_review(
  p_visit_id uuid,
  p_decision text,
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

  perform ogevia.write_audit(v_visit.organization_id, 'visit.review_decided', 'visit_review_decisions', v_id, null,
    jsonb_build_object('visit_id', v_visit.id, 'decision', p_decision, 'review_reasons', v_reasons,
      'billable_minutes', v_visit.billable_minutes), v_reason);
  perform ogevia.idempotency_finish('decide_visit_review', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, jsonb_build_object('decision_id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.revoke_visit_review_decision(
  p_decision_id uuid,
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
  v_d ogevia.visit_review_decisions%rowtype;
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
  update ogevia.visit_review_decisions set revoked_at = now(), revoked_by = v_actor, revoke_reason = v_reason
  where id = v_d.id;
  perform ogevia.write_audit(v_d.organization_id, 'visit.review_revoked', 'visit_review_decisions', v_d.id,
    jsonb_build_object('decision', v_d.decision), jsonb_build_object('revoked', true), v_reason);
  perform ogevia.idempotency_finish('revoke_visit_review', p_idempotency_key, v_d.organization_id,
    v_fingerprint, jsonb_build_object('decision_id', v_d.id));
  return v_d.id;
end;
$$;

-- Billing approval: unchanged except that a reviewed, accepted visit is also eligible.
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
    where d.visit_id = v_visit.id and d.revoked_at is null and d.decision = 'accept_capped_billable');
  if v_visit.status <> 'signed' and not v_review_accepted then
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
      'serviceAuthorizationId', v_visit.service_authorization_id,
      'reviewAccepted', v_review_accepted)
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
      -- 0031: a visit with an active review decision no longer needs attention.
      count(*) filter (
        where v.status = 'administrator_review'
          and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
      )::integer as needs_review,
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
  scheduled_shift_id uuid,
  review_reasons text[],
  review_decision text,
  review_decided_at timestamptz
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
      when d.decision = 'accept_capped_billable' then 'reviewed_eligible'
      when d.decision = 'close_not_billable' then 'reviewed_not_billable'
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
    d.decided_at
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  left join ogevia.visit_confirmations root_conf
    on root_conf.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.client_private_names n on n.client_id = v.client_id
  left join ogevia.visit_review_decisions d on d.visit_id = v.id and d.revoked_at is null
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.has_permission(p_organization_id, 'billing.visits.read')
    and v.status in ('signed', 'administrator_review')
    and v.service_date between p_date_from and p_date_to
  order by v.service_date, v.time_in;
$$;

revoke all on function ogevia.visit_review_reasons(uuid) from public;
revoke all on function ogevia.visit_review_allowed(uuid) from public;
revoke all on function ogevia_api.get_visit_review(uuid) from public;
revoke all on function ogevia_api.decide_visit_review(uuid, text, text, uuid) from public;
revoke all on function ogevia_api.revoke_visit_review_decision(uuid, text, uuid) from public;
revoke all on function ogevia_api.list_billing_review_visits(uuid, date, date) from public;
grant execute on function ogevia_api.get_visit_review(uuid) to ogevia_app;
grant execute on function ogevia_api.decide_visit_review(uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.revoke_visit_review_decision(uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_review_visits(uuid, date, date) to ogevia_app;
