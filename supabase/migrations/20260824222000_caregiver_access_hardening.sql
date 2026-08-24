begin;

-- A Care Team record may only be linked to a caregiver membership. Allow an
-- invited caregiver to be linked before they accept the email so managers can
-- finish setup and assignments in one sitting; the caregiver-facing RPCs still
-- require an active membership before any client is visible.
create or replace function public.link_caregiver_record_to_user(
  target_organization_id uuid,
  target_caregiver_record_id uuid,
  target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to link Care Team accounts for this organization';
  end if;

  if not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = target_organization_id
      and m.user_id = target_user_id
      and m.role = 'caregiver'
      and m.status in ('active', 'invited')
  ) then
    raise exception 'The selected account must be an active or invited caregiver in this organization';
  end if;

  if exists (
    select 1
    from public.caregiver_records cr
    where cr.organization_id = target_organization_id
      and cr.linked_user_id = target_user_id
      and cr.id <> target_caregiver_record_id
      and cr.deleted_at is null
  ) then
    raise exception 'That caregiver account is already linked to another Care Team record';
  end if;

  update public.caregiver_records
  set linked_user_id = target_user_id
  where id = target_caregiver_record_id
    and organization_id = target_organization_id
    and deleted_at is null;

  if not found then
    raise exception 'Care Team record not found in this organization';
  end if;

  delete from public.caregiver_availability
  where organization_id = target_organization_id
    and caregiver_user_id = target_user_id;

  insert into public.caregiver_availability (
    organization_id, caregiver_user_id, day_of_week, start_time, end_time
  )
  select target_organization_id, target_user_id, day_of_week, start_time, end_time
  from public.caregiver_record_availability
  where caregiver_record_id = target_caregiver_record_id;

  update public.organization_memberships om
  set target_hours_per_week = cr.desired_weekly_hours
  from public.caregiver_records cr
  where cr.id = target_caregiver_record_id
    and cr.organization_id = target_organization_id
    and om.organization_id = target_organization_id
    and om.user_id = target_user_id;
end;
$$;

revoke all on function public.link_caregiver_record_to_user(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.link_caregiver_record_to_user(uuid, uuid, uuid)
  to authenticated;

-- Enforce assignment identity and organization consistency in Postgres, not
-- only in dropdown filtering. This prevents a manager/owner login, an unlinked
-- account, or records from another organization from becoming a caregiver
-- assignment even if a browser request is malformed.
create or replace function public.assert_valid_caregiver_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not new.is_active then
    return new;
  end if;

  if not exists (
    select 1
    from public.organization_memberships m
    join public.caregiver_records cr
      on cr.organization_id = m.organization_id
     and cr.linked_user_id = m.user_id
     and cr.deleted_at is null
     and cr.status in ('active', 'ready')
    where m.organization_id = new.organization_id
      and m.user_id = new.caregiver_user_id
      and m.role = 'caregiver'
      and m.status in ('active', 'invited')
  ) then
    raise exception 'Assign an active Care Team record with a linked caregiver login';
  end if;

  if not exists (
    select 1 from public.clients c
    where c.id = new.client_id
      and c.organization_id = new.organization_id
      and c.deleted_at is null
      and c.status = 'active'
  ) then
    raise exception 'The client must be active in this organization';
  end if;

  if not exists (
    select 1 from public.services s
    where s.id = new.service_id
      and s.organization_id = new.organization_id
      and s.deleted_at is null
      and s.is_active
  ) then
    raise exception 'The service must be active in this organization';
  end if;

  return new;
end;
$$;

revoke all on function public.assert_valid_caregiver_assignment()
  from public, anon, authenticated;

drop trigger if exists assert_valid_caregiver_assignment
  on public.caregiver_assignments;
create trigger assert_valid_caregiver_assignment
before insert or update of organization_id, caregiver_user_id, client_id, service_id, is_active
on public.caregiver_assignments
for each row execute function public.assert_valid_caregiver_assignment();

commit;
