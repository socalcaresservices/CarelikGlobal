-- 0118 Client service location: the service address (city and ZIP), service county and coordinating office are read and saved TOGETHER, once.
-- Needs 0110/0111 (offices, counties) and 0113 (cover alerts). Nothing here changes a stored address, county or office assignment except the gap-fill below.
--
-- BEFORE: a client had TWO city values: clients.city (the "Details" city) and client_service_zip.city (the service address used for matching and open-shift alerts), edited in two
--   places, so one screen could say "No city" while another said "Winchester". The county and the office were two more controls elsewhere.
-- NOW:
--   * The service address (client_service_zip: ZIP + city) is the source for city and ZIP everywhere. clients.city is kept IN STEP with it by a trigger (so every older screen, report and
--     filter that reads clients.city shows the same city), and existing clients whose clients.city is empty but who have a service-address city get it filled once, below. A client whose two
--     cities DIFFER is not touched by the gap-fill: the service city is already what matching and alerts use, and the next save of the service address aligns clients.city.
--   * get_client_service_location: one read: city, ZIP, county, coordinating office, what is missing, and a county SUGGESTION with its basis.
--   * set_client_service_location: one transaction: the city and ZIP, the county, and the coordinating office (the client's PRIMARY office; other assigned offices are kept). A null
--     county or office means "leave as it is" is NOT assumed: the county is always written as given (blank clears it); the office is left as it is only when null.
--   * County suggestion: from agency records (the most common county among the agency's other clients with the same ZIP) or, when a platform ZIP-to-county reference has been loaded
--     (zip_county_reference, EMPTY until the owner approves a dataset with its licence), from that. It is only a suggestion: authorized staff choose.
--   * Coordinating office of a shift: the shift's own choice, else the client's coordinating office (0117), else the agency's only office, else the sender must choose.
-- Rollback drops the new objects (the stored city, county and office values stay as they are).

-- reference data, shared by all agencies; EMPTY until a dataset with its source, licence and vintage is loaded by a platform administrator. No dataset ships with Ogevia.
create table ogevia.zip_county_reference (
  zip text primary key check (zip ~ '^[0-9]{5}$'),
  county text not null check (county = any (ogevia.california_counties())),
  source text not null check (length(btrim(source)) >= 3),
  licence text not null check (length(btrim(licence)) >= 3),
  vintage text not null check (length(btrim(vintage)) >= 2),
  loaded_at timestamptz not null default now()
);
alter table ogevia.zip_county_reference enable row level security;
revoke all on ogevia.zip_county_reference from public;

-- fill gaps once: the service city is known but the Details city is empty
update ogevia.clients c set city = z.city
  from ogevia.client_service_zip z
 where z.client_id = c.id and z.organization_id = c.organization_id and z.city is not null and (c.city is null or btrim(c.city) = '');

-- keep clients.city in step with the service address from now on
create function ogevia.client_service_zip_sync_city() returns trigger language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  if new.city is not null then
    update ogevia.clients set city = new.city where id = new.client_id and organization_id = new.organization_id and city is distinct from new.city;
  end if;
  return null;
end;
$$;
revoke all on function ogevia.client_service_zip_sync_city() from public;
create trigger client_service_zip_sync_city after insert or update of city on ogevia.client_service_zip for each row execute function ogevia.client_service_zip_sync_city();

-- county suggestion: { county, basis } or null
create function ogevia.client_county_suggestion(p_organization_id uuid, p_client_id uuid, p_zip text)
returns jsonb language plpgsql stable set search_path = ogevia, pg_temp as $$
declare v_county text;
begin
  if p_zip is null or p_zip !~ '^[0-9]{5}$' then return null; end if;
  select r.county into v_county from ogevia.zip_county_reference r where r.zip = p_zip;
  if v_county is not null then return jsonb_build_object('county', v_county, 'basis', 'zip_reference'); end if;
  select c.service_county into v_county
    from ogevia.client_service_zip z join ogevia.clients c on c.id = z.client_id and c.organization_id = z.organization_id
   where z.organization_id = p_organization_id and z.zip = p_zip and c.id <> p_client_id and c.deleted_at is null and c.service_county is not null
   group by c.service_county order by count(*) desc, c.service_county limit 1;
  if v_county is not null then return jsonb_build_object('county', v_county, 'basis', 'agency_clients'); end if;
  return null;
end;
$$;
revoke all on function ogevia.client_county_suggestion(uuid, uuid, text) from public;

create function ogevia_api.get_client_service_location(p_organization_id uuid, p_client_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare v_c ogevia.clients%rowtype; v_zip text; v_city text; v_office uuid; v_office_name text; v_missing text[] := '{}'; v_other jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to manage clients' using errcode = 'OGA03'; end if;
  select * into v_c from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null;
  if v_c.id is null then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  select z.zip, coalesce(nullif(btrim(z.city), ''), nullif(btrim(v_c.city), '')) into v_zip, v_city from ogevia.client_service_zip z where z.client_id = p_client_id;
  v_city := coalesce(v_city, nullif(btrim(v_c.city), ''));
  if v_city is null then v_missing := array_append(v_missing, 'city'); end if;
  if v_zip is null then v_missing := array_append(v_missing, 'zip'); end if;
  select o.id, o.name into v_office, v_office_name from ogevia.offices o where o.id = v_c.responsible_office_id and o.organization_id = p_organization_id;
  select coalesce(jsonb_agg(jsonb_build_object('officeId', o.id, 'name', o.name) order by lower(o.name)), '[]'::jsonb) into v_other
    from ogevia.office_assignments a join ogevia.offices o on o.id = a.office_id where a.client_id = p_client_id and a.organization_id = p_organization_id and not a.is_primary;
  return jsonb_build_object('city', v_city, 'zip', v_zip, 'state', 'CA', 'county', v_c.service_county,
    'office', case when v_office is null then null else jsonb_build_object('officeId', v_office, 'name', v_office_name) end, 'otherOffices', v_other,
    'missing', to_jsonb(v_missing), 'complete', cardinality(v_missing) = 0,
    'countySuggestion', case when v_c.service_county is null then ogevia.client_county_suggestion(p_organization_id, p_client_id, v_zip) end);
end;
$$;

-- one save: city and ZIP, county, coordinating office. The county is written as given (blank clears it); a null office leaves the office as it is; changing the office keeps the other offices.
create function ogevia_api.set_client_service_location(p_organization_id uuid, p_client_id uuid, p_city text, p_zip text, p_county text, p_office_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor(); v_city text := nullif(btrim(coalesce(p_city, '')), ''); v_zip text := nullif(btrim(coalesce(p_zip, '')), '');
  v_county text := ogevia.normalize_county(p_county); v_old jsonb; v_primary uuid; v_secondary uuid[]; v_changed text[] := '{}';
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to manage clients' using errcode = 'OGA03'; end if;
  perform 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null for update;
  if not found then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if v_city is null or length(v_city) > 80 then raise exception 'Enter the city of the service address' using errcode = 'OGV22'; end if;
  if v_zip is null or v_zip !~ '^[0-9]{5}$' then raise exception 'Enter the 5-digit ZIP code of the service address' using errcode = 'OGV22'; end if;
  if p_office_id is not null and not exists (select 1 from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id and o.is_active)
     and not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.responsible_office_id = p_office_id) then
    raise exception 'Choose an active office' using errcode = 'OGV22';
  end if;
  v_old := ogevia_api.get_client_service_location(p_organization_id, p_client_id);
  -- service address (ZIP + city); the trigger keeps the Details city in step
  insert into ogevia.client_service_zip (organization_id, client_id, zip, city, set_by) values (p_organization_id, p_client_id, v_zip, v_city, v_actor)
  on conflict (client_id) do update set zip = excluded.zip, city = excluded.city, set_by = v_actor, set_at = now();
  update ogevia.clients set city = v_city where id = p_client_id and city is distinct from v_city;
  if (v_old ->> 'zip') is distinct from v_zip or (v_old ->> 'city') is distinct from v_city then v_changed := array_append(v_changed, 'address'); end if;
  if (v_old ->> 'county') is distinct from v_county then
    update ogevia.clients set service_county = v_county where id = p_client_id; v_changed := array_append(v_changed, 'county');
  end if;
  if p_office_id is not null and (v_old -> 'office' ->> 'officeId') is distinct from p_office_id::text then
    select array(select a.office_id from ogevia.office_assignments a where a.client_id = p_client_id and a.organization_id = p_organization_id and a.office_id <> p_office_id order by a.office_id) into v_secondary;   -- every office the client already has stays (the old primary becomes a secondary)
    perform ogevia_api.set_person_offices(p_organization_id, 'client', p_client_id, p_office_id, v_secondary);
    v_changed := array_append(v_changed, 'office');
  end if;
  perform ogevia.write_audit(p_organization_id, 'client.service_location_set', 'clients', p_client_id,
    jsonb_build_object('county', v_old -> 'county', 'officeId', v_old -> 'office' -> 'officeId', 'complete', v_old -> 'complete'),
    jsonb_build_object('changed', to_jsonb(v_changed), 'county', v_county, 'officeId', p_office_id), null);   -- no address, city or ZIP in the audit row
  return ogevia_api.get_client_service_location(p_organization_id, p_client_id);
end;
$$;

-- (the coordinating office of a shift, cover_office_for in 0117, already falls back to the client's coordinating office: the shift's own choice, else the client's, else the agency's only office)

revoke all on function ogevia_api.get_client_service_location(uuid, uuid) from public;
revoke all on function ogevia_api.set_client_service_location(uuid, uuid, text, text, text, uuid) from public;
grant execute on function ogevia_api.get_client_service_location(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_service_location(uuid, uuid, text, text, text, uuid) to ogevia_app;
