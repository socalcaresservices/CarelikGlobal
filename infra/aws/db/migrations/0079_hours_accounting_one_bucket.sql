-- 0079 Hours accounting: every minute of an authorization belongs to exactly one bucket (owner requirement 2.2), and the caregiver and office balances use the same records (2.3).
--
-- THE EQUATION, per authorization (authorization lineage) and agency-local month:
--     Authorized = Billable + Rounding + Pending + Reserved + Hours left        (Hours left is SIGNED; when negative the amount is shown as "Over limit")
--   Billable  confirmed billable minutes of signed visits + minutes accepted from a late confirmation.
--   Rounding  approved billing rounding adjustments (0029), net of voids; positive or negative; counted once, shown on its own line.
--   Pending   worked but not yet billable: (a) billable minutes carried by a visit that is in administrator review (counted as used since 0036/0052),
--             (b) shift time held while the linked visit is awaiting confirmation or in review with nothing billable (0067 "held_review"),
--             (c) NEW: worked minutes of an ended visit that is awaiting confirmation or in review, carries no billable minutes and holds no reservation
--                 (an unscheduled visit, or one whose shift reservation was released). Before 0079 these minutes were in NO bucket.
--   Reserved  scheduled time not yet delivered: ahead + underway + awaiting a person's reconciliation (0067). Held-for-review moved to Pending.
--   Hours left  authorized minus all of the above. Computed PER AUTHORIZATION; never netted against another authorization's unused time. On a total across
--             authorizations, Hours left sums only authorizations that still have time and Over limit sums those that are over, side by side, not offset.
-- RECONCILIATION LINE (outside the equation, never hidden): "Worked, not billable" = worked minutes of signed and in-review visits beyond what is counted as
--   Billable or Pending (the billing cap, an exhausted authorization, a review closed as not billable). Actual worked time is never redefined as capped billable time.
-- Old columns (billable, remaining, committed, over_limit, reserved_* ...) keep their exact meaning; the new columns are hours_*.
-- Caregiver vs office (2.3): the caregiver's "left to record" is authorized minus authorization_month_usage (Billable + Rounding + Pending-in-review), the room the cap
--   is applied against at confirmation. The office "Hours left" also deducts shift time held for review, unscheduled pending time and Reserved (scheduled) time.
--   Both are now computed on the server from the same function (ogevia.hours_breakdown); the screens only display them.
-- ogevia.reservation_bucket: a reservation whose linked visit is already signed is in no bucket (it is Billable); defensive, current flows release it at signing.
-- Concurrency: nothing here takes or changes a lock; reservation creation, the lineage lock order and the confirmation-time cap are untouched.
-- Rollback (SAFE AUTOMATED, functions only): restores the 0067/0071/0070/0027 definitions and drops the new functions.

-- One row per authorization lineage with the records behind each bucket, for the agency-local month of p_month_start. Internal (no grant).
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
  worked_not_billable_minutes integer
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
    select va.lineage_id, v.status, coalesce(v.worked_minutes, 0) as worked, coalesce(v.billable_minutes, 0) as billable,
           coalesce((select sum(d.accepted_minutes) from ogevia.visit_review_decisions d
                     where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation'), 0)::integer as late_min,
           exists (select 1 from ogevia.visit_review_decisions d
                   where d.visit_id = v.id and d.revoked_at is null and d.decision = 'close_not_billable') as closed_not_billable,
           exists (select 1 from ogevia.authorization_reservations r
                   where r.shift_id = v.scheduled_shift_id and r.released_at is null and r.service_date >= b.m0 and r.service_date < b.m1) as has_live_reservation,
           exists (select 1 from ogevia.authorization_reservations r
                   where r.shift_id = v.scheduled_shift_id and r.released_at is null and r.service_date >= b.m0 and r.service_date < b.m1
                     and ogevia.reservation_bucket(r.id) = 'held_review') as held_by_reservation
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
           coalesce(sum(x.billable) filter (where x.status = 'administrator_review'), 0)::integer as in_review_minutes,
           coalesce(sum(x.worked) filter (
             where x.status in ('awaiting_signature', 'administrator_review') and x.billable = 0 and x.late_min = 0
               and not x.closed_not_billable and not x.has_live_reservation), 0)::integer as pending_unreserved_minutes,
           coalesce(sum(greatest(x.worked - (x.billable + case when x.status = 'administrator_review' then x.late_min else 0 end), 0)) filter (
             where x.status in ('signed', 'administrator_review') and not x.held_by_reservation
               and not (x.status = 'administrator_review' and x.billable = 0 and x.late_min = 0 and not x.closed_not_billable and not x.has_live_reservation)), 0)::integer as worked_not_billable_minutes
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
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'held_review'), 0)::integer as pending_held_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'ahead'), 0)::integer as ahead_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket = 'underway'), 0)::integer as underway_minutes,
           coalesce(sum(r.reserved_minutes) filter (where rb.bucket in ('unreconciled', 'awaiting_record')), 0)::integer as reconcile_minutes
    from ogevia.authorization_reservations r cross join bounds b
    cross join lateral (select ogevia.reservation_bucket(r.id) as bucket) rb
    where r.organization_id = p_organization_id and r.released_at is null and r.service_date >= b.m0 and r.service_date < b.m1 and rb.bucket is not null
    group by r.authorization_lineage_id
  ),
  ids as (select vagg.lineage_id from vagg union select radj.lineage_id from radj union select res.lineage_id from res)
  select i.lineage_id,
         coalesce(g.signed_minutes, 0), coalesce(g.late_accepted_minutes, 0), coalesce(g.in_review_minutes, 0), coalesce(a.rounding_minutes, 0),
         coalesce(s.pending_held_minutes, 0), coalesce(g.pending_unreserved_minutes, 0),
         coalesce(s.ahead_minutes, 0), coalesce(s.underway_minutes, 0), coalesce(s.reconcile_minutes, 0),
         coalesce(g.worked_not_billable_minutes, 0)
  from ids i
  left join vagg g on g.lineage_id = i.lineage_id
  left join radj a on a.lineage_id = i.lineage_id
  left join res s on s.lineage_id = i.lineage_id;
$$;
revoke all on function ogevia.hours_breakdown(uuid, date) from public;

create or replace function ogevia.reservation_bucket(p_reservation_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when r.released_at is not null then null
    when ogevia.reservation_counted_as_used(r.shift_id) then null
    when v.status = 'signed' then null -- 0079: a signed visit is already counted as Billable; a reservation it left behind is never also held (defensive: 0013 releases it at signing)
    when v.id is not null then case when v.status = 'draft' then 'underway' else 'held_review' end
    when s.status = 'scheduled' and s.starts_at > now() then 'ahead'
    when s.status = 'scheduled' and s.ends_at >= now() then 'underway'
    when (select d.outcome from ogevia.shift_reconciliations d where d.shift_id = r.shift_id order by d.decided_at desc, d.id desc limit 1) in ('hold_service_may_have_occurred', 'delivered_unverified') then 'awaiting_record'
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

drop function ogevia_api.get_monthly_chain_report(uuid, date, uuid);
drop function ogevia_api.get_utilisation_overview(uuid, date);
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
  hours_worked_not_billable_minutes integer
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
    case when a.monthly_authorized_minutes > 0 then round((100.0 * (coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)) / a.monthly_authorized_minutes)::numeric, 1)::double precision end,
    ogevia.authorization_tier((coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)), a.monthly_authorized_minutes),
    (a.period_end - ogevia.organization_local_date(p_organization_id, now())),
    (a.period_end - ogevia.organization_local_date(p_organization_id, now())) between 0 and 30,
    coalesce(rs.ahead_minutes, 0), coalesce(rs.underway_minutes, 0), coalesce(rs.review_minutes, 0), coalesce(rs.reconcile_minutes, 0),
    (coalesce(hb.signed_minutes, 0) + coalesce(hb.late_accepted_minutes, 0))::integer,
    coalesce(hb.rounding_minutes, 0),
    (coalesce(hb.in_review_minutes, 0) + coalesce(hb.pending_held_minutes, 0) + coalesce(hb.pending_unreserved_minutes, 0))::integer,
    coalesce(hb.in_review_minutes, 0),
    coalesce(hb.pending_held_minutes, 0),
    coalesce(hb.pending_unreserved_minutes, 0),
    (coalesce(hb.reserved_ahead_minutes, 0) + coalesce(hb.reserved_underway_minutes, 0) + coalesce(hb.reserved_reconcile_minutes, 0))::integer,
    (a.monthly_authorized_minutes - (coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)))::integer,
    greatest((coalesce(hb.signed_minutes,0)+coalesce(hb.late_accepted_minutes,0)+coalesce(hb.in_review_minutes,0)+coalesce(hb.rounding_minutes,0)+coalesce(hb.pending_held_minutes,0)+coalesce(hb.pending_unreserved_minutes,0)+coalesce(hb.reserved_ahead_minutes,0)+coalesce(hb.reserved_underway_minutes,0)+coalesce(hb.reserved_reconcile_minutes,0)) - a.monthly_authorized_minutes, 0)::integer,
    coalesce(hb.worked_not_billable_minutes, 0)
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
  needs_reconciliation_minutes integer,
  hours_billable_minutes integer,
  hours_rounding_minutes integer,
  hours_pending_minutes integer,
  hours_reserved_minutes integer,
  hours_left_minutes integer,
  hours_over_limit_minutes integer,
  hours_worked_not_billable_minutes integer
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
           -- 0079: the same buckets as the per-authorization rows. hours_left sums ONLY the authorizations that still have time left and hours_over_limit sums
           -- the authorizations that are over; they are never netted against each other (an overage on one authorization does not use another one's time).
           sum(su.hours_billable_minutes)::integer as hours_billable_minutes,
           sum(su.hours_rounding_minutes)::integer as hours_rounding_minutes,
           sum(su.hours_pending_minutes)::integer as hours_pending_minutes,
           sum(su.hours_reserved_minutes)::integer as hours_reserved_minutes,
           sum(greatest(su.hours_left_minutes, 0))::integer as hours_left_minutes,
           sum(su.hours_over_limit_minutes)::integer as hours_over_limit_minutes,
           sum(su.hours_worked_not_billable_minutes)::integer as hours_worked_not_billable_minutes,
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
         ps.reserved_minutes, ps.held_review_minutes, ps.needs_reconciliation_minutes,
         ps.hours_billable_minutes, ps.hours_rounding_minutes, ps.hours_pending_minutes, ps.hours_reserved_minutes, ps.hours_left_minutes, ps.hours_over_limit_minutes,
         ps.hours_worked_not_billable_minutes
  from ctx
  join per_service ps on true
  where ctx.actor is not null and ctx.can_read
  order by ps.service_name, ps.service_code;
$$;
revoke all on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) from public;
revoke all on function ogevia_api.get_utilisation_overview(uuid, date) from public;
grant execute on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) to ogevia_app;
grant execute on function ogevia_api.get_utilisation_overview(uuid, date) to ogevia_app;

create function ogevia_api.get_monthly_chain_report(p_organization_id uuid, p_month_start date, p_client_id uuid default null)
returns table (
  client_id uuid, client_code text, service_id uuid, service_code text, service_name text,
  authorization_lineage_id uuid, authorization_version integer, period_start date, period_end date,
  authorized_minutes integer,
  scheduled_minutes integer, held_review_minutes integer, needs_reconciliation_minutes integer, reserved_minutes integer,
  worked_minutes integer, confirmed_minutes integer, billable_minutes integer,
  needs_correction_minutes integer, waiting_minutes integer, ready_for_review_minutes integer, approved_for_billing_minutes integer, reviewed_not_billable_minutes integer,
  human_approved_minutes integer,
  needs_correction_visits integer, waiting_visits integer, ready_for_review_visits integer, approved_visits integer, voided_approvals integer,
  adjustment_minutes integer, committed_minutes integer, remaining_minutes integer, over_limit_minutes integer,
  reserved_ok boolean, visits_ok boolean, balance_ok boolean, difference_minutes integer,
  hours_billable_minutes integer, hours_rounding_minutes integer, hours_pending_minutes integer, hours_reserved_minutes integer,
  hours_left_minutes integer, hours_over_limit_minutes integer, hours_worked_not_billable_minutes integer, hours_balance_ok boolean
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.has_permission(p_organization_id, 'billing.visits.read') as can_bill,
           date_trunc('month', p_month_start::timestamp)::date as m0,
           (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as m1
  ),
  s as (select su.* from ctx, ogevia_api.list_monthly_service_summary(p_organization_id, ctx.m0, p_client_id) su),
  vs as (
    select va.lineage_id, v.id as visit_id, ogevia.visit_billing_state(v.id) as st,
           (v.billable_minutes + coalesce((select sum(d.accepted_minutes) from ogevia.visit_review_decisions d
                                           where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation'), 0))::integer as eligible
    from ctx
    join ogevia.service_visits v on v.organization_id = p_organization_id and v.service_date >= ctx.m0 and v.service_date < ctx.m1
     and v.status in ('signed', 'administrator_review') and (p_client_id is null or v.client_id = p_client_id)
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
  ),
  agg as (
    select vs.lineage_id,
           coalesce(sum(eligible) filter (where st = 'needs_correction'), 0)::integer as needs_correction_minutes,
           coalesce(sum(eligible) filter (where st in ('waiting_for_signature', 'late_response_to_review')), 0)::integer as waiting_minutes,
           coalesce(sum(eligible) filter (where st in ('ready_for_review', 'voided')), 0)::integer as ready_minutes,
           coalesce(sum(eligible) filter (where st = 'approved_for_billing'), 0)::integer as approved_minutes,
           coalesce(sum(eligible) filter (where st = 'reviewed_not_billable'), 0)::integer as not_billable_minutes,
           coalesce(sum(eligible), 0)::integer as all_minutes,
           count(*) filter (where st = 'needs_correction')::integer as needs_correction_visits,
           count(*) filter (where st in ('waiting_for_signature', 'late_response_to_review'))::integer as waiting_visits,
           count(*) filter (where st in ('ready_for_review', 'voided'))::integer as ready_visits,
           count(*) filter (where st = 'approved_for_billing')::integer as approved_visits,
           count(*) filter (where st = 'voided')::integer as voided_visits
    from vs group by vs.lineage_id
  ),
  human as (
    select va.lineage_id, coalesce(sum(b.approved_minutes), 0)::integer as minutes
    from ctx
    join ogevia.billing_approvals b on b.organization_id = p_organization_id and b.voided_at is null
    join ogevia.service_visits v on v.id = b.visit_id and v.service_date >= ctx.m0 and v.service_date < ctx.m1 and (p_client_id is null or v.client_id = p_client_id)
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    group by va.lineage_id
  )
  select s.client_id, s.client_code, s.service_id, s.service_code, s.service_name,
         s.authorization_lineage_id, (select a.version_number from ogevia.client_authorizations a where a.lineage_id = s.authorization_lineage_id and a.is_current limit 1),
         s.authorization_period_start, s.authorization_period_end,
         s.authorized_minutes,
         s.reserved_ahead_minutes + s.reserved_underway_minutes, s.reserved_review_minutes, s.reserved_reconcile_minutes, s.reserved_minutes,
         s.worked_minutes, s.verified_minutes, s.billable_minutes,
         coalesce(g.needs_correction_minutes, 0), coalesce(g.waiting_minutes, 0),
         case when ctx.can_bill then coalesce(g.ready_minutes, 0) end, case when ctx.can_bill then coalesce(g.approved_minutes, 0) end, coalesce(g.not_billable_minutes, 0),
         case when ctx.can_bill then coalesce(h.minutes, 0) end,
         coalesce(g.needs_correction_visits, 0), coalesce(g.waiting_visits, 0),
         case when ctx.can_bill then coalesce(g.ready_visits, 0) end, case when ctx.can_bill then coalesce(g.approved_visits, 0) end, case when ctx.can_bill then coalesce(g.voided_visits, 0) end,
         s.adjustment_minutes, s.committed_minutes, s.remaining_minutes, s.over_limit_minutes,
         s.reserved_minutes = s.reserved_ahead_minutes + s.reserved_underway_minutes + s.reserved_review_minutes + s.reserved_reconcile_minutes,
         case when ctx.can_bill then s.billable_minutes = coalesce(g.all_minutes, 0) end,
         s.authorized_minutes = s.billable_minutes + s.adjustment_minutes + s.reserved_minutes + s.remaining_minutes,
         (s.authorized_minutes - (s.billable_minutes + s.adjustment_minutes + s.reserved_minutes + s.remaining_minutes))
         + (s.reserved_minutes - (s.reserved_ahead_minutes + s.reserved_underway_minutes + s.reserved_review_minutes + s.reserved_reconcile_minutes))
         + case when ctx.can_bill then s.billable_minutes - coalesce(g.all_minutes, 0) else 0 end
         , s.hours_billable_minutes, s.hours_rounding_minutes, s.hours_pending_minutes, s.hours_reserved_minutes,
         s.hours_left_minutes, s.hours_over_limit_minutes, s.hours_worked_not_billable_minutes,
         s.authorized_minutes = s.hours_billable_minutes + s.hours_rounding_minutes + s.hours_pending_minutes + s.hours_reserved_minutes + s.hours_left_minutes
  from ctx, s
  left join agg g on g.lineage_id = s.authorization_lineage_id
  left join human h on h.lineage_id = s.authorization_lineage_id
  where ctx.actor is not null
  order by s.client_code, s.service_name, s.authorization_period_start;
$$;
revoke all on function ogevia_api.get_monthly_chain_report(uuid, date, uuid) from public;
grant execute on function ogevia_api.get_monthly_chain_report(uuid, date, uuid) to ogevia_app;

create or replace function ogevia_api.create_continuity_pack(p_organization_id uuid, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.continuity_guard(p_organization_id);
  v_names boolean := ogevia.has_permission(p_organization_id, 'clients.names.read');
  v_org ogevia.organizations%rowtype;
  v_now timestamptz := now();
  v_today date;
  v_exp ogevia.continuity_exports%rowtype;
  v_first integer;
  v_shifts jsonb;
  v_clients jsonb;
  v_auths jsonb;
  v_care jsonb;
begin
  if p_request_key is null then
    raise exception 'A request key is required' using errcode = 'OGV22';
  end if;
  select * into v_org from ogevia.organizations o where o.id = p_organization_id;
  v_today := (v_now at time zone v_org.timezone)::date;

  select coalesce(jsonb_agg(x order by x ->> 'starts_at', x ->> 'client_code'), '[]') into v_shifts from (
    select jsonb_build_object(
             'local_date', (s.starts_at at time zone v_org.timezone)::date,
             'start', to_char(s.starts_at at time zone v_org.timezone, 'HH24:MI'),
             'end', to_char(s.ends_at at time zone v_org.timezone, 'HH24:MI'),
             'starts_at', s.starts_at,
             'client_code', c.client_code,
             'client_label', c.caregiver_display_code,
             'client_name', case when v_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
             'service', sv.name,
             'caregiver', case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end,
             'caregiver_code', cr.caregiver_code,
             'coverage', ogevia.shift_coverage_state(s)) as x
    from ogevia.shifts s
    join ogevia.clients c on c.id = s.client_id
    left join ogevia.services sv on sv.id = s.service_id
    left join ogevia.caregiver_records cr on cr.organization_id = s.organization_id and cr.deleted_at is null
      and (cr.id = s.caregiver_record_id or (s.caregiver_record_id is null and cr.linked_user_id = s.caregiver_user_id))
    left join ogevia.client_private_names n on n.client_id = c.id
    where s.organization_id = p_organization_id and s.status = 'scheduled'
      and s.ends_at > v_now and s.starts_at < v_now + interval '14 days'
  ) q;

  select coalesce(jsonb_agg(x order by x ->> 'client_code'), '[]') into v_clients from (
    select jsonb_build_object(
             'client_code', c.client_code,
             'client_label', c.caregiver_display_code,
             'city', c.city,
             'client_name', case when v_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end) as x
    from ogevia.clients c
    left join ogevia.client_private_names n on n.client_id = c.id
    where c.organization_id = p_organization_id and c.deleted_at is null and c.status = 'active'
  ) q;

  select coalesce(jsonb_agg(x order by x ->> 'client_code', x ->> 'service'), '[]') into v_auths from (
    select jsonb_build_object(
             'client_code', c.client_code,
             'client_label', c.caregiver_display_code,
             'service', m.service_name,
             'period_start', m.authorization_period_start,
             'period_end', m.authorization_period_end,
             'authorized_minutes', m.authorized_minutes,
             'reserved_minutes', m.reserved_minutes,
             'billable_minutes', m.billable_minutes,
             'review_minutes', m.review_minutes,
             'remaining_minutes', m.remaining_minutes,
             'hours_billable_minutes', m.hours_billable_minutes,
             'hours_rounding_minutes', m.hours_rounding_minutes,
             'hours_pending_minutes', m.hours_pending_minutes,
             'hours_reserved_minutes', m.hours_reserved_minutes,
             'hours_left_minutes', m.hours_left_minutes,
             'hours_over_limit_minutes', m.hours_over_limit_minutes,
             'hours_worked_not_billable_minutes', m.hours_worked_not_billable_minutes) as x
    from ogevia_api.list_monthly_service_summary(p_organization_id, date_trunc('month', v_today::timestamp)::date, null) m
    join ogevia.clients c on c.id = m.client_id and c.organization_id = p_organization_id
  ) q;

  select coalesce(jsonb_agg(x order by x ->> 'caregiver_code'), '[]') into v_care from (
    select jsonb_build_object(
             'caregiver_code', cr.caregiver_code,
             'name', coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name,
             'status', cr.status::text) as x
    from ogevia.caregiver_records cr
    where cr.organization_id = p_organization_id and cr.deleted_at is null and cr.status::text <> 'inactive'
  ) q;

  -- One number block per request; concurrent downloads in one agency never share numbers.
  perform pg_advisory_xact_lock(hashtextextended('ogevia.continuity:' || p_organization_id::text, 0));
  select * into v_exp from ogevia.continuity_exports e
  where e.organization_id = p_organization_id and e.request_key = p_request_key;
  if v_exp.id is null then
    select coalesce(max(e.outage_number_last), 0) + 1 into v_first
    from ogevia.continuity_exports e where e.organization_id = p_organization_id;
    insert into ogevia.continuity_exports (organization_id, exported_by, request_key, data_as_of, outage_number_first,
      outage_number_last, shift_count, client_count, authorization_count, caregiver_count, includes_client_names)
    values (p_organization_id, v_actor, p_request_key, v_now, v_first, v_first + 24,
      jsonb_array_length(v_shifts), jsonb_array_length(v_clients), jsonb_array_length(v_auths), jsonb_array_length(v_care), v_names)
    returning * into v_exp;
    perform ogevia.write_audit(p_organization_id, 'continuity.pack_downloaded', 'continuity_export', v_exp.id, null,
      jsonb_build_object('data_as_of', v_now, 'outage_numbers', v_exp.outage_number_first || '-' || v_exp.outage_number_last,
                         'shifts', v_exp.shift_count, 'clients', v_exp.client_count, 'authorizations', v_exp.authorization_count,
                         'caregivers', v_exp.caregiver_count, 'client_names', v_names));
  elsif v_exp.exported_by <> v_actor then
    raise exception 'This request key belongs to another download' using errcode = 'OGC09';
  end if;

  return jsonb_build_object(
    'agency', v_org.display_name,
    'timezone', v_org.timezone,
    'data_as_of', v_now,
    'export_id', v_exp.id,
    'exported_by', (select coalesce(u.display_name, 'Staff') from ogevia.app_users u where u.id = v_actor),
    'includes_client_names', v_names,
    'outage_numbers', jsonb_build_object('first', v_exp.outage_number_first, 'last', v_exp.outage_number_last),
    'shifts', v_shifts,
    'clients', v_clients,
    'authorizations', v_auths,
    'caregivers', v_care);
end;
$$;

-- ---------------------------------------------------------------------------
-- Caregiver Start Visit balance (2.3): computed on the server from the same records as the office figure.
--   left_to_record_minutes  = authorized - authorization_month_usage (Billable + Rounding + Pending in review): the room the cap uses at confirmation.
--   hours_left_minutes      = the office Hours left (also deducts shift time held for review, unscheduled pending time and Reserved/scheduled time).
--   office_pending_minutes + office_reserved_minutes = left_to_record - hours_left (the intentional difference, shown to the caregiver as a label).
-- NEW functions, so the 0006/0014/0015 functions (and their rollbacks) keep their return types. Both reuse the existing access rules by selecting from
-- list_authorized_services_for_client / get_active_service_visit: a caller sees a balance only for a service or visit those functions already return.
-- ---------------------------------------------------------------------------
create function ogevia_api.list_caregiver_hours_balances(p_organization_id uuid, p_client_id uuid)
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
           + coalesce(h.reserved_ahead_minutes, 0) + coalesce(h.reserved_underway_minutes, 0) + coalesce(h.reserved_reconcile_minutes, 0)),
         (coalesce(h.pending_held_minutes, 0) + coalesce(h.pending_unreserved_minutes, 0))::bigint,
         (coalesce(h.reserved_ahead_minutes, 0) + coalesce(h.reserved_underway_minutes, 0) + coalesce(h.reserved_reconcile_minutes, 0))::bigint
  from ctx
  cross join ogevia_api.list_authorized_services_for_client(p_organization_id, p_client_id) s
  join ogevia.client_authorizations a on a.id = s.authorization_id and a.organization_id = p_organization_id
  left join hb h on h.lineage_id = a.lineage_id;
$$;

create function ogevia_api.get_active_visit_balance(p_organization_id uuid)
returns table (visit_id uuid, left_to_record_minutes bigint)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select v.visit_id, v.monthly_authorized_minutes - v.confirmed_minutes_this_month
  from ogevia_api.get_active_service_visit(p_organization_id) v;
$$;

revoke all on function ogevia_api.list_caregiver_hours_balances(uuid, uuid) from public;
revoke all on function ogevia_api.get_active_visit_balance(uuid) from public;
grant execute on function ogevia_api.list_caregiver_hours_balances(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_active_visit_balance(uuid) to ogevia_app;
