begin;

-- Same unbounded-growth gap already fixed for list_audit_logs (keyset
-- pagination, 20260729010000) and list_shifts (rolling time window,
-- schedule-page.tsx) - list_incidents fetched every incident an
-- organization has ever logged, with no limit at all. An agency that's
-- been live for a while and has real incident volume would eventually
-- feel this as a slow-loading Incidents page and an ever-growing RPC
-- payload.
--
-- incidents.id is a random uuid (gen_random_uuid()), not a bigserial
-- like audit_logs.id, so a single-column "id < before_id" cursor
-- wouldn't agree with the occurred_at desc ordering at all - two
-- incidents logged a second apart could sort either way by id. Instead
-- this uses a composite (occurred_at, id) cursor: "before_occurred_at"
-- narrows by time (the actual sort key) and "before_id" only breaks
-- ties between incidents sharing the exact same occurred_at, which are
-- rare but not impossible. Both must be supplied together or not at
-- all - a mismatched pair would silently produce a wrong page - so the
-- SQL only applies the row-comparison filter when before_occurred_at is
-- present, and the frontend always passes both from the last row of the
-- previous page.
--
-- Backward compatible for every other caller (action-center.tsx,
-- owner-dashboard-page.tsx, caregiver-detail-page.tsx,
-- client-detail-page.tsx) that only ever passes target_organization_id
-- and relies on the first-200-rows default - both cursor params default
-- to null, meaning "start from the newest row", identical to today's
-- behavior. Only incidents-page.tsx needs the new params to offer
-- "load older."
drop function if exists public.list_incidents(uuid);

create function public.list_incidents(
  target_organization_id uuid,
  result_limit integer default 200,
  before_occurred_at timestamptz default null,
  before_id uuid default null
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  caregiver_user_id uuid,
  caregiver_name text,
  occurred_at timestamptz,
  category text,
  severity public.incident_severity,
  status public.incident_status,
  description text,
  reported_by uuid,
  reported_by_name text,
  resolution_notes text,
  resolved_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.client_id,
    c.first_name || ' ' || c.last_name,
    i.caregiver_user_id,
    cg.display_name,
    i.occurred_at,
    i.category,
    i.severity,
    i.status,
    i.description,
    i.reported_by,
    coalesce(rp.display_name, 'Unknown member'),
    i.resolution_notes,
    i.resolved_at
  from public.incidents i
  left join public.clients c on c.id = i.client_id
  left join public.user_profiles cg on cg.id = i.caregiver_user_id
  left join public.user_profiles rp on rp.id = i.reported_by
  where i.organization_id = target_organization_id
    and i.deleted_at is null
    and (
      public.has_permission(target_organization_id, 'incidents.read')
      or i.reported_by = auth.uid()
    )
    and (
      before_occurred_at is null
      or (i.occurred_at, i.id) < (before_occurred_at, before_id)
    )
  order by i.occurred_at desc, i.id desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_incidents(uuid, integer, timestamptz, uuid) from public;
grant execute on function public.list_incidents(uuid, integer, timestamptz, uuid) to authenticated;
revoke execute on function public.list_incidents(uuid, integer, timestamptz, uuid) from anon;

commit;
