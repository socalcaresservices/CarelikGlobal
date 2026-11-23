-- Rollback of 0111 (PENDING). Restores the 0110 functions, then drops the assignment table, the county and colour data and the office address columns.
-- LOST by this rollback: secondary offices, all caregiver office assignments, service counties, caregiver colours, office addresses and counties (the audit events keep who set what).
-- KEPT: each client's PRIMARY office (clients.responsible_office_id was kept in step), so 0110's single "responsible office" is intact.
drop function if exists ogevia_api.list_people_facets(uuid);
drop function if exists ogevia_api.set_caregiver_color(uuid, uuid, text);
drop function if exists ogevia_api.set_caregiver_service_counties(uuid, uuid, text[]);
drop function if exists ogevia_api.set_client_service_county(uuid, uuid, text);
drop function if exists ogevia_api.list_offices(uuid);
create function ogevia_api.list_offices(p_organization_id uuid)
returns table (office_id uuid, name text, is_active boolean, client_count integer)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select o.id, o.name, o.is_active,
         (select count(*)::integer from ogevia.clients c where c.responsible_office_id = o.id and c.organization_id = o.organization_id and c.deleted_at is null)
  from ogevia.offices o
  where o.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'billing.read')
         or ogevia.has_permission(p_organization_id, 'organization.update'))
  order by o.is_active desc, lower(o.name);
$$;
revoke all on function ogevia_api.list_offices(uuid) from public;
grant execute on function ogevia_api.list_offices(uuid) to ogevia_app;
create or replace function ogevia_api.list_client_offices(p_organization_id uuid)
returns table (client_id uuid, client_code text, office_id uuid)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select c.id, c.client_code, c.responsible_office_id
  from ogevia.clients c
  where c.organization_id = p_organization_id and c.deleted_at is null and c.responsible_office_id is not null
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'billing.read'))
  order by c.client_code;
$$;
create or replace function ogevia_api.set_client_office(p_organization_id uuid, p_client_id uuid, p_office_id uuid)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_old uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then
    raise exception 'You do not have permission to manage clients' using errcode = 'OGA03';
  end if;
  select c.responsible_office_id into v_old from ogevia.clients c
   where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null for update;
  if not found then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if p_office_id is not null and not exists (select 1 from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id and o.is_active) then
    raise exception 'Choose an active office' using errcode = 'OGV22';
  end if;
  if v_old is not distinct from p_office_id then return 'unchanged'; end if;
  update ogevia.clients set responsible_office_id = p_office_id where id = p_client_id;
  perform ogevia.write_audit(p_organization_id, 'client.office_set', 'clients', p_client_id,
    jsonb_build_object('responsible_office_id', v_old), jsonb_build_object('responsible_office_id', p_office_id), null);
  return case when p_office_id is null then 'cleared' else 'set' end;
end;
$$;
drop function if exists ogevia_api.set_person_offices(uuid, text, uuid, uuid, uuid[]);
drop function if exists ogevia_api.reactivate_office(uuid, uuid);
drop function if exists ogevia_api.update_office(uuid, uuid, text, text, text, text, text);
drop table if exists ogevia.office_assignments;
drop function if exists ogevia.office_assignments_primary_guard();
drop table if exists ogevia.caregiver_service_counties;
alter table ogevia.caregiver_records drop column if exists profile_color;
alter table ogevia.clients drop column if exists service_county;
alter table ogevia.offices drop column if exists address_line1, drop column if exists city, drop column if exists postal_code, drop column if exists county, drop column if exists updated_by, drop column if exists updated_at;
drop function if exists ogevia.normalize_county(text);
drop function if exists ogevia.california_counties();
