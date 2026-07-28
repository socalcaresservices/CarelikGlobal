begin;

-- list_audit_logs() is the only list RPC in the app with a limit at all
-- (result_limit, default 200, capped at 500) - a deliberate signal this
-- table is expected to outgrow "fetch everything," unlike the rest of
-- the app's useTableControls client-side-only pattern. But audit-page.tsx
-- never passed anything past that default and had no way to see older
-- activity, so once an organization passed 200 logged changes, earlier
-- history became permanently invisible with no indication anything was
-- cut off.
--
-- Adds a keyset cursor (before_id) rather than an OFFSET, since OFFSET
-- pagination re-scans and re-sorts every skipped row on each page and
-- drifts under concurrent inserts (a very live table - every insert/
-- update/delete in the app writes here). audit_logs.id is a bigserial
-- assigned in insertion order by the audit trigger, which always fires
-- after occurred_at is set, so "id < before_id" and "occurred_at desc"
-- agree on ordering - the same guarantee list_shifts-style keyset
-- pagination elsewhere in this codebase relies on.
--
-- Backward compatible for every other caller (caregiver-detail-page,
-- client-detail-page, owner-dashboard-page) that only ever passes
-- target_organization_id and relies on the first-200-rows default -
-- before_id defaults to null, meaning "start from the newest row",
-- identical to today's behavior.
drop function if exists public.list_audit_logs(uuid, integer);

create function public.list_audit_logs(
  target_organization_id uuid,
  result_limit integer default 200,
  before_id bigint default null
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
    and (before_id is null or a.id < before_id)
    and public.has_permission(target_organization_id, 'audit.read')
  order by a.occurred_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_audit_logs(uuid, integer, bigint) from public;
grant execute on function public.list_audit_logs(uuid, integer, bigint) to authenticated;

commit;
