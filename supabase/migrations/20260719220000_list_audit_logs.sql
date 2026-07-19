begin;

-- Returns audit_logs rows for an organization together with the actor's
-- display name. Same reasoning as list_organization_members: RLS on
-- user_profiles only lets someone read their own row (or a platform
-- owner read any), so an organization_admin can't join user_profiles
-- for other actors directly from the browser. Access is gated inline by
-- has_permission, matching the "authorized_read_audit" RLS policy on
-- audit_logs itself.
--
-- Left join (not inner) on user_profiles: actor_user_id is nullable on
-- audit_logs (system-initiated changes have no acting user), and using
-- a left join means a row is never silently dropped just because its
-- actor can't be resolved.
create or replace function public.list_audit_logs(
  target_organization_id uuid,
  result_limit integer default 200
)
returns table (
  id bigint,
  occurred_at timestamptz,
  actor_user_id uuid,
  actor_display_name text,
  action text,
  entity_type text,
  entity_id text,
  source text,
  old_values jsonb,
  new_values jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.occurred_at,
    a.actor_user_id,
    coalesce(p.display_name, case when a.actor_user_id is null then 'System' else 'Unknown user' end),
    a.action,
    a.entity_type,
    a.entity_id,
    a.source,
    a.old_values,
    a.new_values
  from public.audit_logs a
  left join public.user_profiles p on p.id = a.actor_user_id
  where a.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'audit.read')
  order by a.occurred_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_audit_logs(uuid, integer) from public;
grant execute on function public.list_audit_logs(uuid, integer) to authenticated;

commit;
