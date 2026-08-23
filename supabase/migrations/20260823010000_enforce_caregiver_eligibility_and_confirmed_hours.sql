begin;

-- Two real gaps found while extending the scheduling audit
-- (docs delivered separately this session) into "one connected source
-- of truth, dashboards calculate from the real schedule" work:
--
-- 1. Every *write* path to shifts.caregiver_record_id is gated by RLS
--    (authorized_insert_shifts / authorized_update_shifts,
--    20260820070000_consolidate_multiple_permissive_policies.sql), but
--    that check only confirms the caregiver_records row exists and
--    isn't deleted - not that its status is 'active'/'ready'.
--    reassign_shift() already enforces status separately in its own
--    body, but a direct insert (the initial "Schedule a shift" form,
--    or any future caller) never goes through that check - it only
--    relies on the frontend picker filtering to active/ready, which is
--    a UI convenience, not a rule. An inactive/on-leave/terminated
--    caregiver_records row could still be written directly into
--    shifts.caregiver_record_id today. Fixed by folding the same
--    status check reassign_shift() already uses into the RLS with_check
--    clauses, so it's enforced for every writer, not just one RPC -
--    matching this schema's existing house rule that scheduling
--    eligibility is a data-layer rule, not a UI-layer one
--    (docs/PRODUCT_CONSTITUTION.md, "Build for a machine reader too").
--
-- 2. get_caregiver_hours() (20260719240000, never revised since) counts
--    every shifts row with status in ('scheduled','completed') toward
--    a caregiver's weekly hours, with no awareness that a shift can be
--    called out (shift_coverage_events.event_type = 'called_out') and
--    still be sitting there with the *original* caregiver's id attached
--    until someone runs reassign_shift()/claim_shift(). A called-out
--    shift is not a confirmed assignment for that caregiver anymore -
--    list_shifts() already knows this (its needs_coverage column is
--    exactly this check), get_caregiver_hours() never did. This is the
--    concrete mechanism behind "a caregiver calls out and the hours
--    dashboard still shows them scheduled until someone reassigns it."
--    Fixed by excluding any shift whose latest coverage event is
--    'called_out' from the hours sum, mirroring list_shifts()'s own
--    lateral-join pattern exactly so the two never drift apart again.

drop policy "authorized_insert_shifts" on public.shifts;
create policy "authorized_insert_shifts" on public.shifts for insert to authenticated
  with check (has_permission(organization_id, 'shifts.update') and ((caregiver_record_id is null) or (exists (
    select 1 from public.caregiver_records cr
    where cr.id = shifts.caregiver_record_id
      and cr.organization_id = shifts.organization_id
      and cr.deleted_at is null
      and cr.status in ('active', 'ready')
  ))));

drop policy "authorized_update_shifts" on public.shifts;
create policy "authorized_update_shifts" on public.shifts for update to authenticated
  using (has_permission(organization_id, 'shifts.update'))
  with check (has_permission(organization_id, 'shifts.update') and ((caregiver_record_id is null) or (exists (
    select 1 from public.caregiver_records cr
    where cr.id = shifts.caregiver_record_id
      and cr.organization_id = shifts.organization_id
      and cr.deleted_at is null
      and cr.status in ('active', 'ready')
  ))));

create or replace function public.get_caregiver_hours(
  target_organization_id uuid, week_start timestamptz, week_end timestamptz
) returns table (caregiver_user_id uuid, caregiver_name text, target_hours_per_week numeric, scheduled_hours numeric)
language sql stable security definer set search_path = public
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
          and latest_event.event_type is distinct from 'called_out'
      ),
      0
    )
  from public.organization_memberships m
  join public.user_profiles p on p.id = m.user_id
  left join public.shifts s
    on s.caregiver_user_id = m.user_id
   and s.organization_id = m.organization_id
  left join lateral (
    select e.event_type from public.shift_coverage_events e
    where e.shift_id = s.id
    order by e.created_at desc
    limit 1
  ) latest_event on s.id is not null
  where m.organization_id = target_organization_id
    and m.status = 'active'
    and (
      public.has_permission(target_organization_id, 'shifts.read')
      or m.user_id = auth.uid()
    )
  group by m.user_id, p.display_name, m.target_hours_per_week;
$$;

commit;
