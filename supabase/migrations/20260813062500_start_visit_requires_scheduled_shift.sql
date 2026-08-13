begin;

-- Server-side enforcement for the caregiver Time In action. UI filtering is not
-- trusted: the shift itself must still be scheduled, assigned to the caller,
-- dated today, and covered by an active authorization.
create or replace function public.start_service_visit(
  target_organization_id uuid,
  target_shift_id uuid,
  visit_task_categories text[] default '{}',
  visit_service_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_shift public.shifts%rowtype;
  target_client public.clients%rowtype;
  target_auth public.client_authorizations%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into target_shift
  from public.shifts
  where id = target_shift_id
    and organization_id = target_organization_id
  for update;

  if target_shift.id is null then raise exception 'Scheduled shift not found'; end if;
  if target_shift.caregiver_user_id <> auth.uid()
     and not public.has_permission(target_organization_id, 'visits.manage') then
    raise exception 'You cannot verify another caregiver''s shift';
  end if;
  if target_shift.status <> 'scheduled' then
    raise exception 'This visit is not currently scheduled';
  end if;
  if target_shift.starts_at::date <> current_date then
    raise exception 'This scheduled visit cannot be started on a different date';
  end if;
  if target_shift.service_id is null then
    raise exception 'The shift needs a service before it can be verified';
  end if;
  if exists (
    select 1 from public.service_visits existing
    where existing.scheduled_shift_id = target_shift.id
      and existing.status not in ('voided', 'corrected')
  ) then
    raise exception 'This scheduled visit has already been started or submitted';
  end if;

  select * into target_client
  from public.clients
  where id = target_shift.client_id
    and organization_id = target_organization_id
    and deleted_at is null
    and status = 'active';
  if target_client.id is null then raise exception 'Client not found or inactive'; end if;

  select * into target_auth
  from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_shift.client_id
    and service_id = target_shift.service_id
    and started_at::date between period_start and period_end
    and deleted_at is null
  order by period_start desc
  limit 1
  for update;

  if target_auth.id is null then
    raise exception 'No active authorization covers this visit - an administrator needs to add one first';
  end if;

  select coalesce(display_name, 'Caregiver') into caregiver_name
  from public.user_profiles
  where id = target_shift.caregiver_user_id;

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by, visit_number_snapshot
  ) values (
    target_organization_id, target_shift.client_id, target_client.client_code,
    target_shift.caregiver_user_id, coalesce(caregiver_name, 'Caregiver'),
    target_shift.id, target_auth.id, target_shift.service_id, started_at::date,
    started_at, coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid(), target_shift.visit_number
  ) returning id into visit_id;

  return visit_id;
end;
$$;

revoke all on function public.start_service_visit(uuid, uuid, text[], text) from public, anon;
grant execute on function public.start_service_visit(uuid, uuid, text[], text) to authenticated;

commit;
