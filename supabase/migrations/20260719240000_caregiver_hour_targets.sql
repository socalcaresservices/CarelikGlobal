begin;

-- Caregiver weekly hour targets. Set per caregiver (not an org-wide
-- default), measured against scheduled + completed shift hours for the
-- week, surfaced as an Action Center alert when someone goes over.
alter table public.organization_memberships
add column target_hours_per_week numeric;

alter table public.organization_memberships
add constraint organization_memberships_target_hours_check
check (target_hours_per_week is null or (target_hours_per_week >= 0 and target_hours_per_week <= 168));

-- Setting a target is a scheduling action, not a membership/role action -
-- gated on shifts.update rather than relying on the organization_memberships
-- RLS policy (which is gated on membership.update). In the current seed
-- data every role that holds one holds the other, but this keeps the
-- permission model honest about which capability actually governs it.
create or replace function public.set_caregiver_weekly_target(
  target_organization_id uuid,
  target_user_id uuid,
  target_hours numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'shifts.update') then
    raise exception 'You do not have permission to set caregiver targets for this organization';
  end if;

  update public.organization_memberships
  set target_hours_per_week = target_hours
  where organization_id = target_organization_id
    and user_id = target_user_id;

  if not found then
    raise exception 'No membership found for that user in this organization';
  end if;
end;
$$;

-- Returns every active member's target alongside their actual
-- scheduled+completed hours for the given week window, so a manager can
-- see and set targets even for members who don't have one yet (target
-- comes back null). Access mirrors list_shifts/the shifts RLS policy:
-- org-wide with shifts.read, or just your own row - a caregiver without
-- shifts.read can still see whether they're over their own target.
create or replace function public.get_caregiver_hours(
  target_organization_id uuid,
  week_start timestamptz,
  week_end timestamptz
)
returns table (
  caregiver_user_id uuid,
  caregiver_name text,
  target_hours_per_week numeric,
  scheduled_hours numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.user_id,
    coalesce(p.display_name, 'Unknown member'),
    m.target_hours_per_week,
    coalesce(
      sum(
        extract(epoch from (least(s.ends_at, week_end) - greatest(s.starts_at, week_start))) / 3600.0
      ) filter (
        where s.id is not null
          and s.status in ('scheduled', 'completed')
          and s.starts_at < week_end
          and s.ends_at > week_start
      ),
      0
    )
  from public.organization_memberships m
  join public.user_profiles p on p.id = m.user_id
  left join public.shifts s
    on s.caregiver_user_id = m.user_id
   and s.organization_id = m.organization_id
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and (
      public.has_permission(target_organization_id, 'shifts.read')
      or m.user_id = auth.uid()
    )
  group by m.user_id, p.display_name, m.target_hours_per_week;
$$;

revoke all on function public.set_caregiver_weekly_target(uuid, uuid, numeric) from public;
grant execute on function public.set_caregiver_weekly_target(uuid, uuid, numeric) to authenticated;
revoke execute on function public.set_caregiver_weekly_target(uuid, uuid, numeric) from anon;

revoke all on function public.get_caregiver_hours(uuid, timestamptz, timestamptz) from public;
grant execute on function public.get_caregiver_hours(uuid, timestamptz, timestamptz) to authenticated;
revoke execute on function public.get_caregiver_hours(uuid, timestamptz, timestamptz) from anon;

commit;
