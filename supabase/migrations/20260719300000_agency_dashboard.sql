begin;

-- Agency dashboard: the "how's the agency doing overall" numbers from
-- carelik.com's marketing page (fill rate, compliance score, available
-- capacity), computed entirely from data that already exists. Same rule
-- as everywhere else in this schema: a metric with nothing to measure
-- against returns null, never a fabricated percentage.
--
--   fill_rate_pct: this week's scheduled hours against this week's
--   *authorized* hours (each client_authorizations row's authorized_hours
--   is spread evenly across its period and converted to a weekly
--   equivalent - an explicit simplification, not real daily granularity).
--   Null when no client has a live authorization today.
--
--   compliance_score_pct: share of caregivers who have at least one
--   credential on file with none expired. Caregivers with zero
--   credential rows are excluded from both sides of the ratio - no
--   record means nothing to score, not automatic compliance. Null when
--   nobody in the org has any credential on file yet.
--
--   available_capacity_hours: sum of (weekly target - scheduled hours
--   this week) across caregivers who have a weekly target set, floored
--   at 0 per caregiver. Null when nobody has a target set.
create or replace function public.get_agency_dashboard(
  target_organization_id uuid
)
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
set search_path = public
as $$
declare
  week_start timestamptz := date_trunc('week', now());
  week_end timestamptz := date_trunc('week', now()) + interval '7 days';
  today date := current_date;
  v_active_clients integer;
  v_active_caregivers integer;
  v_scheduled_hours numeric;
  v_authorized_hours numeric;
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
  where s.organization_id = target_organization_id
    and s.status in ('scheduled', 'completed')
    and s.starts_at < week_end
    and s.ends_at > week_start;

  select sum(
    a.authorized_hours / greatest(1, (a.period_end - a.period_start + 1))::numeric * 7
  )
  into v_authorized_hours
  from public.client_authorizations a
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and a.period_start <= today
    and a.period_end >= today;

  if v_authorized_hours is null or v_authorized_hours <= 0 then
    v_fill_rate := null;
  else
    v_fill_rate := least(100, greatest(0, round(100.0 * v_scheduled_hours / v_authorized_hours)));
  end if;

  select
    count(*) filter (
      where not exists (
        select 1 from public.caregiver_credentials cc
        where cc.caregiver_user_id = m.user_id
          and cc.organization_id = target_organization_id
          and cc.deleted_at is null
          and cc.expires_at is not null
          and cc.expires_at < today
      )
    ),
    count(*)
  into v_compliant_count, v_credentialed_count
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and exists (
      select 1 from public.caregiver_credentials cc
      where cc.caregiver_user_id = m.user_id
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
    where s.caregiver_user_id = m.user_id
      and s.organization_id = target_organization_id
      and s.status in ('scheduled', 'completed')
      and s.starts_at < week_end
      and s.ends_at > week_start
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
$$;

revoke all on function public.get_agency_dashboard(uuid) from public;
grant execute on function public.get_agency_dashboard(uuid) to authenticated;
revoke execute on function public.get_agency_dashboard(uuid) from anon;

commit;
