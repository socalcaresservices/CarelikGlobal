-- 0067 Reservation lifecycle: every reserved minute is shown, and a shift that ended with no visit is reconciled by a person (owner request 2026-10-17, blockers 1 and 2).
--
-- APPROVED DEFINITIONS USED (Board 2 accounting rule, Board 3 requirement 11 and exception 4, Board 5 requirement 5, master consolidation "single accounting basis"):
--   committed = confirmed (billable) + approved rounding adjustments + reserved; over-limit is shown, never clamped; cancelled or partially worked visits release
--   ONLY unused reservations; no automatic carryover; a minute is counted once.
--
-- BLOCKER 1 (F6): a reservation whose shift had already started was in "reserved" (it lowered remaining) but in no scheduled figure, so authorized, billable,
--   scheduled and remaining did not add up on Home. Home's scheduled figure now comes from the reservation ledger in the agency's LOCAL month (the same rows and
--   month as every other screen, not a UTC month of the shift start), and includes time that is underway.
-- BLOCKER 2 (C3): a shift that ended with no visit kept its reservation forever, invisible and not cancellable. NOTHING IS RELEASED AUTOMATICALLY: a missing visit
--   record does not prove that no service happened. Such a reservation now has its own bucket and is listed for a person to reconcile with one of two attested
--   outcomes, each recorded append-only (who, when, note, minutes) beside the audit event:
--     no_service_delivered              the person confirms no service was delivered: the reservation is released (release_reason reconciled_no_service)
--     hold_service_may_have_occurred    the person cannot confirm: the reservation stays reserved and counted; the shift moves to "awaiting record" (visible, owned)
--   A later decision supersedes an earlier one. A release is final for that reservation (history is kept, nothing is rewritten). There is deliberately no outcome
--   for "service delivered, bill it": a delivered service without a verification record cannot become billable here. How the agency treats such time is an OWNER
--   DECISION (see PILOT_BLOCKER_CLASSIFICATION).
-- RESERVATION BUCKETS (ogevia.reservation_bucket; NULL = not part of the reserved total): ahead | underway (started, or a visit still open) | held_review (a linked visit has
-- ended and awaits the client's confirmation, or is in review) | awaiting_record | unreconciled.
-- list_monthly_service_summary gains reserved_ahead/underway/review/reconcile_minutes (their sum is reserved_minutes); get_utilisation_overview gains reserved_minutes,
-- held_review_minutes and needs_reconciliation_minutes and its scheduled_minutes is ahead + underway. get_attention_overview gains a reconciliation count.
-- Rollback (BACKUP REQUIRED: the decision table is dropped) restores the 0057/0064 definitions. Reservations released by a reconciliation stay released.


create table ogevia.shift_reconciliations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  shift_id uuid not null references ogevia.shifts(id),
  reservation_id uuid not null, -- no foreign key: the history must outlive any rewrite of the reservation table
  outcome text not null check (outcome in ('no_service_delivered', 'hold_service_may_have_occurred')),
  note text not null check (length(btrim(note)) between 10 and 1000),
  reserved_minutes integer not null check (reserved_minutes > 0),
  decided_by uuid not null references ogevia.app_users(id),
  decided_at timestamptz not null default now()
);
create index shift_reconciliations_shift on ogevia.shift_reconciliations (shift_id, decided_at desc);
create trigger shift_reconciliations_no_update before update on ogevia.shift_reconciliations for each row execute function ogevia.forbid_update();
create trigger shift_reconciliations_no_delete before delete on ogevia.shift_reconciliations for each row execute function ogevia.forbid_delete();
alter table ogevia.shift_reconciliations enable row level security;
create policy readonly_select on ogevia.shift_reconciliations for select to ogevia_readonly using (true);
grant select on ogevia.shift_reconciliations to ogevia_readonly;

create function ogevia.reservation_bucket(p_reservation_id uuid)
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
revoke all on function ogevia.reservation_bucket(uuid) from public;

-- Shifts that ended with no visit record and still hold a reservation: what a person must look at. Read: shifts.manage.
create function ogevia_api.list_shifts_to_reconcile(p_organization_id uuid)
returns table (
  shift_id uuid, reservation_id uuid, starts_at timestamptz, ends_at timestamptz, local_date date, client_code text, service_code text, service_name text,
  caregiver_code text, reserved_minutes integer, bucket text, ended_hours integer, last_outcome text, last_note text, last_decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'shifts.manage') then raise exception 'You do not have permission to reconcile shifts' using errcode = 'OGA03'; end if;
  return query
  select sh.id, r.id, sh.starts_at, sh.ends_at, r.service_date, c.client_code, sv.code, sv.name, cr.caregiver_code, r.reserved_minutes,
         ogevia.reservation_bucket(r.id), (extract(epoch from (now() - sh.ends_at)) / 3600)::integer,
         d.outcome, d.note, d.decided_at
  from ogevia.authorization_reservations r
  join ogevia.shifts sh on sh.id = r.shift_id
  left join ogevia.clients c on c.id = sh.client_id
  left join ogevia.services sv on sv.id = sh.service_id
  left join ogevia.caregiver_records cr on cr.id = sh.caregiver_record_id
  left join lateral (select x.outcome, x.note, x.decided_at from ogevia.shift_reconciliations x where x.shift_id = r.shift_id order by x.decided_at desc, x.id desc limit 1) d on true
  where r.organization_id = p_organization_id and r.released_at is null
    and ogevia.reservation_bucket(r.id) in ('unreconciled', 'awaiting_record')
  order by sh.ends_at, sh.id;
end;
$$;

create function ogevia_api.reconcile_ended_shift(p_organization_id uuid, p_shift_id uuid, p_outcome text, p_note text, p_idempotency_key uuid default null)
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
revoke all on function ogevia_api.list_shifts_to_reconcile(uuid) from public;
revoke all on function ogevia_api.reconcile_ended_shift(uuid, uuid, text, text, uuid) from public;
grant execute on function ogevia_api.list_shifts_to_reconcile(uuid) to ogevia_app;
grant execute on function ogevia_api.reconcile_ended_shift(uuid, uuid, text, text, uuid) to ogevia_app;

drop function ogevia_api.list_monthly_service_summary(uuid, date, uuid);
drop function ogevia_api.get_utilisation_overview(uuid, date);
create function ogevia_api.list_monthly_service_summary(
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
  reserved_minutes integer,
  adjustment_minutes integer,
  committed_minutes integer,
  over_limit_minutes integer,
  utilization_percent double precision,
  authorization_tier text,
  days_until_expiry integer,
  expiring_soon boolean,
  reserved_ahead_minutes integer,
  reserved_underway_minutes integer,
  reserved_review_minutes integer,
  reserved_reconcile_minutes integer
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
      coalesce(sum(v.billable_minutes + (select coalesce(sum(d.accepted_minutes), 0) from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation')), 0)::integer as billable_minutes,
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
    -- 0067: the same reserved total as before, split by lifecycle bucket (ogevia.reservation_bucket) so every reserved minute is shown somewhere:
    -- ahead (shift not started), underway (started, or a visit still open), review (held while a linked visit is in review) and reconcile (the shift
    -- ended with no visit record: nothing is released until a person decides). ahead + underway + review + reconcile = reserved.
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.reserved_minutes), 0)::integer as reserved_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'ahead'), 0)::integer as ahead_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'underway'), 0)::integer as underway_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'held_review'), 0)::integer as review_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket in ('unreconciled', 'awaiting_record')), 0)::integer as reconcile_minutes
    from ogevia.authorization_reservations r
    cross join bounds b
    cross join lateral (select ogevia.reservation_bucket(r.id) as bucket) rb
    where r.organization_id = p_organization_id
      and r.released_at is null
      and r.service_date >= b.month_start
      and r.service_date < b.month_end
      and rb.bucket is not null
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
    a.monthly_authorized_minutes - (coalesce(u.billable_minutes, 0) + coalesce(ad.adjustment_minutes, 0) + coalesce(rs.reserved_minutes, 0)),
    coalesce(u.review_minutes, 0),
    coalesce(u.visit_count, 0),
    coalesce(rs.reserved_minutes, 0),
    coalesce(ad.adjustment_minutes, 0),
    (coalesce(u.billable_minutes, 0) + coalesce(ad.adjustment_minutes, 0) + coalesce(rs.reserved_minutes, 0)),
    greatest((coalesce(u.billable_minutes, 0) + coalesce(ad.adjustment_minutes, 0) + coalesce(rs.reserved_minutes, 0)) - a.monthly_authorized_minutes, 0),
    case when a.monthly_authorized_minutes > 0 then round((100.0 * (coalesce(u.billable_minutes, 0) + coalesce(ad.adjustment_minutes, 0) + coalesce(rs.reserved_minutes, 0)) / a.monthly_authorized_minutes)::numeric, 1)::double precision end,
    ogevia.authorization_tier((coalesce(u.billable_minutes, 0) + coalesce(ad.adjustment_minutes, 0) + coalesce(rs.reserved_minutes, 0)), a.monthly_authorized_minutes),
    (a.period_end - ogevia.organization_local_date(p_organization_id, now())),
    (a.period_end - ogevia.organization_local_date(p_organization_id, now())) between 0 and 30,
    coalesce(rs.ahead_minutes, 0), coalesce(rs.underway_minutes, 0), coalesce(rs.review_minutes, 0), coalesce(rs.reconcile_minutes, 0)
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
create function ogevia_api.get_utilisation_overview(p_organization_id uuid, p_month_start date)
returns table (
  service_id uuid,
  service_code text,
  service_name text,
  client_count integer,
  authorized_minutes integer,
  scheduled_minutes integer,
  worked_minutes integer,
  billable_minutes integer,
  review_minutes integer,
  approved_minutes integer,
  remaining_minutes integer,
  lineages_without_rate integer,
  billable_value_cents bigint,
  approved_value_cents bigint,
  unused_value_cents bigint,
  committed_minutes integer,
  over_limit_minutes integer,
  near_limit_authorizations integer,
  critical_authorizations integer,
  expiring_authorizations integer,
  reserved_minutes integer,
  held_review_minutes integer,
  needs_reconciliation_minutes integer
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
           ogevia.has_permission(p_organization_id, 'billing.read') as can_see_money,
           date_trunc('month', p_month_start::timestamp)::date as m0,
           (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as m1
  ),
  -- One row per client/service/lineage; the latest version only (0010).
  summary as (
    select s.* from ctx, ogevia_api.list_monthly_service_summary(p_organization_id, ctx.m0, null) s
    where ctx.can_read
  ),
  lineage_rate as (
    select distinct on (a.lineage_id) a.lineage_id, a.hourly_rate_cents
    from ogevia.client_authorizations a
    join summary su on su.authorization_lineage_id = a.lineage_id
    order by a.lineage_id, a.version_number desc
  ),
  visit_values as (
    select va.lineage_id,
           sum(v.billable_minutes::numeric / 60 * va.hourly_rate_cents) filter (where va.hourly_rate_cents is not null) as billable_value,
           coalesce(sum(b.approved_minutes), 0)::integer as approved_minutes,
           sum(b.amount_cents) as approved_value
    from ctx
    join ogevia.service_visits v on v.organization_id = p_organization_id
     and v.service_date >= ctx.m0 and v.service_date < ctx.m1
     and v.status in ('signed', 'administrator_review')
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    left join ogevia.billing_approvals b on b.visit_id = v.id and b.voided_at is null
    where ctx.can_read
    group by va.lineage_id
  ),
  per_service as (
    select su.service_id, su.service_code, su.service_name,
           count(distinct su.client_id)::integer as client_count,
           sum(su.authorized_minutes)::integer as authorized_minutes,
           sum(su.worked_minutes)::integer as worked_minutes,
           sum(su.billable_minutes)::integer as billable_minutes,
           sum(su.review_minutes)::integer as review_minutes,
           coalesce(sum(vv.approved_minutes), 0)::integer as approved_minutes,
           -- 0057: what can still be scheduled is the sum of each authorization's unused time; an authorization over its limit never
           -- reduces another one's. The overage is reported beside it (authorized - committed = remaining - over limit).
           sum(greatest(su.remaining_minutes, 0))::integer as remaining_minutes,
           sum(su.committed_minutes)::integer as committed_minutes,
           sum(su.over_limit_minutes)::integer as over_limit_minutes,
           -- 0067: scheduled = reserved time not yet delivered (ahead + underway), from the reservation ledger in the agency's local month, so a shift that has
           -- already started is shown (F6) and the same reserved minutes feed every screen. Held-for-review and needs-reconciliation are shown apart.
           sum(su.reserved_ahead_minutes + su.reserved_underway_minutes)::integer as scheduled_minutes,
           sum(su.reserved_minutes)::integer as reserved_minutes,
           sum(su.reserved_review_minutes)::integer as held_review_minutes,
           sum(su.reserved_reconcile_minutes)::integer as needs_reconciliation_minutes,
           (count(*) filter (where su.authorization_tier = 'near_limit'))::integer as near_limit_authorizations,
           (count(*) filter (where su.authorization_tier = 'critical'))::integer as critical_authorizations,
           (count(*) filter (where su.expiring_soon))::integer as expiring_authorizations,
           count(*) filter (where lr.hourly_rate_cents is null)::integer as lineages_without_rate,
           round(sum(vv.billable_value))::bigint as billable_value,
           sum(vv.approved_value)::bigint as approved_value,
           round(sum(greatest(su.remaining_minutes, 0)::numeric / 60 * lr.hourly_rate_cents) filter (where lr.hourly_rate_cents is not null))::bigint as unused_value
    from summary su
    left join lineage_rate lr on lr.lineage_id = su.authorization_lineage_id
    left join visit_values vv on vv.lineage_id = su.authorization_lineage_id
    group by su.service_id, su.service_code, su.service_name
  )
  select ps.service_id, ps.service_code, ps.service_name, ps.client_count, ps.authorized_minutes,
         ps.scheduled_minutes, ps.worked_minutes, ps.billable_minutes, ps.review_minutes,
         ps.approved_minutes, ps.remaining_minutes, ps.lineages_without_rate,
         case when ctx.can_see_money then ps.billable_value end,
         case when ctx.can_see_money then ps.approved_value end,
         case when ctx.can_see_money then ps.unused_value end,
         ps.committed_minutes, ps.over_limit_minutes, ps.near_limit_authorizations, ps.critical_authorizations, ps.expiring_authorizations,
         ps.reserved_minutes, ps.held_review_minutes, ps.needs_reconciliation_minutes
  from ctx
  join per_service ps on true
  where ctx.actor is not null and ctx.can_read
  order by ps.service_name, ps.service_code;
$$;

revoke all on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) from public;
revoke all on function ogevia_api.get_utilisation_overview(uuid, date) from public;
grant execute on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) to ogevia_app;
grant execute on function ogevia_api.get_utilisation_overview(uuid, date) to ogevia_app;

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

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours, 'pickups', v_pick, 'reconciliation', v_recon,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;
