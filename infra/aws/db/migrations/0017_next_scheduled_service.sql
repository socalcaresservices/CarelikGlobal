-- 0017 Caregiver start screen: the service of today's scheduled visit.
--
-- list_assigned_visit_clients returned the caller's next shift today
-- (next_scheduled_starts_at / _ends_at) but not its service, so a caregiver
-- whose client has several authorized services had to pick one. Picking a
-- different service than the shift's leaves the visit unlinked from its
-- schedule (match_scheduled_shift_for_visit matches client AND service).
--
-- Now: new trailing column next_scheduled_service_id = that same shift's
-- service (null when there is no shift today, or the shift has no service).
-- The shift row is the one already selected (same filters: caller's own,
-- 'scheduled', not called out, organization-local today); access rules,
-- search_path and ordering are unchanged. The return type changes, so the
-- function is dropped, recreated and re-granted to ogevia_app only.

drop function if exists ogevia_api.list_assigned_visit_clients(uuid);
create function ogevia_api.list_assigned_visit_clients(p_organization_id uuid)
returns table (
  client_id uuid,
  client_code text,
  next_scheduled_starts_at timestamptz,
  next_scheduled_ends_at timestamptz,
  active_service_count integer,
  next_scheduled_service_id uuid
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
    next_shift.service_id
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
