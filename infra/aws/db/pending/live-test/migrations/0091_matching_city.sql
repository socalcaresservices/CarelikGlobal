-- Optional office-entered city paired with the matching ZIP.
alter table ogevia.caregiver_zip add column city text check (length(city) between 1 and 100);
alter table ogevia.client_service_zip add column city text check (length(city) between 1 and 100);
create or replace function ogevia_api.set_caregiver_zip(p_organization_id uuid, p_caregiver_record_id uuid, p_zip text)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.matching_manage_guard(p_organization_id);
begin
  if p_zip !~ '^[0-9]{5}$' then raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.caregiver_zip (organization_id, caregiver_record_id, zip, set_by) values (p_organization_id, p_caregiver_record_id, p_zip, v_actor)
  on conflict (caregiver_record_id) do update set city = case when caregiver_zip.zip = excluded.zip then caregiver_zip.city end, zip = excluded.zip, set_by = v_actor, set_at = now();
  perform ogevia.write_audit(p_organization_id, 'caregiver_zip.set', 'caregiver_records', p_caregiver_record_id, null, jsonb_build_object('zip_set', true), null);
end;
$$;
create function ogevia_api.set_caregiver_zip(p_organization_id uuid, p_record_id uuid, p_zip text, p_city text)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia_api.set_caregiver_zip(p_organization_id, p_record_id, p_zip);
  update ogevia.caregiver_zip set city = nullif(btrim(p_city), '')
   where organization_id = p_organization_id and caregiver_record_id = p_record_id;
end;
$$;
revoke all on function ogevia_api.set_caregiver_zip(uuid, uuid, text, text) from public;
grant execute on function ogevia_api.set_caregiver_zip(uuid, uuid, text, text) to ogevia_app;
create or replace function ogevia_api.set_client_service_zip(p_organization_id uuid, p_client_id uuid, p_zip text)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.matching_manage_guard(p_organization_id);
begin
  if p_zip !~ '^[0-9]{5}$' then raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  insert into ogevia.client_service_zip (organization_id, client_id, zip, set_by) values (p_organization_id, p_client_id, p_zip, v_actor)
  on conflict (client_id) do update set city = case when client_service_zip.zip = excluded.zip then client_service_zip.city end, zip = excluded.zip, set_by = v_actor, set_at = now();
  perform ogevia.write_audit(p_organization_id, 'client_zip.set', 'clients', p_client_id, null, jsonb_build_object('zip_set', true), null);
end;
$$;
create function ogevia_api.set_client_service_zip(p_organization_id uuid, p_record_id uuid, p_zip text, p_city text)
returns void language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia_api.set_client_service_zip(p_organization_id, p_record_id, p_zip);
  update ogevia.client_service_zip set city = nullif(btrim(p_city), '')
   where organization_id = p_organization_id and client_id = p_record_id;
end;
$$;
revoke all on function ogevia_api.set_client_service_zip(uuid, uuid, text, text) from public;
grant execute on function ogevia_api.set_client_service_zip(uuid, uuid, text, text) to ogevia_app;
create or replace function ogevia_api.get_matching_zip(p_organization_id uuid, p_record_id uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_zip text; v_city text;
begin
  perform ogevia.matching_manage_guard(p_organization_id);
  if p_kind = 'caregiver' then
    if not exists (select 1 from ogevia.caregiver_records r where r.id = p_record_id and r.organization_id = p_organization_id and r.deleted_at is null)
      then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
    select z.zip, z.city into v_zip, v_city from ogevia.caregiver_zip z where z.caregiver_record_id = p_record_id and z.organization_id = p_organization_id;
  elsif p_kind = 'client' then
    if not exists (select 1 from ogevia.clients c where c.id = p_record_id and c.organization_id = p_organization_id and c.deleted_at is null)
      then raise exception 'Client not found' using errcode = 'OGN04'; end if;
    select z.zip, z.city into v_zip, v_city from ogevia.client_service_zip z where z.client_id = p_record_id and z.organization_id = p_organization_id;
  else raise exception 'Invalid location record type' using errcode = 'OGV22'; end if;
  return jsonb_build_object('zip', v_zip, 'city', v_city);
end;
$$;
