begin;

-- Third and last site of the same bug fixed in 20260823010000/020000:
-- get_actionable_counts()'s v_over_target_caregivers subquery (the
-- sidebar Schedule badge's "caregiver over their weekly target" half)
-- independently re-derives "scheduled hours from shifts" with no
-- awareness of a called-out-but-not-yet-reassigned shift. Fixed the
-- same way as get_caregiver_hours()/get_agency_dashboard(): exclude
-- any shift whose latest shift_coverage_events row is 'called_out'.
-- Only this one subquery changes - the authorization-usage CTE further
-- down is untouched, since a called-out shift still represents real
-- committed time against a client's authorization regardless of which
-- caregiver (if any) currently holds it; that's a client/service-keyed
-- concept, not a caregiver-keyed one, so it isn't affected by this bug.
create or replace function public.get_actionable_counts(target_organization_id uuid)
returns table(clients_uncovered integer, schedule_issues integer, access_pending integer, credentials_issues integer, authorizations_issues integer, incidents_open integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  now_ts timestamptz := now();
  week_start timestamptz := date_trunc('week', now_ts);
  week_end timestamptz := week_start + interval '7 days';
  upcoming_end timestamptz := now_ts + interval '7 days';
  v_clients_uncovered integer;
  v_overdue_shifts integer;
  v_over_target_caregivers integer;
  v_schedule_issues integer;
  v_access_pending integer;
  v_credentials_issues integer;
  v_authorizations_issues integer;
  v_incidents_open integer;
begin
  if not public.has_permission(target_organization_id, 'membership.read') then
    raise exception 'You do not have permission to view actionable counts for this organization';
  end if;

  if public.has_permission(target_organization_id, 'clients.read')
     and public.has_permission(target_organization_id, 'shifts.read') then
    select count(*) into v_clients_uncovered
    from public.clients c
    where c.organization_id = target_organization_id
      and c.status = 'active'
      and c.deleted_at is null
      and not exists (
        select 1 from public.shifts s
        where s.client_id = c.id
          and s.organization_id = target_organization_id
          and s.status = 'scheduled'
          and s.starts_at >= now_ts
          and s.starts_at < upcoming_end
      );
  else
    v_clients_uncovered := null;
  end if;

  select count(*) into v_overdue_shifts
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.status = 'scheduled'
    and s.ends_at < now_ts;

  select count(*) into v_over_target_caregivers
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
    and m.target_hours_per_week is not null
    and coalesce(hrs.scheduled, 0) > m.target_hours_per_week;

  v_schedule_issues := v_overdue_shifts + v_over_target_caregivers;

  select count(*) into v_access_pending
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.status = 'invited';

  select count(*) into v_credentials_issues
  from public.caregiver_record_credentials cc
  where cc.organization_id = target_organization_id
    and cc.deleted_at is null
    and cc.expiration_date is not null
    and cc.expiration_date < (now_ts + interval '30 days')::date;

  if public.has_permission(target_organization_id, 'authorizations.read') then
    with usage as (
      select
        a.id,
        a.max_monthly_hours,
        a.period_start,
        a.period_end,
        coalesce(
          sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
            filter (where s.status = 'completed'),
          0
        ) as hours_used_this_month,
        coalesce(
          sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
            filter (where s.status = 'scheduled'),
          0
        ) as hours_scheduled_this_month
      from public.client_authorizations a
      cross join lateral (
        select
          greatest(date_trunc('month', now_ts), a.period_start::timestamptz) as window_start,
          least(date_trunc('month', now_ts) + interval '1 month', a.period_end::timestamptz + interval '1 day') as window_end
      ) w
      left join public.shifts s
        on s.client_id = a.client_id
       and s.service_id = a.service_id
       and s.organization_id = a.organization_id
       and s.status in ('completed', 'scheduled')
       and s.starts_at < w.window_end
       and s.ends_at > w.window_start
      where a.organization_id = target_organization_id
        and a.deleted_at is null
      group by a.id, a.max_monthly_hours, a.period_start, a.period_end
    )
    select count(*) into v_authorizations_issues
    from usage u
    where u.period_end < (now_ts + interval '30 days')::date
       or (
         u.period_start <= now_ts::date
         and u.period_end >= now_ts::date
         and (
           (u.max_monthly_hours > 0
             and (u.hours_used_this_month + u.hours_scheduled_this_month) > u.max_monthly_hours + 0.1)
           or (u.max_monthly_hours <= 0 and (u.hours_used_this_month + u.hours_scheduled_this_month) > 0)
         )
       );
  else
    v_authorizations_issues := null;
  end if;

  select count(*) into v_incidents_open
  from public.incidents i
  where i.organization_id = target_organization_id
    and i.deleted_at is null
    and i.status <> 'resolved';

  return query select
    v_clients_uncovered,
    v_schedule_issues,
    v_access_pending,
    v_credentials_issues,
    v_authorizations_issues,
    v_incidents_open;
end;
$function$;

commit;
