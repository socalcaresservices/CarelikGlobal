-- Expose only the name of a client on a visit or shift already visible to this user.
create function ogevia_api.caregiver_visible_client_name(p_org uuid, p_record uuid, p_kind text)
returns text language sql stable security definer set search_path = ogevia, pg_temp as $$
  select nullif(btrim(concat_ws(' ', n.legal_first_name, n.legal_last_name)), '')
  from ogevia.clients c
  join ogevia.client_private_names n on n.client_id=c.id
  where c.organization_id=p_org and c.deleted_at is null and c.id = case p_kind
    when 'client' then (select a.client_id from ogevia_api.list_assigned_visit_clients(p_org) a where a.client_id=p_record)
    when 'shift' then (select s.client_id from ogevia_api.list_my_shifts(p_org) a
      join ogevia.shifts s on s.id=a.shift_id and s.organization_id=p_org where a.shift_id=p_record)
    when 'visit' then (select v.client_id from ogevia_api.get_active_service_visit(p_org) a
      join ogevia.service_visits v on v.id=a.visit_id and v.organization_id=p_org where a.visit_id=p_record)
  end;
$$;
revoke all on function ogevia_api.caregiver_visible_client_name(uuid,uuid,text) from public;
grant execute on function ogevia_api.caregiver_visible_client_name(uuid,uuid,text) to ogevia_app;
