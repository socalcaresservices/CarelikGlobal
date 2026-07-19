begin;

-- Resolves client and caregiver names for shifts, same reasoning as
-- list_organization_members/list_audit_logs: RLS on user_profiles won't
-- let most callers join in another user's display name directly. Access
-- mirrors the shifts RLS policy exactly (org-wide shifts.read, or just
-- your own assigned shifts) rather than only allowing shifts.read
-- holders, so caregivers can still see their own schedule through this
-- function the same way they can through the table directly.
create or replace function public.list_shifts(
  target_organization_id uuid,
  from_time timestamptz default null,
  to_time timestamptz default null
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  caregiver_user_id uuid,
  caregiver_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.shift_status,
  notes text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.client_id,
    coalesce(c.first_name || ' ' || c.last_name, 'Unknown client'),
    s.caregiver_user_id,
    coalesce(p.display_name, 'Unknown caregiver'),
    s.starts_at,
    s.ends_at,
    s.status,
    s.notes
  from public.shifts s
  join public.clients c on c.id = s.client_id
  left join public.user_profiles p on p.id = s.caregiver_user_id
  where s.organization_id = target_organization_id
    and (
      public.has_permission(target_organization_id, 'shifts.read')
      or s.caregiver_user_id = auth.uid()
    )
    and (from_time is null or s.ends_at >= from_time)
    and (to_time is null or s.starts_at <= to_time)
  order by s.starts_at;
$$;

revoke all on function public.list_shifts(uuid, timestamptz, timestamptz) from public;
grant execute on function public.list_shifts(uuid, timestamptz, timestamptz) to authenticated;

commit;
