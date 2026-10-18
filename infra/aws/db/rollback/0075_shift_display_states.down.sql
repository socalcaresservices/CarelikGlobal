-- ROLLBACK 0075 | CLASS: SAFE AUTOMATED (no stored value changes; restores the 0053 list_shifts)
drop function ogevia_api.list_shifts(uuid, date, date, uuid);
create function ogevia_api.list_shifts(p_organization_id uuid, p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(shift_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, local_date date, coverage_state text, shift_status text, client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text, caregiver_record_id uuid, caregiver_code text, caregiver_name text, has_sign_in boolean, reserved_minutes integer, from_care_request boolean, has_visit boolean, last_callout_reason text, series_id uuid, availability_override boolean, availability_override_reason text, makeup_for_shift_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id)
             and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage')) as can_list,
           ogevia.has_permission(p_organization_id, 'clients.names.read') as can_names,
           o.timezone as tz
    from ogevia.organizations o where o.id = p_organization_id
  )
  select s.id, s.starts_at, s.ends_at, (s.starts_at at time zone ctx.tz)::date, ogevia.shift_coverage_state(s), s.status::text,
         c.id, c.client_code,
         case when ctx.can_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
         sv.id, sv.code, sv.name,
         cr.id, cr.caregiver_code, case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end,
         cr.linked_user_id is not null,
         r.reserved_minutes, ogevia.shift_is_care_request(s.id),
         exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')),
         (select e.reason from ogevia.shift_coverage_events e where e.shift_id = s.id and e.event_type = 'called_out' order by e.created_at desc limit 1),
         s.series_id, (ov.id is not null), ov.reason, s.makeup_for_shift_id
  from ctx
  join ogevia.shifts s on s.organization_id = p_organization_id
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = s.organization_id and cr.deleted_at is null
    and (cr.id = s.caregiver_record_id or (s.caregiver_record_id is null and cr.linked_user_id = s.caregiver_user_id))
  left join ogevia.client_private_names n on n.client_id = c.id
  -- 0047: the Admin availability override this shift was assigned under, if any (staff who can list shifts see that it happened and why).
  left join lateral (select o.id, o.reason from ogevia.availability_overrides o
                     where o.shift_id = s.id and o.consumed_at is not null order by o.consumed_at desc limit 1) ov on true
  -- 0032: only a reservation still held (a cancelled shift, or one whose visit was signed, holds nothing).
  left join ogevia.authorization_reservations r on r.shift_id = s.id and r.released_at is null
  where ctx.actor is not null and ctx.can_list
    and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62
    and (s.starts_at at time zone ctx.tz)::date between p_from and p_to
    and (p_client_id is null or s.client_id = p_client_id)
  order by s.starts_at, c.client_code;
$$;
revoke all on function ogevia_api.list_shifts(uuid, date, date, uuid) from public;
grant execute on function ogevia_api.list_shifts(uuid, date, date, uuid) to ogevia_app;
