-- find_client_by_code's RETURNS TABLE(client_id, client_code) creates
-- plpgsql variables of those names, which collided with clients.client_code/
-- clients.id inside the unqualified WHERE clause (42702 ambiguous column).
-- Fix: alias the clients table and qualify every reference to it.
create or replace function public.find_client_by_code(
  target_organization_id uuid,
  target_client_code text
)
returns table (client_id uuid, client_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.clients%rowtype;
  recent_failures integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_organization_member(target_organization_id) then
    raise exception 'Not a member of this organization';
  end if;

  select count(*) into recent_failures
  from public.audit_logs
  where actor_user_id = auth.uid()
    and organization_id = target_organization_id
    and action = 'client_lookup.failed'
    and occurred_at > now() - interval '10 minutes';

  if recent_failures >= 5 then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.rate_limited', 'clients', 'application');
    raise exception 'RATE_LIMITED: Too many attempts. Wait a few minutes or contact your administrator.';
  end if;

  select c.* into target from public.clients c
  where c.organization_id = target_organization_id
    and lower(c.client_code) = lower(btrim(target_client_code))
    and c.deleted_at is null
    and c.status = 'active';

  if target.id is null then
    insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, source)
    values (target_organization_id, auth.uid(), 'client_lookup.failed', 'clients', 'application');
    raise exception 'NOT_FOUND: That client ID was not found or is not active.';
  end if;

  return query select target.id, target.client_code;
end;
$$;

revoke all on function public.find_client_by_code(uuid, text) from public, anon;
grant execute on function public.find_client_by_code(uuid, text) to authenticated;
