-- 0081 Owner corrections to Batch 2 (2026-10-18): pending hours in the scheduling guards, a distinct state for reviews closed as not billable, verified-only CPR/TB,
-- and the worked-not-billable check.
--
-- 1. PENDING HOURS (proved by db/test/pending-hours-guards.db.test.ts, which fails on 0080). The scheduling guards (create_shift, reschedule_shift, the series and
--    make-up evaluators, assign_shift_caregiver and pickup through assert_shift_authorization_covered, care request assignment) compare
--    authorization_month_usage + authorization_month_reserved (+ the new shift) with the monthly cap. 0079 put worked time of an unscheduled visit that awaits
--    confirmation or is in review (no shift, no reservation, nothing billable yet) into Pending on the screens, but it was in neither usage nor reserved, so 560 minutes
--    could be scheduled against 555 left and the authorization ended Over limit. NOW authorization_month_reserved and care_request_reserved_usage add
--    authorization_month_pending_unreserved, built on ONE per-visit definition (visit_unreserved_pending_minutes) that the Hours breakdown also uses, so the screen
--    figure and the guard cannot disagree. No lock, reservation write or idempotency path is touched: every guard already holds the authorization-lineage lock
--    (lock_authorization_lineage) before reading these figures, as before. A closed-not-billable review, an accepted late confirmation, and a visit that holds a reservation
--    are not counted here (the first two consume nothing / are in usage; the last is already in the reservation).
-- 2. CLOSED, NOT BILLABLE. WHY the hold stays: decide_visit_review writes only the decision row; the visit stays in administrator_review and its shift reservation is
--    released only at signing (0013), by cancelling the shift, a series change, or reconcile_ended_shift (which refuses a shift that has a visit). ogevia.reservation_bucket
--    therefore keeps answering 'held_review' for it for ever. Policy-neutral labelling only: ogevia.hours_breakdown separates it (reservation_closed_not_billable) from
--    Pending and reports it as closed_not_billable_held_minutes (counted in Reserved so Authorized still adds up and the guards are unchanged) plus
--    closed_not_billable_worked_minutes (worked time, visible, outside the equation). list_monthly_service_summary gains hours_closed_not_billable_held_minutes and
--    hours_closed_not_billable_worked_minutes; hours_reserved_minutes and hours_left_minutes include the held part. Nothing is released and no billing policy changes.
--    OPEN POLICY QUESTION for the owner: should closing a review as not billable also release its reservation? (docs/releases/2026-10-19-review-updates/HOURS_ACCOUNTING.md)
-- 3. CPR/TB. readiness_checks no longer has the 14-day pending branch: a missing, uploaded-but-unverified (awaiting_review), rejected or expired document is 'blocked'
--    (Blocked when enforcement is active, Warning when report-only). That function is the single gate for create, reschedule, series, make-up, assign, pickup, care request
--    and visit start (assert_ready_for_work), so every path follows. The compliance hold (compliance_blockers, compliance_grace) is unchanged: it still waits for the
--    14 days before it opens a hold automatically. Enforcement is NOT activated by this migration.
-- 4. WORKED, NOT BILLABLE. No code change beyond item 2: time worked beyond the billable minutes arises only when confirmation caps billable at (authorized - usage), i.e.
--    when the authorization is already used up, so it cannot leave room to overbook; a review closed as not billable on an unscheduled visit consumes nothing by design
--    (reported as a policy decision). The exact behaviour is asserted in pending-hours-guards.db.test.ts.
-- Functions only: no table, column or stored row changes. Rollback restores the 0079/0078/0049 definitions.

-- ---------------------------------------------------------------------------
-- 1. Unreserved Pending time (owner correction 1). ONE definition per visit, used by the Hours breakdown and by the scheduling guards.
--    A visit that has ended and awaits confirmation, or is in administrator review with nothing billable, no accepted late confirmation, no review closed as not
--    billable, and NO live reservation in its month, carries worked time that is in no reservation and (until it is confirmed) in no usage. Its worked minutes are
--    consumption: the lineage lock holder who schedules more work must see them.
-- ---------------------------------------------------------------------------
create function ogevia.visit_unreserved_pending_minutes(p_visit_id uuid)
returns integer
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case when v.status in ('awaiting_signature', 'administrator_review')
               and coalesce(v.billable_minutes, 0) = 0
               and not exists (select 1 from ogevia.visit_review_decisions d
                                where d.visit_id = v.id and d.revoked_at is null and d.decision in ('accept_late_confirmation', 'close_not_billable'))
               and not exists (select 1 from ogevia.authorization_reservations r
                                where r.shift_id = v.scheduled_shift_id and r.released_at is null
                                  and r.service_date >= date_trunc('month', v.service_date::timestamp)::date
                                  and r.service_date < (date_trunc('month', v.service_date::timestamp) + interval '1 month')::date)
              then coalesce(v.worked_minutes, 0) else 0 end
  from ogevia.service_visits v
  where v.id = p_visit_id;
$$;
revoke all on function ogevia.visit_unreserved_pending_minutes(uuid) from public;

-- The same figure for the guards: unreserved Pending minutes of one authorization lineage in the agency-local month of p_service_date.
create function ogevia.authorization_month_pending_unreserved(p_lineage_id uuid, p_service_date date)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(sum(ogevia.visit_unreserved_pending_minutes(v.id)), 0)::bigint
  from ogevia.service_visits v
  join ogevia.client_authorizations va on va.id = v.service_authorization_id
  where va.lineage_id = p_lineage_id
    and v.status in ('awaiting_signature', 'administrator_review')
    and v.service_date >= date_trunc('month', p_service_date::timestamp)::date
    and v.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date;
$$;
revoke all on function ogevia.authorization_month_pending_unreserved(uuid, date) from public;

-- Is the shift reservation held for a visit whose review was closed as not billable? (the reservation_bucket answer for it stays 'held_review'.)
create function ogevia.reservation_closed_not_billable(p_reservation_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(ogevia.reservation_bucket(r.id) = 'held_review' and exists (
    select 1 from ogevia.visit_review_decisions d
    where d.visit_id = (select x.id from ogevia.service_visits x where x.scheduled_shift_id = r.shift_id and x.status not in ('voided', 'corrected')
                        order by x.created_at desc limit 1)
      and d.revoked_at is null and d.decision = 'close_not_billable'), false)
  from ogevia.authorization_reservations r
  where r.id = p_reservation_id;
$$;
revoke all on function ogevia.reservation_closed_not_billable(uuid) from public;

-- The scheduling guards (create, reschedule, series, make-up, assign, pickup) read the reserved total through this function; it now also carries the unreserved
-- Pending minutes, so they cannot promise time that completed work has already used. The reservation rows themselves are untouched.
create or replace function ogevia.authorization_month_reserved(p_lineage_id uuid, p_service_date date)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(sum(r.reserved_minutes), 0)::bigint + ogevia.authorization_month_pending_unreserved(p_lineage_id, p_service_date)
  from ogevia.authorization_reservations r
  where r.authorization_lineage_id = p_lineage_id
    and r.released_at is null
    and r.service_date >= date_trunc('month', p_service_date::timestamp)::date
    and r.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
    and not ogevia.reservation_counted_as_used(r.shift_id);
$$;

create or replace function ogevia.care_request_reserved_usage(p_lineage_id uuid, p_service_date date, p_exclude_request_id uuid default null)
returns bigint language sql stable set search_path = ogevia, pg_temp as $$
  select coalesce(sum(r.reserved_minutes),0)::bigint + ogevia.authorization_month_pending_unreserved(p_lineage_id, p_service_date)
  from ogevia.authorization_reservations r
  where r.authorization_lineage_id=p_lineage_id
    and r.released_at is null
    and r.service_date >= date_trunc('month',p_service_date::timestamp)::date
    and r.service_date < (date_trunc('month',p_service_date::timestamp)+interval '1 month')::date
    and r.care_request_id is distinct from p_exclude_request_id
    and not ogevia.reservation_counted_as_used(r.shift_id);
$$;

-- ---------------------------------------------------------------------------
-- 2. ogevia.hours_breakdown (0079) with a closed-not-billable line and the one unreserved-Pending definition.
--    New trailing columns: closed_not_billable_held_minutes (what a closed review still holds: its shift reservation, or billable minutes it still carries; counted in
--    Reserved) and closed_not_billable_worked_minutes (worked time of visits whose review was closed as not billable; visible, outside the equation).
--    in_review_minutes and pending_held_minutes no longer include closed reviews.
-- ---------------------------------------------------------------------------
drop function ogevia.hours_breakdown(uuid, date);
create function ogevia.hours_breakdown(p_organization_id uuid, p_month_start date)
returns table (
  lineage_id uuid,
  signed_minutes integer,
  late_accepted_minutes integer,
  in_review_minutes integer,
  rounding_minutes integer,
  pending_held_minutes integer,
  pending_unreserved_minutes integer,
  reserved_ahead_minutes integer,
  reserved_underway_minutes integer,
  reserved_reconcile_minutes integer,
  worked_not_billable_minutes integer,
  closed_not_billable_held_minutes integer,
  closed_not_billable_worked_minutes integer
)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with bounds as (
    select date_trunc('month', p_month_start::timestamp)::date as m0,
           (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as m1
  ),
  vis as (
    select va.lineage_id, v.id as visit_id, v.status, coalesce(v.worked_minutes, 0) as worked, coalesce(v.billable_minutes, 0) as billable,
           coalesce((select sum(d.accepted_minutes) from ogevia.visit_review_decisions d
                     where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation'), 0)::integer as late_min,
           exists (select 1 from ogevia.visit_review_decisions d
                   where d.visit_id = v.id and d.revoked_at is null and d.decision = 'close_not_billable') as closed_not_billable,
           ogevia.visit_unreserved_pending_minutes(v.id) as unreserved_pending,
           exists (select 1 from ogevia.authorization_reservations r
                   where r.shift_id = v.scheduled_shift_id and r.released_at is null and r.service_date >= b.m0 and r.service_date < b.m1
                     and ogevia.reservation_bucket(r.id) = 'held_review' and not ogevia.reservation_closed_not_billable(r.id)) as held_by_reservation
    from ogevia.service_visits v
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    cross join bounds b
    where v.organization_id = p_organization_id
      and v.service_date >= b.m0 and v.service_date < b.m1
      and v.status in ('signed', 'administrator_review', 'awaiting_signature')
  ),
  vagg as (
    select x.lineage_id,
           coalesce(sum(x.billable) filter (where x.status = 'signed'), 0)::integer as signed_minutes,
           coalesce(sum(x.late_min) filter (where x.status = 'administrator_review'), 0)::integer as late_accepted_minutes,
           coalesce(sum(x.billable) filter (where x.status = 'administrator_review' and not x.closed_not_billable), 0)::integer as in_review_minutes,
           coalesce(sum(x.billable) filter (where x.status = 'administrator_review' and x.closed_not_billable), 0)::integer as closed_carried_minutes,
           coalesce(sum(x.unreserved_pending), 0)::integer as pending_unreserved_minutes,
           coalesce(sum(x.worked) filter (where x.status = 'administrator_review' and x.closed_not_billable), 0)::integer as closed_worked_minutes,
           coalesce(sum(greatest(x.worked - (x.billable + case when x.status = 'administrator_review' then x.late_min else 0 end), 0)) filter (
             where x.status in ('signed', 'administrator_review') and not x.held_by_reservation and x.unreserved_pending = 0), 0)::integer as worked_not_billable_minutes
    from vis x group by x.lineage_id
  ),
  radj as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.adjustment_minutes), 0)::integer as rounding_minutes
    from ogevia.billing_rounding_adjustments r cross join bounds b
    where r.organization_id = p_organization_id and r.voided_at is null and r.service_date >= b.m0 and r.service_date < b.m1
    group by r.authorization_lineage_id
  ),
  res as (
    select r.authorization_lineage_id as lineage_id,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'held_review' and not rb.closed), 0)::integer as pending_held_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'held_review' and rb.closed), 0)::integer as closed_held_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'ahead'), 0)::integer as ahead_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'underway'), 0)::integer as underway_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket in ('unreconciled', 'awaiting_record')), 0)::integer as reconcile_minutes
    from ogevia.authorization_reservations r cross join bounds b
    cross join lateral (select ogevia.reservation_bucket(r.id) as bucket, ogevia.reservation_closed_not_billable(r.id) as closed) rb
    where r.organization_id = p_organization_id and r.released_at is null and r.service_date >= b.m0 and r.service_date < b.m1 and rb.bucket is not null
    group by r.authorization_lineage_id
  ),
  ids as (select vagg.lineage_id from vagg union select radj.lineage_id from radj union select res.lineage_id from res)
  select i.lineage_id,
         coalesce(g.signed_minutes, 0), coalesce(g.late_accepted_minutes, 0), coalesce(g.in_review_minutes, 0), coalesce(a.rounding_minutes, 0),
         coalesce(s.pending_held_minutes, 0), coalesce(g.pending_unreserved_minutes, 0),
         coalesce(s.ahead_minutes, 0), coalesce(s.underway_minutes, 0), coalesce(s.reconcile_minutes, 0),
         coalesce(g.worked_not_billable_minutes, 0),
         (coalesce(g.closed_carried_minutes, 0) + coalesce(s.closed_held_minutes, 0))::integer,
         coalesce(g.closed_worked_minutes, 0)
  from ids i
  left join vagg g on g.lineage_id = i.lineage_id
  left join radj a on a.lineage_id = i.lineage_id
  left join res s on s.lineage_id = i.lineage_id;
$$;
revoke all on function ogevia.hours_breakdown(uuid, date) from public;

-- ---------------------------------------------------------------------------
-- 3. Client details / reports summary (0079) with the closed-not-billable columns; Reserved includes what a closed review still holds.
-- ---------------------------------------------------------------------------
drop function ogevia_api.list_monthly_service_summary(uuid, date, uuid);
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
  reserved_reconcile_minutes integer,
  hours_billable_minutes integer,
  hours_rounding_minutes integer,
  hours_pending_minutes integer,
  hours_pending_review_minutes integer,
  hours_pending_held_minutes integer,
  hours_pending_unreserved_minutes integer,
  hours_reserved_minutes integer,
  hours_left_minutes integer,
  hours_over_limit_minutes integer,
  hours_worked_not_billable_minutes integer,
  hours_closed_not_billable_held_minutes integer,
  hours_closed_not_billable_worked_minutes integer
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
    case when a.monthly_authorized_minutes > 0 then round((100.0 * (coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)+coalesce(hb.closed_not_billable_held_minutes,0)) / a.monthly_authorized_minutes)::numeric, 1)::double precision end,
    ogevia.authorization_tier((coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)+coalesce(hb.closed_not_billable_held_minutes,0)), a.monthly_authorized_minutes),
    (a.period_end - ogevia.organization_local_date(p_organization_id, now())),
    (a.period_end - ogevia.organization_local_date(p_organization_id, now())) between 0 and 30,
    coalesce(rs.ahead_minutes, 0), coalesce(rs.underway_minutes, 0), coalesce(rs.review_minutes, 0), coalesce(rs.reconcile_minutes, 0),
    (coalesce(hb.signed_minutes, 0) + coalesce(hb.late_accepted_minutes, 0))::integer,
    coalesce(hb.rounding_minutes, 0),
    (coalesce(hb.in_review_minutes, 0) + coalesce(hb.pending_held_minutes, 0) + coalesce(hb.pending_unreserved_minutes, 0))::integer,
    coalesce(hb.in_review_minutes, 0),
    coalesce(hb.pending_held_minutes, 0),
    coalesce(hb.pending_unreserved_minutes, 0),
    (coalesce(hb.reserved_ahead_minutes, 0) + coalesce(hb.reserved_underway_minutes, 0) + coalesce(hb.reserved_reconcile_minutes, 0)+coalesce(hb.closed_not_billable_held_minutes,0))::integer,
    (a.monthly_authorized_minutes - (coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)+coalesce(hb.closed_not_billable_held_minutes,0)))::integer,
    greatest((coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)+coalesce(hb.closed_not_billable_held_minutes,0)) - a.monthly_authorized_minutes, 0)::integer,
    coalesce(hb.worked_not_billable_minutes, 0),
    coalesce(hb.closed_not_billable_held_minutes, 0),
    coalesce(hb.closed_not_billable_worked_minutes, 0)
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
  left join ogevia.hours_breakdown(p_organization_id, p_month_start) hb on hb.lineage_id = a.lineage_id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
  order by sv.name, sv.code, a.period_start;
$$;
revoke all on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) from public;
grant execute on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) to ogevia_app;

-- Caregiver Start Visit (0079): the office figure includes the closed hold in Reserved, so left_to_record - pending - reserved = hours_left still holds.
create or replace function ogevia_api.list_caregiver_hours_balances(p_organization_id uuid, p_client_id uuid)
returns table (
  service_id uuid,
  authorization_id uuid,
  left_to_record_minutes bigint,
  hours_left_minutes bigint,
  office_pending_minutes bigint,
  office_reserved_minutes bigint
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor, ogevia.organization_local_date(p_organization_id, now()) as today
  ), hb as (
    select h.* from ctx, ogevia.hours_breakdown(p_organization_id, ctx.today) h
  )
  select s.service_id, s.authorization_id,
         s.monthly_authorized_minutes - ogevia.authorization_month_usage(a.lineage_id, ctx.today),
         s.monthly_authorized_minutes - (coalesce(h.signed_minutes, 0) + coalesce(h.late_accepted_minutes, 0) + coalesce(h.in_review_minutes, 0) + coalesce(h.rounding_minutes, 0)
           + coalesce(h.pending_held_minutes, 0) + coalesce(h.pending_unreserved_minutes, 0)
           + coalesce(h.reserved_ahead_minutes, 0) + coalesce(h.reserved_underway_minutes, 0) + coalesce(h.reserved_reconcile_minutes, 0) + coalesce(h.closed_not_billable_held_minutes, 0)),
         (coalesce(h.pending_held_minutes, 0) + coalesce(h.pending_unreserved_minutes, 0))::bigint,
         (coalesce(h.reserved_ahead_minutes, 0) + coalesce(h.reserved_underway_minutes, 0) + coalesce(h.reserved_reconcile_minutes, 0) + coalesce(h.closed_not_billable_held_minutes, 0))::bigint
  from ctx
  cross join ogevia_api.list_authorized_services_for_client(p_organization_id, p_client_id) s
  join ogevia.client_authorizations a on a.id = s.authorization_id and a.organization_id = p_organization_id
  left join hb h on h.lineage_id = a.lineage_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. CPR / TB: verified and current only (0078 definition without the 14-day pending branch).
-- ---------------------------------------------------------------------------
create or replace function ogevia.readiness_checks(p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone, p_context text DEFAULT 'shift'::text, p_exclude_shift uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid, p_with_conflict boolean DEFAULT false)
 RETURNS TABLE(check_name text, status text, code text, message text, enforced boolean)
 LANGUAGE plpgsql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_st text;
  d record;
  i record;
  v_ov boolean;
  v_bg text;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if p_context = 'assignment' then
    -- A standing assignment may be prepared for a caregiver who is not Ready yet; it grants nothing until they are.
    null;
  elsif v_rec.id is null or v_rec.status not in ('ready', 'active') then
    return query select 'caregiver'::text, 'blocked'::text, 'caregiver_not_active'::text, ogevia.readiness_message('caregiver', null), true;
  else
    return query select 'caregiver'::text, 'ok'::text, null::text, null::text, true;
  end if;

  if p_context <> 'visit_start' and v_rec.id is not null and v_rec.onboarding_required then
    declare v_open text[];
    begin
      v_open := ogevia.onboarding_outstanding(p_organization_id, v_rec.id, false);
      if cardinality(v_open) > 0 then
        return query select 'onboarding'::text, 'blocked'::text, 'onboarding_incomplete'::text,
          ('Onboarding incomplete: ' || array_to_string(v_open, ', ') || '.')::text, true;
      else
        return query select 'onboarding'::text, 'ok'::text, null::text, null::text, true;
      end if;
    end;
  end if;

  -- Background-check clearance (0055): only a VERIFIED APPROVED result qualifies. "Completed" alone never does.
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg = 'approved' then
    return query select 'background'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'background', p_context);
  else
    return query select 'background'::text, 'blocked'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg),
                        ogevia.readiness_enforced(p_organization_id, 'background', p_context);
  end if;

  if p_service_id is null then
    return query select 'service'::text, 'not_checked'::text, null::text, null::text, false;
  else
    v_st := ogevia.service_approval_status(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends);
    return query select 'service'::text, case when v_st = 'approved' then 'ok' else 'blocked' end,
                        case when v_st = 'approved' then null else 'service_' || v_st end,
                        case when v_st = 'approved' then null else ogevia.readiness_message('service', 'service_' || v_st) end,
                        ogevia.readiness_enforced(p_organization_id, 'service', p_context);
  end if;

  -- CPR / TB (0081, owner correction): ONLY a VERIFIED, CURRENT document qualifies. A document that is missing, uploaded but still awaiting review, rejected, expired,
  -- expiring before the work ends, without an expiry date, or whose agency rule/type is not set up all produce the same result: status 'blocked' (Blocked when
  -- enforcement is active, a Warning while the agency is report-only). The 14-day period from the hire date (0055) no longer lets work go ahead; it still governs only
  -- when an automatic compliance HOLD is opened (ogevia.compliance_blockers, unchanged). The period is no longer read here.
  for d in select * from ogevia.document_readiness(p_organization_id, p_caregiver_record_id, p_starts, p_ends) loop
    return query select d.requirement, case when d.status = 'ok' then 'ok' else 'blocked' end,
                        case when d.status = 'ok' then null else d.status end,
                        case when d.status = 'ok' then null else ogevia.readiness_message(d.requirement, d.status) end,
                        ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
  end loop;

  if p_context in ('shift', 'care_request', 'reschedule', 'series', 'visit_start') then
    v_st := ogevia.availability_status(p_organization_id, p_caregiver_record_id, p_starts, p_ends);
    if v_st = 'covered' then
      return query select 'availability'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
    else
      v_ov := ogevia.availability_override_for(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_context, p_client_id) is not null;
      if v_ov then
        return query select 'availability'::text, 'overridden'::text, 'availability_override'::text,
                            ogevia.readiness_message('availability', 'availability_override'), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      else
        return query select 'availability'::text, 'blocked'::text, 'availability_' || v_st,
                            ogevia.readiness_message('availability', 'availability_' || v_st), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      end if;
    end if;
  end if;

  if p_context in ('shift', 'care_request', 'reschedule', 'series') and v_rec.id is not null then
    declare
      v_lim ogevia.caregiver_hour_limits%rowtype;
      v_issue text;
      h record;
      v_tz text;
      v_date date;
      v_min integer;
    begin
      v_lim := ogevia.effective_hour_limit(p_organization_id, p_caregiver_record_id);
      if v_lim.id is not null then
        select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
        v_date := (p_starts at time zone v_tz)::date;
        v_min := floor(extract(epoch from (p_ends - p_starts)) / 60)::integer;
        select * into h from ogevia.hour_limit_detail(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_exclude_shift);
        v_issue := h.issue;
        if v_issue is null then
          return query select 'hours'::text, 'ok'::text, null::text, null::text, v_lim.mode = 'block';
        else
          return query select 'hours'::text, 'blocked'::text, v_issue || '_hour_limit', ogevia.hour_limit_message(h.issue, h.actual_minutes, h.allowed_minutes), v_lim.mode = 'block';
        end if;
      end if;
    end;
  end if;

  if p_with_conflict then
    if exists (
      select 1 from ogevia.shifts s
      where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
        and (s.caregiver_record_id = p_caregiver_record_id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
        and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
        and s.starts_at < p_ends and s.ends_at > p_starts) then
      return query select 'conflict'::text, 'blocked'::text, 'already_booked'::text, ogevia.readiness_message('conflict', null), true;
    else
      return query select 'conflict'::text, 'ok'::text, null::text, null::text, true;
    end if;
  end if;

  if p_client_id is not null then
    for i in select * from ogevia.client_requirement_issues(p_organization_id, p_client_id, p_caregiver_record_id) loop
      return query select 'client'::text, 'blocked'::text, i.code, coalesce(i.message, ogevia.readiness_message('client', null)),
                          ogevia.readiness_enforced(p_organization_id, 'client', p_context);
    end loop;
  end if;
end;
$$;
