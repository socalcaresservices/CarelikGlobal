-- ROLLBACK 0029_billing_rounding | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any rounding policy version or rounding adjustment exists: the
-- dated policy history and the approved adjustments are billing records. Otherwise
-- restores the usage and monthly-summary functions exactly as before 0029 and
-- removes the rounding objects. Visits and visit billing approvals are untouched.
do $$ begin
  if exists (select 1 from ogevia.billing_rounding_policies) or exists (select 1 from ogevia.billing_rounding_adjustments) then
    raise exception 'ROLLBACK REFUSED: billing rounding policies or adjustments exist; export them first (they would be lost)';
  end if;
end $$;
drop trigger if exists billing_approvals_rounding_guard on ogevia.billing_approvals;
drop function if exists ogevia.billing_approvals_rounding_guard();
drop function if exists ogevia_api.void_billing_rounding_adjustment(uuid, text, uuid);
drop function if exists ogevia_api.approve_billing_rounding_adjustment(uuid, uuid, uuid, date, text, uuid);
drop function if exists ogevia_api.list_billing_rounding_preview(uuid, date, date);
drop function if exists ogevia_api.list_billing_rounding_policies(uuid);
drop function if exists ogevia_api.set_billing_rounding_policy(uuid, text, uuid, text, integer, text, text, date, date, text, uuid);
drop function if exists ogevia.rounding_proposal(uuid, date, ogevia.billing_rounding_policies, integer, boolean);
drop function if exists ogevia.rounding_units(uuid, date, date);
drop function if exists ogevia.rounding_policy_for(uuid, text, uuid, date);
drop function if exists ogevia.round_minutes(integer, text, integer);
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
  select coalesce(sum(v.billable_minutes), 0)::bigint
  from ogevia.service_visits v
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where a.lineage_id = p_lineage_id
    and v.service_date >= date_trunc('month', p_service_date::timestamp)::date
    and v.service_date < (date_trunc('month', p_service_date::timestamp) + interval '1 month')::date
    and v.status in ('signed', 'administrator_review')
    and v.id is distinct from p_exclude_visit_id;
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
    greatest(a.monthly_authorized_minutes - coalesce(u.billable_minutes, 0) - coalesce(rs.reserved_minutes, 0), 0),
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
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
  order by sv.name, sv.code, a.period_start;
$$;

drop table if exists ogevia.billing_rounding_adjustments;
drop function if exists ogevia.billing_rounding_adjustments_guard_update();
drop table if exists ogevia.billing_rounding_policies;
delete from ogevia.role_permissions where permission_key = 'billing.rounding.manage';
delete from ogevia.permissions where key = 'billing.rounding.manage';
