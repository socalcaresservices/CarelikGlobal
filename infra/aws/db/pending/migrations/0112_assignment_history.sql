-- 0112 (PENDING: infra/aws/db/pending) | CLASS: ADDITIVE (one read function; no table, column or data change). Not applied to any database.
-- Owner request (2026-11-22): "see who changed an assignment and when". 0111 already writes one audit event per change (client.offices_set, client.service_county_set,
-- caregiver.offices_set, caregiver.service_counties_set, caregiver.color_set) with the before/after values and the actor. This function reads them back for ONE client or caregiver,
-- newest first, so the profile can show who changed what and when. Read only; tenant-scoped; permission-checked server-side. Rollback: pending/rollback/0112_assignment_history.down.sql.
create function ogevia_api.list_assignment_history(p_organization_id uuid, p_subject_type text, p_subject_id uuid, p_limit integer default 50)
returns table (occurred_at timestamptz, action text, actor_name text, before_state jsonb, after_state jsonb)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_client boolean := p_subject_type = 'client';
begin
  perform ogevia.require_actor();
  if p_subject_type not in ('client', 'caregiver') then raise exception 'Unknown record type' using errcode = 'OGV22'; end if;
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if v_client then
    if not (ogevia.has_permission(p_organization_id, 'clients.manage') or ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'visits.manage')) then
      raise exception 'You do not have permission to see this history' using errcode = 'OGA03';
    end if;
    if not exists (select 1 from ogevia.clients c where c.id = p_subject_id and c.organization_id = p_organization_id) then raise exception 'Record not found' using errcode = 'OGN04'; end if;
  else
    if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'visits.manage')) then
      raise exception 'You do not have permission to see this history' using errcode = 'OGA03';
    end if;
    if not exists (select 1 from ogevia.caregiver_records r where r.id = p_subject_id and r.organization_id = p_organization_id) then raise exception 'Record not found' using errcode = 'OGN04'; end if;
  end if;
  return query
  select e.occurred_at, e.action, u.display_name, e.before_state, e.after_state
    from ogevia.audit_events e left join ogevia.app_users u on u.id = e.actor_user_id
   where e.organization_id = p_organization_id and e.entity_id = p_subject_id
     and ((v_client and e.entity_type = 'clients' and e.action in ('client.offices_set', 'client.service_county_set'))
       or (not v_client and e.entity_type = 'caregiver_records' and e.action in ('caregiver.offices_set', 'caregiver.service_counties_set', 'caregiver.color_set')))
   order by e.occurred_at desc, e.id desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;
revoke all on function ogevia_api.list_assignment_history(uuid, text, uuid, integer) from public;
grant execute on function ogevia_api.list_assignment_history(uuid, text, uuid, integer) to ogevia_app;
