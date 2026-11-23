-- Keep the assigned caregiver's recent and cancelled shifts visible on their calendar.
create or replace function ogevia_api.list_my_shifts(p_organization_id uuid)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, client_code text, service_name text, coverage_state text, can_call_out boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.id, s.starts_at, s.ends_at, coalesce(c.caregiver_display_code, c.client_code), sv.name,
         case when s.status = 'cancelled' then 'cancelled' when ogevia.shift_is_called_out(s.id) then 'called_out' else ogevia.shift_coverage_state(s) end,
         s.status = 'scheduled' and s.starts_at > now() and not ogevia.shift_is_called_out(s.id) and not ogevia.shift_is_care_request(s.id)
  from ogevia.shifts s
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.id = s.caregiver_record_id and cr.organization_id = s.organization_id and cr.deleted_at is null
  where s.organization_id = p_organization_id and ogevia.is_active_member(p_organization_id)
    and (s.caregiver_user_id = ogevia.require_actor() or cr.linked_user_id = ogevia.require_actor())
    and s.status in ('scheduled', 'cancelled', 'completed')
    and s.starts_at >= now() - interval '7 days' and s.starts_at < now() + interval '14 days'
  order by s.starts_at;
$$;
