-- ROLLBACK 0036_signature_recovery | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any confirmation request, late confirmation, late review or
-- accept_late_confirmation decision exists (export them first; they would be
-- lost). Otherwise restores every changed function exactly as before 0036
-- (authorization_month_usage and list_monthly_service_summary from 0029,
-- approve_visit_for_billing, visit_review_allowed, get_visit_review and
-- list_billing_review_visits from 0031, get_attention_summary from 0033,
-- rounding_units from 0029) and drops the 0036 objects.
do $$ begin
  if exists (select 1 from ogevia.visit_confirmation_requests)
     or exists (select 1 from ogevia.visit_late_confirmations)
     or exists (select 1 from ogevia.visit_late_confirmation_reviews)
     or exists (select 1 from ogevia.visit_review_decisions where decision = 'accept_late_confirmation') then
    raise exception 'ROLLBACK REFUSED: missing-signature recovery records exist (requests, responses or reviews); export them first (they would be lost)';
  end if;
end $$;

drop function ogevia_api.get_visit_review(uuid);
drop function ogevia_api.list_billing_review_visits(uuid, date, date);
drop function ogevia_api.get_attention_summary(uuid, integer, integer);
create or replace function ogevia.authorization_month_usage(
  p_lineage_id uuid,
  p_service_date date,
  p_exclude_visit_id uuid default null
)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select (
    select coalesce(sum(v.billable_minutes), 0)
    from ogevia.service_visits v
    join ogevia.client_authorizations a on a.id = v.service_authorization_id
    where a.lineage_id = p_lineage_id
      and v.service_date >= date_trunc('month', p_service_date::timestamp)::date
      and v.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
      and v.status in ('signed', 'administrator_review')
      and v.id is distinct from p_exclude_visit_id
  ) + (
    select coalesce(sum(r.adjustment_minutes), 0)
    from ogevia.billing_rounding_adjustments r
    where r.authorization_lineage_id = p_lineage_id and r.voided_at is null
      and r.service_date >= date_trunc('month', p_service_date::timestamp)::date
      and r.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
  )::bigint;
$$;

create or replace function ogevia_api.list_monthly_service_summary(
  p_organization_id uuid,
  p_month_start date,
  p_client_id uuid default null
)
returns table (
  client_id uuid,
  client_code text,
  service_id uuid,
  service_code text,
  service_name text,
  authorization_lineage_id uuid,
  authorization_period_start date,
  authorization_period_end date,
  authorized_minutes integer,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  remaining_minutes integer,
  review_minutes integer,
  visit_count integer,
  reserved_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as month_end
  ),
  ranked_authorizations as (
    select
      a.*,
      row_number() over (
        partition by a.lineage_id
        order by a.version_number desc
      ) as version_rank
    from ogevia.client_authorizations a
    cross join bounds b
    where a.organization_id = p_organization_id
      and (p_client_id is null or a.client_id = p_client_id)
      and a.deleted_at is null
      and a.period_start < b.month_end
      and a.period_end >= b.month_start
  ),
  authorizations as (
    select *
    from ranked_authorizations
    where version_rank = 1
  ),
  usage as (
    select
      va.lineage_id,
      coalesce(sum(v.worked_minutes), 0)::integer as worked_minutes,
      coalesce(sum(v.verified_minutes), 0)::integer as verified_minutes,
      coalesce(sum(v.billable_minutes), 0)::integer as billable_minutes,
      coalesce(sum(v.worked_minutes) filter (where v.status = 'administrator_review'), 0)::integer as review_minutes,
      count(*)::integer as visit_count
    from ogevia.service_visits v
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    cross join bounds b
    where v.organization_id = p_organization_id
      and (p_client_id is null or v.client_id = p_client_id)
      and v.service_date >= b.month_start
      and v.service_date < b.month_end
      and v.status in ('signed', 'administrator_review')
    group by va.lineage_id
  ),
  -- Time held by assigned Care Request shifts that no signed visit has
  -- consumed yet (released when the linked visit is signed, 0013). The
  -- assignment cap counts it, so "remaining" must too.
  -- Approved billing rounding adjustments (0029) consume (or return) authorized time.
  adjusted as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.adjustment_minutes), 0)::integer as adjustment_minutes
    from ogevia.billing_rounding_adjustments r
    cross join bounds b
    where r.organization_id = p_organization_id and r.voided_at is null
      and r.service_date >= b.month_start and r.service_date < b.month_end
    group by r.authorization_lineage_id
  ),
  reserved as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.reserved_minutes), 0)::integer as reserved_minutes
    from ogevia.authorization_reservations r
    cross join bounds b
    where r.organization_id = p_organization_id
      and r.released_at is null
      and r.service_date >= b.month_start
      and r.service_date < b.month_end
    group by r.authorization_lineage_id
  )
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    sv.id,
    sv.code,
    sv.name,
    a.lineage_id,
    a.period_start,
    a.period_end,
    a.monthly_authorized_minutes,
    coalesce(u.worked_minutes, 0),
    coalesce(u.verified_minutes, 0),
    coalesce(u.billable_minutes, 0),
    greatest(a.monthly_authorized_minutes - coalesce(u.billable_minutes, 0) - coalesce(ad.adjustment_minutes, 0) - coalesce(rs.reserved_minutes, 0), 0),
    coalesce(u.review_minutes, 0),
    coalesce(u.visit_count, 0),
    coalesce(rs.reserved_minutes, 0)
  from authorizations a
  join ogevia.clients c
    on c.id = a.client_id
   and c.organization_id = a.organization_id
  join ogevia.services sv
    on sv.id = a.service_id
   and sv.organization_id = a.organization_id
  left join usage u on u.lineage_id = a.lineage_id
  left join reserved rs on rs.lineage_id = a.lineage_id
  left join adjusted ad on ad.lineage_id = a.lineage_id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
  order by sv.name, sv.code, a.period_start;
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

create or replace function ogevia.visit_review_allowed(p_visit_id uuid)
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

create function ogevia_api.get_attention_summary(
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
  documents_expiring integer
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
         c.missing_time_out + c.not_confirmed + c.needs_review
           + case when ctx.can_cover then cov.uncovered else 0 end
           + coalesce((select d.expired + d.overdue + d.awaiting_review from docs d), 0),
         case when ctx.can_cover then cov.uncovered end,
         (select d.expired + d.overdue from docs d),
         (select d.awaiting_review from docs d),
         (select d.expiring from docs d)
  from ctx, c, cov
  where ctx.actor is not null and ctx.can_read;
$$;

create or replace function ogevia.rounding_units(p_organization_id uuid, p_from date, p_to date)
returns table (
  unit_kind text, unit_key text, visit_id uuid, authorization_lineage_id uuid, client_id uuid, service_id uuid, service_date date,
  payer text, policy_id uuid, covered_visit_ids uuid[], visit_count integer, first_time_in timestamptz, last_time_out timestamptz,
  worked_minutes integer, billable_minutes integer, approved_minutes integer, all_approved boolean, open_visits integer
)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with v as (
    select sv.*, a.lineage_id, a.payer, (ogevia.rounding_policy_for(p_organization_id, a.payer, sv.service_id, sv.service_date)) as pol,
           (select b.approved_minutes from ogevia.billing_approvals b where b.visit_id = sv.id and b.voided_at is null) as appr
    from ogevia.service_visits sv
    join ogevia.client_authorizations a on a.id = sv.service_authorization_id
    where sv.organization_id = p_organization_id and sv.service_date between p_from and p_to and sv.status = 'signed'
  ), u as (
    select case when (v.pol).basis = 'daily_total' and (v.pol).method <> 'none' then 'day' else 'visit' end as kind, v.*
    from v
  )
  select u.kind,
         case when u.kind = 'day' then u.lineage_id::text || ':' || u.service_date::text else min(u.id::text) end,
         case when u.kind = 'visit' then (array_agg(u.id))[1] end,
         u.lineage_id, (array_agg(u.client_id))[1], (array_agg(u.service_id))[1], u.service_date, (array_agg(u.payer))[1],
         (array_agg((u.pol).id))[1], array_agg(u.id order by u.time_in), count(*)::integer, min(u.time_in), max(u.time_out),
         sum(u.worked_minutes)::integer, sum(u.billable_minutes)::integer, sum(u.appr)::integer, bool_and(u.appr is not null),
         (select count(*)::integer from ogevia.service_visits o join ogevia.client_authorizations oa on oa.id = o.service_authorization_id
          where u.kind = 'day' and oa.lineage_id = u.lineage_id and o.service_date = u.service_date
            and o.status in ('draft', 'awaiting_signature', 'administrator_review'))
  from u
  group by u.kind, u.lineage_id, u.service_date, case when u.kind = 'day' then null else u.id end;
$$;

revoke all on function ogevia_api.get_visit_review(uuid) from public;
revoke all on function ogevia_api.list_billing_review_visits(uuid, date, date) from public;
revoke all on function ogevia_api.get_attention_summary(uuid, integer, integer) from public;
grant execute on function ogevia_api.get_visit_review(uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_review_visits(uuid, date, date) to ogevia_app;
grant execute on function ogevia_api.get_attention_summary(uuid, integer, integer) to ogevia_app;

drop function ogevia_api.review_late_visit_confirmation(uuid, text, text, uuid);
drop function ogevia_api.check_paper_confirmation_upload(uuid, uuid);
drop function ogevia_api.record_paper_visit_confirmation(uuid, uuid, text, text, date, text, text, text, integer, text, uuid);
drop function ogevia_api.public_respond_visit_confirmation(text, text, uuid, text, text, text, text, boolean, text, text, integer, text, uuid);
drop function ogevia_api.public_open_visit_confirmation(text, text);
drop function ogevia.confirmation_request_check(text, text);
drop function ogevia_api.get_late_confirmation_evidence(uuid);
drop function ogevia_api.list_visit_confirmation_requests(uuid);
drop function ogevia_api.revoke_visit_confirmation_request(uuid, text, uuid);
drop function ogevia_api.create_visit_confirmation_request(uuid, text, text, text, text, text, text, integer, uuid);
drop function ogevia.visit_recovery_state(uuid);
drop function ogevia.confirmation_request_state(ogevia.visit_confirmation_requests);
drop function ogevia.visit_snapshot_for_confirmation(uuid);
drop function ogevia.visit_matches_snapshot(uuid, jsonb);

alter table ogevia.visit_review_decisions drop constraint visit_review_decisions_late_shape;
alter table ogevia.visit_review_decisions drop column accepted_minutes;
alter table ogevia.visit_review_decisions drop column late_confirmation_review_id;
alter table ogevia.visit_review_decisions drop constraint visit_review_decisions_decision_check;
alter table ogevia.visit_review_decisions add constraint visit_review_decisions_decision_check
  check (decision in ('accept_capped_billable', 'close_not_billable'));

drop table ogevia.visit_late_confirmation_reviews;
drop table ogevia.visit_late_confirmations;
drop table ogevia.visit_confirmation_requests;
drop function ogevia.visit_confirmation_requests_guard();
