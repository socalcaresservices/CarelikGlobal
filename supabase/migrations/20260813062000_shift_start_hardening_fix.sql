begin;

create or replace function public.start_service_visit_by_client_code(
  target_organization_id uuid,
  target_client_code text,
  target_service_id uuid,
  visit_task_categories text[] default '{}',
  visit_service_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_client public.clients%rowtype;
  candidate_shift_id uuid;
  candidate_count integer;
  visit_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;

  select * into target_client
  from public.clients
  where organization_id = target_organization_id
    and lower(client_code) = lower(btrim(target_client_code))
    and deleted_at is null
    and status = 'active';

  if target_client.id is null then
    raise exception 'NOT_FOUND: That client ID was not found or is not active.';
  end if;

  select count(*) into candidate_count
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.client_id = target_client.id
    and s.caregiver_user_id = auth.uid()
    and s.service_id = target_service_id
    and s.status = 'scheduled'
    and s.starts_at::date = current_date
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    );

  if candidate_count = 0 then
    raise exception 'NO_SCHEDULED_VISIT: No administrator-scheduled visit is available for this client and service today.';
  end if;
  if candidate_count > 1 then
    raise exception 'MULTIPLE_SCHEDULED_VISITS: Select the specific scheduled visit from your visit list.';
  end if;

  select s.id into candidate_shift_id
  from public.shifts s
  where s.organization_id = target_organization_id
    and s.client_id = target_client.id
    and s.caregiver_user_id = auth.uid()
    and s.service_id = target_service_id
    and s.status = 'scheduled'
    and s.starts_at::date = current_date
    and not exists (
      select 1 from public.service_visits existing
      where existing.scheduled_shift_id = s.id
        and existing.status not in ('voided', 'corrected')
    )
  limit 1;

  select public.start_service_visit(
    target_organization_id,
    candidate_shift_id,
    coalesce(visit_task_categories, '{}'),
    visit_service_notes
  ) into visit_id;

  return visit_id;
end;
$$;

revoke all on function public.start_service_visit_by_client_code(uuid, text, uuid, text[], text) from public, anon;
grant execute on function public.start_service_visit_by_client_code(uuid, text, uuid, text[], text) to authenticated;

commit;
