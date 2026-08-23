begin;

-- Continuation of 20260823010000: get_caregiver_hours() was fixed to
-- stop counting a called-out-but-not-yet-reassigned shift as scheduled
-- for the original caregiver. The same bug exists in two more places
-- that independently re-derive "scheduled hours from shifts" -
-- get_agency_dashboard()'s fill_rate_pct/available_capacity_hours (top
-- bar "Coverage" figure and Action Center's capacity signal) - both
-- fixed the same way, by excluding any shift whose latest
-- shift_coverage_events row is 'called_out'. A called-out shift
-- represents uncovered time, not filled/confirmed time, so it should
-- not count toward either figure any more than it counts toward a
-- caregiver's own hours.
create or replace function public.get_agency_dashboard(target_organization_id uuid)
returns table (
  active_clients integer,
  active_caregivers integer,
  fill_rate_pct integer,
  compliance_score_pct integer,
  available_capacity_hours numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  week_start timestamptz := date_trunc('week', now());
  week_end timestamptz := date_trunc('week', now()) + interval '7 days';
  today date := current_date;
  v_active_clients integer;
  v_active_caregivers integer;
  v_scheduled_hours numeric;
  v_authorized_weekly_hours numeric;
  v_fill_rate integer;
  v_compliant_count integer;
  v_credentialed_count integer;
  v_compliance_score integer;
  v_capacity numeric;
begin
  if not public.has_permission(target_organization_id, 'membership.read') then
    raise exception 'You do not have permission to view the agency dashboard for this organization';
  end if;

  select count(*) into v_active_clients
  from public.clients
  where organization_id = target_organization_id and status = 'active' and deleted_at is null;

  select count(*) into v_active_caregivers
  from public.organization_memberships
  where organization_id = target_organization_id and status = 'active';

  select coalesce(sum(
    extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
  ), 0)
  into v_scheduled_hours
  from public.shifts s
  left join lateral (
    select e.event_type from public.shift_coverage_events e
    where e.shift_id = s.id
    order by e.created_at desc
    limit 1
  ) latest_event on true
  where s.organization_id = target_organization_id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < week_end
    and s.ends_at > week_start
    and latest_event.event_type is distinct from 'called_out';

  select sum(a.max_monthly_hours * 7 / 30.4375)
  into v_authorized_weekly_hours
  from public.client_authorizations a
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and a.period_start <= today
    and a.period_end >= today;

  if v_authorized_weekly_hours is null or v_authorized_weekly_hours <= 0 then
    v_fill_rate := null;
  else
    v_fill_rate := least(100, greatest(0, round(100.0 * v_scheduled_hours / v_authorized_weekly_hours)));
  end if;

  select
    count(*) filter (
      where not exists (
        select 1 from public.caregiver_record_credentials cc
        join public.caregiver_records cr on cr.id = cc.caregiver_record_id
        where cr.linked_user_id = m.user_id
          and cr.organization_id = target_organization_id
          and cc.organization_id = target_organization_id
          and cc.deleted_at is null
          and cc.expiration_date is not null
          and cc.expiration_date < today
      )
    ),
    count(*)
  into v_compliant_count, v_credentialed_count
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and exists (
      select 1 from public.caregiver_record_credentials cc
      join public.caregiver_records cr on cr.id = cc.caregiver_record_id
      where cr.linked_user_id = m.user_id
        and cr.organization_id = target_organization_id
        and cc.organization_id = target_organization_id
        and cc.deleted_at is null
    );

  if v_credentialed_count = 0 then
    v_compliance_score := null;
  else
    v_compliance_score := round(100.0 * v_compliant_count / v_credentialed_count);
  end if;

  select sum(greatest(0, m.target_hours_per_week - coalesce(hrs.scheduled, 0)))
  into v_capacity
  from public.organization_memberships m
  left join lateral (
    select sum(
      extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
    ) as scheduled
    from public.shifts s
    left join lateral (
      select e.event_type from public.shift_coverage_events e
      where e.shift_id = s.id
      order by e.created_at desc
      limit 1
    ) latest_event on true
    where s.caregiver_user_id = m.user_id
      and s.organization_id = target_organization_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < week_end
      and s.ends_at > week_start
      and latest_event.event_type is distinct from 'called_out'
  ) hrs on true
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and m.target_hours_per_week is not null;

  return query select
    v_active_clients,
    v_active_caregivers,
    v_fill_rate,
    v_compliance_score,
    v_capacity;
end;
$function$;

commit;
