begin;

-- Caregivers may identify a client by the agency client code or by an exact
-- full-name match. Exact matching avoids exposing an organization-wide client
-- directory; ambiguous names must be resolved with the client code.
create or replace function public.find_client_for_visit(
  target_organization_id uuid,
  search_term text
)
returns table (client_id uuid, client_code text, client_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_term text := lower(btrim(search_term));
  match_count integer;
  recent_failures integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;
  if normalized_term = '' then raise exception 'Enter a client name or ID'; end if;

  select count(*) into recent_failures
  from public.audit_logs
  where actor_user_id = auth.uid()
    and organization_id = target_organization_id
    and action = 'client_lookup.failed'
    and occurred_at > now() - interval '10 minutes';
  if recent_failures >= 5 then
    raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.';
  end if;

  select count(*) into match_count
  from public.clients c
  where c.organization_id = target_organization_id
    and c.deleted_at is null and c.status = 'active'
    and (lower(c.client_code) = normalized_term
      or lower(btrim(c.first_name || ' ' || c.last_name)) = normalized_term);

  if match_count = 0 then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.failed', 'clients', 'application');
    -- Return no rows instead of raising so the failed-attempt audit record is
    -- committed and can participate in the rate limit on later calls.
    return;
  end if;
  if match_count > 1 then
    raise exception 'AMBIGUOUS_CLIENT: More than one client has that name. Enter the client ID instead.';
  end if;

  return query
  select c.id, c.client_code, btrim(c.first_name || ' ' || c.last_name)
  from public.clients c
  where c.organization_id = target_organization_id
    and c.deleted_at is null and c.status = 'active'
    and (lower(c.client_code) = normalized_term
      or lower(btrim(c.first_name || ' ' || c.last_name)) = normalized_term)
  limit 1;
end;
$$;

revoke all on function public.find_client_for_visit(uuid, text) from public, anon;
grant execute on function public.find_client_for_visit(uuid, text) to authenticated;

create or replace function public.start_ad_hoc_service_visit(
  target_organization_id uuid,
  target_client_id uuid,
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
  target_auth public.client_authorizations%rowtype;
  caregiver_name text;
  visit_id uuid;
  started_at timestamptz := now();
  org_slug text;
  new_visit_number text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not exists (
    select 1 from public.organization_memberships om
    where om.organization_id = target_organization_id
      and om.user_id = auth.uid() and om.status = 'active'
      and (om.role = 'caregiver' or public.has_permission(target_organization_id, 'visits.manage'))
  ) then
    raise exception 'Only an active caregiver or visit manager can start a visit';
  end if;

  if exists (
    select 1 from public.service_visits v
    where v.organization_id = target_organization_id
      and v.caregiver_user_id = auth.uid()
      and v.status in ('draft', 'awaiting_signature')
  ) then
    raise exception 'Finish or submit your current visit before starting another client';
  end if;

  select * into target_client from public.clients
  where id = target_client_id and organization_id = target_organization_id
    and deleted_at is null and status = 'active';
  if target_client.id is null then raise exception 'Client not found or inactive'; end if;

  select * into target_auth from public.client_authorizations
  where organization_id = target_organization_id
    and client_id = target_client_id and service_id = target_service_id
    and started_at::date between period_start and period_end and deleted_at is null
  order by period_start desc limit 1 for update;
  if target_auth.id is null then
    raise exception 'No active authorization covers this client and service';
  end if;

  select coalesce(
    nullif(btrim(cr.preferred_name || ' ' || cr.last_name), ''),
    nullif(btrim(cr.first_name || ' ' || cr.last_name), ''),
    up.display_name,
    'Caregiver'
  ) into caregiver_name
  from public.user_profiles up
  left join public.caregiver_records cr
    on cr.organization_id = target_organization_id
   and cr.linked_user_id = up.id and cr.deleted_at is null
  where up.id = auth.uid()
  limit 1;

  select upper(left(regexp_replace(slug, '[^a-zA-Z0-9]', '', 'g'), 4)) into org_slug
  from public.organizations where id = target_organization_id;
  new_visit_number := coalesce(nullif(org_slug, ''), 'OGEV') || '-V-' || to_char(started_at, 'YYYYMMDD')
    || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4));

  insert into public.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id,
    service_id, service_date, time_in, task_categories, service_notes,
    status, created_by, visit_number_snapshot
  ) values (
    target_organization_id, target_client.id, target_client.client_code, auth.uid(),
    coalesce(caregiver_name, 'Caregiver'), null, target_auth.id,
    target_service_id, started_at::date, started_at,
    coalesce(visit_task_categories, '{}'), nullif(trim(visit_service_notes), ''),
    'draft', auth.uid(), new_visit_number
  ) returning id into visit_id;

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, source)
  values (target_organization_id, auth.uid(), 'service_visit.started_ad_hoc', 'service_visits', visit_id, 'application');

  return visit_id;
end;
$$;

revoke all on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text) from public, anon;
grant execute on function public.start_ad_hoc_service_visit(uuid, uuid, uuid, text[], text) to authenticated;

commit;
