begin;

-- Stage 2, item 3: the live Care Team detail page (workforce-detail-page.tsx,
-- routed at /team/:id) has never shown a caregiver's client assignments
-- or visit history - those existed only in caregiver-detail-page.tsx, a
-- ~900-line component no route has referenced since the workforce-record
-- model replaced the login-based one. This closes that gap on the live
-- page rather than reviving the dead one, and does it for every
-- caregiver, not just ones with a login (the dead page's caregiver_user_id
-- filtering could only ever have covered login-based caregivers anyway).
--
-- list_shifts() already joins caregiver_records and already gates
-- self-read on cr.linked_user_id = auth.uid() - it just never returned
-- caregiver_record_id in its SELECT list, so nothing could filter a
-- result set down to one workforce record. Adding it is a pure
-- additive column; every other column, join, and permission check is
-- unchanged from the current production definition. Postgres won't let
-- create-or-replace change a RETURNS TABLE column list, so this is a
-- real drop + recreate, with grants reasserted after (matching the
-- exact three-statement grant pattern list_shifts has carried since
-- data_api_grants_hardening).
drop function if exists public.list_shifts(uuid, timestamptz, timestamptz);

create function public.list_shifts(target_organization_id uuid, from_time timestamptz default null, to_time timestamptz default null)
returns table(id uuid, client_id uuid, client_name text, caregiver_user_id uuid, caregiver_record_id uuid, caregiver_name text, starts_at timestamptz, ends_at timestamptz, status shift_status, notes text, needs_coverage boolean, call_out_reason text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.client_id, coalesce(c.first_name || ' ' || c.last_name, 'Unknown client'), s.caregiver_user_id, s.caregiver_record_id,
    coalesce(cr.preferred_name || ' ' || cr.last_name, cr.first_name || ' ' || cr.last_name, p.display_name, 'Unknown caregiver'),
    s.starts_at, s.ends_at, s.status, s.notes,
    s.status = 'scheduled' and latest_event.event_type = 'called_out',
    case when latest_event.event_type = 'called_out' then latest_event.reason else null end
  from public.shifts s join public.clients c on c.id = s.client_id
  left join public.caregiver_records cr on cr.id = s.caregiver_record_id and cr.organization_id = s.organization_id
  left join public.user_profiles p on p.id = s.caregiver_user_id
  left join lateral (
    select e.event_type, e.reason from public.shift_coverage_events e
    where e.shift_id = s.id order by e.created_at desc limit 1
  ) latest_event on true
  where s.organization_id = target_organization_id
    and (public.has_permission(target_organization_id, 'shifts.read') or s.caregiver_user_id = auth.uid() or cr.linked_user_id = auth.uid())
    and (from_time is null or s.ends_at >= from_time) and (to_time is null or s.starts_at <= to_time)
  order by s.starts_at;
$$;

revoke all on function public.list_shifts(uuid, timestamptz, timestamptz) from public;
revoke all on function public.list_shifts(uuid, timestamptz, timestamptz) from anon;
grant execute on function public.list_shifts(uuid, timestamptz, timestamptz) to authenticated;

commit;
