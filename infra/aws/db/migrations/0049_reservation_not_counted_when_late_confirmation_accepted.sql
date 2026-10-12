-- 0049 Authorization accounting: a minute is counted once, as USED or as RESERVED (defect F1).
--
-- Defect (reproduced in db/test/authorization-accounting-risks.db.test.ts): a visit linked to a scheduled shift, left in
-- administrator_review, whose late confirmation was ACCEPTED, was counted as used (accepted minutes, 0036) AND its shift's
-- reservation stayed in the reserved total, because a reservation is released only when the visit becomes 'signed' (0013).
-- 45 minutes of care counted 165 of 600 minutes.
--
-- Rule (one definition, ogevia.reservation_counted_as_used): a reservation is NOT part of the reserved total while its
-- shift has a linked visit that is in administrator_review with an ACTIVE (not revoked) accept_late_confirmation decision.
-- Those are exactly the conditions under which authorization_month_usage counts the accepted minutes as used, so every
-- minute is in one bucket. The reservation row is not released, deleted or changed: revoking the decision makes the
-- condition false and the reservation counts as reserved again, with the minutes no longer used.
--
-- Changes (CREATE OR REPLACE FUNCTION only; no table, column, index, trigger, permission or stored row changes):
--   * NEW internal function ogevia.reservation_counted_as_used(uuid) (no execute grant: default privileges, 0001).
--   * ogevia.authorization_month_reserved (0026): adds the exclusion. Used by create_shift, reschedule_shift, series_evaluate
--     and the assignment paths.
--   * ogevia.care_request_reserved_usage (0011): adds the exclusion (assignment cap).
--   * ogevia_api.list_monthly_service_summary (0036): the reserved CTE adds the exclusion (reports and the dashboard).
-- Everything else in the three functions is unchanged.

create or replace function ogevia.reservation_counted_as_used(p_shift_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1
    from ogevia.service_visits v
    join ogevia.visit_review_decisions d on d.visit_id = v.id
    where v.scheduled_shift_id = p_shift_id
      and v.status = 'administrator_review'
      and d.revoked_at is null
      and d.decision = 'accept_late_confirmation'
  );
$$;

create or replace function ogevia.authorization_month_reserved(p_lineage_id uuid, p_service_date date)
returns bigint
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(sum(r.reserved_minutes), 0)::bigint
  from ogevia.authorization_reservations r
  where r.authorization_lineage_id = p_lineage_id
    and r.released_at is null
    and r.service_date >= date_trunc('month', p_service_date::timestamp)::date
    and r.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
    and not ogevia.reservation_counted_as_used(r.shift_id);
$$;

create or replace function ogevia.care_request_reserved_usage(p_lineage_id uuid, p_service_date date, p_exclude_request_id uuid default null)
returns bigint language sql stable set search_path = ogevia, pg_temp as $$
  select coalesce(sum(r.reserved_minutes),0)::bigint
  from ogevia.authorization_reservations r
  where r.authorization_lineage_id=p_lineage_id
    and r.released_at is null
    and r.service_date >= date_trunc('month',p_service_date::timestamp)::date
    and r.service_date < (date_trunc('month',p_service_date::timestamp)+interval '1 month')::date
    and r.care_request_id is distinct from p_exclude_request_id
    and not ogevia.reservation_counted_as_used(r.shift_id);
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
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.reserved_minutes), 0)::integer as reserved_minutes
    from ogevia.authorization_reservations r
    cross join bounds b
    where r.organization_id = p_organization_id
      and r.released_at is null
      and r.service_date >= b.month_start
      and r.service_date < b.month_end
      and not ogevia.reservation_counted_as_used(r.shift_id)
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

