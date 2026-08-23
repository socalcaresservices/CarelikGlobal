begin;

-- get_actionable_counts()'s authorizations_issues check re-implemented
-- list_client_authorizations()'s window-clamp math (calendar-month
-- intersected with the authorization's own period_start/period_end,
-- split by status='completed' vs 'scheduled') as a second, independently
-- hand-written copy. Two formulas computing "hours used/scheduled this
-- month for an authorization" is exactly the kind of duplicate source
-- the scheduling audit flagged - a future edit to one (e.g. correcting
-- the window clamp, or switching to a signed-visit basis) would silently
-- leave the other behind. Deduped by having get_actionable_counts call
-- list_client_authorizations() directly instead of re-deriving the same
-- numbers - both are already SECURITY DEFINER functions running under
-- the same caller, and get_actionable_counts already checks
-- 'authorizations.read' itself before entering this branch, so the
-- inner call's own permission check is redundant but harmless (same
-- caller, same organization_id, same answer).
--
-- One real behavior change alongside the dedupe: the old CTE filtered
-- only on deleted_at is null, with no is_current check, so a superseded
-- (amended-away) authorization version could still trip the
-- authorizations_issues badge. list_client_authorizations() already
-- filters to is_current = true, so this also fixes that - the badge now
-- only ever reflects the authorization version a user would actually
-- see on the Authorizations page.
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
    select count(*) into v_authorizations_issues
    from public.list_client_authorizations(target_organization_id, 500) u
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
