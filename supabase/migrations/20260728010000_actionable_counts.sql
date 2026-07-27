begin;

-- get_actionable_counts: a single-row aggregate of "how many things need
-- attention" per navigation destination, so the nav rail can show a
-- badge on Clients/Schedule/Access/Credentials/Authorizations/Incidents
-- without every page having to fetch its own full list just to count a
-- number nobody reads in detail from the sidebar. This is deliberately
-- NOT a replacement for action-center.tsx's per-signal cards - it exists
-- purely to power badges, and reuses the exact same thresholds/logic
-- action-center.tsx already established (30-day expiring window, 0.1hr
-- over-limit tolerance) so a badge count and the matching page's detail
-- never disagree about what counts as an issue.
--
-- Same "derive at read time, don't store" precedent as
-- getCredentialStatus/getAuthorizationExpiryStatus in packages/shared -
-- this is that same logic, just computed in SQL so one query can answer
-- for every nav item at once instead of six separate round trips.
--
-- Fields the caller lacks permission for come back null (not zero) so
-- the client can tell "nothing to report" apart from "not allowed to
-- know" and skip rendering a badge either way.
create function public.get_actionable_counts(target_organization_id uuid)
returns table (
  clients_uncovered integer,
  schedule_issues integer,
  access_pending integer,
  credentials_issues integer,
  authorizations_issues integer,
  incidents_open integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
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

  -- Clients uncovered: active clients with no scheduled shift starting
  -- in the next 7 days. Same forward-looking window as action-center's
  -- uncovered-clients signal.
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

  -- Schedule issues: shifts still marked "scheduled" whose end time has
  -- already passed (needs a status update) plus caregivers already over
  -- their weekly hour target - two distinct schedule-page concerns
  -- combined into one badge number.
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
    where s.caregiver_user_id = m.user_id
      and s.organization_id = target_organization_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < week_end
      and s.ends_at > week_start
  ) hrs on true
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and m.target_hours_per_week is not null
    and coalesce(hrs.scheduled, 0) > m.target_hours_per_week;

  v_schedule_issues := v_overdue_shifts + v_over_target_caregivers;

  -- Access pending: invited memberships awaiting acceptance.
  select count(*) into v_access_pending
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.status = 'invited';

  -- Credentials issues: expiring within 30 days or already expired -
  -- same EXPIRING_SOON_WINDOW_DAYS as packages/shared/src/credentials.ts.
  select count(*) into v_credentials_issues
  from public.caregiver_credentials cc
  where cc.organization_id = target_organization_id
    and cc.deleted_at is null
    and cc.expires_at is not null
    and cc.expires_at < (now_ts + interval '30 days')::date;

  -- Authorizations issues: same usage-vs-cap and expiry math as
  -- list_client_authorizations (20260721010000), condensed to a count of
  -- authorizations that are over their monthly hours cap (while active)
  -- or expiring/expired within 30 days.
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

  -- Incidents open: anything not yet resolved.
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
$$;

revoke all on function public.get_actionable_counts(uuid) from public;
grant execute on function public.get_actionable_counts(uuid) to authenticated;
revoke execute on function public.get_actionable_counts(uuid) from anon;

commit;
