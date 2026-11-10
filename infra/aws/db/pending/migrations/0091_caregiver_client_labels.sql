-- 0091 (PENDING: infra/aws/db/pending, not in the released set) | CLASS: ADDITIVE (two read functions gain one output column each; nothing stored changes)
-- Owner decision R23 (2026-11-10): what a caregiver sees for a client.
--   * assigned clients and visits: first name + last initial + client code   -> list_assigned_visit_clients.display_label
--   * open shifts:                 client code + city only                    -> list_open_shifts.city
-- Server-side: the label is computed here, only for a client the caller is assigned to or scheduled with. Not applied to any database.
-- Rollback: pending/rollback/0091_caregiver_client_labels.down.sql
drop function if exists ogevia_api.list_assigned_visit_clients(uuid);
create function ogevia_api.list_assigned_visit_clients(p_organization_id uuid)
returns table (
  client_id uuid,
  client_code text,
  next_scheduled_starts_at timestamptz,
  next_scheduled_ends_at timestamptz,
  active_service_count integer,
  next_scheduled_service_id uuid,
  display_label text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.has_permission(p_organization_id, 'visits.manage') as can_manage,
           ogevia.organization_local_date(p_organization_id, now()) as today
  )
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    next_shift.starts_at,
    next_shift.ends_at,
    (
      select count(distinct a.service_id)::integer
      from ogevia.client_authorizations a
      join ogevia.services sv on sv.id = a.service_id and sv.deleted_at is null and sv.is_active
      where a.organization_id = c.organization_id
        and a.client_id = c.id
        and a.is_current and a.deleted_at is null
        and ctx.today between a.period_start and a.period_end
        and (ctx.can_manage
             or ogevia.caregiver_has_active_assignment(p_organization_id, c.id, a.service_id)
             or ogevia.caregiver_has_current_shift(p_organization_id, c.id, a.service_id))
    ),
    next_shift.service_id,
    -- 0091 (owner decision R23): a caregiver sees first name + last initial for a client they are assigned to or scheduled with; never the full
    -- surname, never for a client they have no assignment or shift with (a manager who is not assigned gets none here: the Clients page has names).
    case when ogevia.caregiver_has_active_assignment(p_organization_id, c.id, null) or ogevia.caregiver_has_current_shift(p_organization_id, c.id, null)
         then (select nullif(btrim(concat_ws(' ', nullif(btrim(n.legal_first_name), ''), case when nullif(btrim(n.legal_last_name), '') is not null then upper(left(btrim(n.legal_last_name), 1)) || '.' end)), '')
                 from ogevia.client_private_names n where n.client_id = c.id)
    end
  from ctx
  cross join ogevia.clients c
  left join lateral (
    select s.starts_at, s.ends_at, s.service_id
    from ogevia.shifts s
    left join ogevia.caregiver_records cr
      on cr.id = s.caregiver_record_id and cr.deleted_at is null
    where s.organization_id = c.organization_id
      and s.client_id = c.id
      and s.status = 'scheduled'
      and ogevia.organization_local_date(p_organization_id, s.starts_at) = ctx.today
      and (ctx.can_manage or s.caregiver_user_id = ctx.actor or cr.linked_user_id = ctx.actor)
      and not ogevia.shift_is_called_out(s.id)
    order by s.starts_at
    limit 1
  ) next_shift on true
  where c.organization_id = p_organization_id
    and c.deleted_at is null
    and c.status = 'active'
    and ogevia.is_active_member(p_organization_id)
    and (ctx.can_manage
         or ogevia.caregiver_has_active_assignment(p_organization_id, c.id, null)
         or ogevia.caregiver_has_current_shift(p_organization_id, c.id, null))
  order by next_shift.starts_at nulls last,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code);
$$;
revoke all on function ogevia_api.list_assigned_visit_clients(uuid) from public;
grant execute on function ogevia_api.list_assigned_visit_clients(uuid) to ogevia_app;

drop function ogevia_api.list_open_shifts(uuid);
create function ogevia_api.list_open_shifts(p_organization_id uuid)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, coverage_state text, my_request_status text, city text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.id, s.starts_at, s.ends_at, floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
         coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code), sv.name,
         ogevia.shift_coverage_state(s),
         (select 'requested' from ogevia.shift_pickup_requests r join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id
           where r.shift_id = s.id and r.status = 'pending' and cr.linked_user_id = ogevia.require_actor() limit 1),
         -- 0091 (owner decision R23): an open shift shows the client CODE and CITY only, never a name.
         nullif(btrim(c.city), '')
  from ogevia.shifts s
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  where s.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.is_active_caregiver(p_organization_id)
    and s.status = 'scheduled' and s.ends_at > now() and s.starts_at < now() + interval '14 days'
    and ogevia.shift_coverage_state(s) = 'needs_coverage'
    and not ogevia.shift_is_care_request(s.id)
    and ogevia.caregiver_has_active_assignment(p_organization_id, s.client_id, s.service_id)
    and not exists (
      select 1 from ogevia.shift_coverage_events e
      join ogevia.caregiver_records cr on cr.id = e.original_caregiver_record_id
      where e.shift_id = s.id and e.event_type = 'called_out' and cr.linked_user_id = ogevia.require_actor()
    )
    and not exists (
      select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')
    )
  order by s.starts_at;
$$;
revoke all on function ogevia_api.list_open_shifts(uuid) from public;
grant execute on function ogevia_api.list_open_shifts(uuid) to ogevia_app;
