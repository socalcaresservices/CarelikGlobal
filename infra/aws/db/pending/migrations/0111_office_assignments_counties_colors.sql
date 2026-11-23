-- 0111 (PENDING: infra/aws/db/pending) | CLASS: ADDITIVE (two tables, five nullable columns, one function set). Not applied to any database.
-- Owner request (2026-11-22): identify which clients and caregivers belong to which office; filter by office and by county; give caregivers a colour.
--   * Offices gain an address and a county (properties of the OFFICE; changing them never changes anyone's assignment).
--   * office_assignments: zero, one or many offices per client or caregiver; when a person has any, EXACTLY ONE is primary (enforced by a deferred constraint trigger). The existing
--     clients.responsible_office_id (0110) keeps its meaning and is the client's PRIMARY office, kept in step by the one function that changes assignments; existing assignments are copied in as primary.
--   * Service county: one county per client (clients.service_county), several per caregiver (caregiver_service_counties). California counties only (58). Independent of offices, address, ZIP and availability.
--   * Caregiver colour: caregiver_records.profile_color, one of eight named colours (red, yellow, blue, green, purple, orange, teal, gray). Independent of office and county.
-- Permissions are the existing ones: offices need organization.update; client assignments/county need clients.manage; caregiver assignments/counties/colour need caregivers.manage; reading the facets needs any of
-- clients.names.read, billing.read, caregivers.manage, visits.manage, shifts.manage, organization.update. NOTHING here restricts access or scheduling: these are identification and filtering fields.
-- Every change is tenant-scoped, permission-checked server-side and audited. Rollback: pending/rollback/0111_office_assignments_counties_colors.down.sql.

create function ogevia.california_counties() returns text[] language sql immutable as $$ select array['Alameda', 'Alpine', 'Amador', 'Butte', 'Calaveras', 'Colusa', 'Contra Costa', 'Del Norte', 'El Dorado', 'Fresno', 'Glenn', 'Humboldt', 'Imperial', 'Inyo', 'Kern', 'Kings', 'Lake', 'Lassen', 'Los Angeles', 'Madera', 'Marin', 'Mariposa', 'Mendocino', 'Merced', 'Modoc', 'Mono', 'Monterey', 'Napa', 'Nevada', 'Orange', 'Placer', 'Plumas', 'Riverside', 'Sacramento', 'San Benito', 'San Bernardino', 'San Diego', 'San Francisco', 'San Joaquin', 'San Luis Obispo', 'San Mateo', 'Santa Barbara', 'Santa Clara', 'Santa Cruz', 'Shasta', 'Sierra', 'Siskiyou', 'Solano', 'Sonoma', 'Stanislaus', 'Sutter', 'Tehama', 'Trinity', 'Tulare', 'Tuolumne', 'Ventura', 'Yolo', 'Yuba']::text[] $$;

-- Case-insensitive match to the canonical county name; null for blank; an error for anything else.
create function ogevia.normalize_county(p_county text) returns text language plpgsql immutable set search_path = ogevia, pg_temp as $$
declare v text := nullif(btrim(coalesce(p_county, '')), ''); c text;
begin
  if v is null then return null; end if;
  select x into c from unnest(ogevia.california_counties()) x where lower(x) = lower(regexp_replace(v, '\s+county$', '', 'i')) limit 1;
  if c is null then raise exception 'Choose a California county' using errcode = 'OGV22'; end if;
  return c;
end;
$$;

alter table ogevia.offices
  add column address_line1 text check (address_line1 is null or length(btrim(address_line1)) between 1 and 200),
  add column city text check (city is null or length(btrim(city)) between 1 and 80),
  add column postal_code text check (postal_code is null or postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  add column county text check (county is null or county = any (ogevia.california_counties())),
  add column updated_by uuid references ogevia.app_users(id),
  add column updated_at timestamptz;

alter table ogevia.clients add column service_county text check (service_county is null or service_county = any (ogevia.california_counties()));
alter table ogevia.caregiver_records add column profile_color text check (profile_color is null or profile_color in ('red', 'yellow', 'blue', 'green', 'purple', 'orange', 'teal', 'gray'));

create table ogevia.caregiver_service_counties (
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  county text not null check (county = any (ogevia.california_counties())),
  set_by uuid not null references ogevia.app_users(id),
  set_at timestamptz not null default now(),
  primary key (caregiver_record_id, county),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
alter table ogevia.caregiver_service_counties enable row level security;
create policy readonly_select on ogevia.caregiver_service_counties for select to ogevia_readonly using (true);
grant select on ogevia.caregiver_service_counties to ogevia_readonly;

create table ogevia.office_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid,
  caregiver_record_id uuid,
  office_id uuid not null,
  is_primary boolean not null default false,
  assigned_by uuid not null references ogevia.app_users(id),
  assigned_at timestamptz not null default now(),
  check ((client_id is null) <> (caregiver_record_id is null)),
  foreign key (office_id, organization_id) references ogevia.offices (id, organization_id),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create unique index office_assignments_client_office on ogevia.office_assignments (client_id, office_id) where client_id is not null;
create unique index office_assignments_caregiver_office on ogevia.office_assignments (caregiver_record_id, office_id) where caregiver_record_id is not null;
create unique index office_assignments_client_primary on ogevia.office_assignments (client_id) where client_id is not null and is_primary;
create unique index office_assignments_caregiver_primary on ogevia.office_assignments (caregiver_record_id) where caregiver_record_id is not null and is_primary;
create index office_assignments_office_idx on ogevia.office_assignments (office_id);
alter table ogevia.office_assignments enable row level security;
create policy readonly_select on ogevia.office_assignments for select to ogevia_readonly using (true);
grant select on ogevia.office_assignments to ogevia_readonly;

-- A person with any office has exactly one primary office (checked when the transaction commits, so a replacement can be written in any order).
create function ogevia.office_assignments_primary_guard() returns trigger language plpgsql security definer set search_path = ogevia, pg_temp as $$   -- deferred triggers fire at COMMIT as the session role, which has no table privileges
declare v_client uuid := coalesce(new.client_id, old.client_id); v_cg uuid := coalesce(new.caregiver_record_id, old.caregiver_record_id); v_n int; v_p int;
begin
  select count(*), count(*) filter (where is_primary) into v_n, v_p from ogevia.office_assignments a
   where (v_client is not null and a.client_id = v_client) or (v_cg is not null and a.caregiver_record_id = v_cg);
  if v_n > 0 and v_p <> 1 then raise exception 'A person with offices must have exactly one primary office' using errcode = 'OGV22'; end if;
  return null;
end;
$$;
create constraint trigger office_assignments_primary_guard after insert or update or delete on ogevia.office_assignments
  deferrable initially deferred for each row execute function ogevia.office_assignments_primary_guard();

-- Existing 0110 assignments become primary assignments (nothing is guessed; offices without a client stay unassigned).
insert into ogevia.office_assignments (organization_id, client_id, office_id, is_primary, assigned_by)
select c.organization_id, c.id, c.responsible_office_id, true, o.created_by
  from ogevia.clients c join ogevia.offices o on o.id = c.responsible_office_id and o.organization_id = c.organization_id
 where c.responsible_office_id is not null and c.deleted_at is null;

create function ogevia_api.update_office(p_organization_id uuid, p_office_id uuid, p_name text, p_address_line1 text, p_city text, p_postal_code text, p_county text)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_o ogevia.offices%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_addr text := nullif(btrim(coalesce(p_address_line1, '')), '');
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_zip text := nullif(btrim(coalesce(p_postal_code, '')), '');
  v_county text := ogevia.normalize_county(p_county);
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency Administrator can manage offices' using errcode = 'OGA03'; end if;
  select * into v_o from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id for update;
  if v_o.id is null then raise exception 'Office not found' using errcode = 'OGN04'; end if;
  if length(v_name) not between 2 and 80 then raise exception 'Enter an office name between 2 and 80 characters' using errcode = 'OGV22'; end if;
  if v_addr is not null and length(v_addr) > 200 then raise exception 'The address is too long' using errcode = 'OGV22'; end if;
  if v_city is not null and length(v_city) > 80 then raise exception 'The city is too long' using errcode = 'OGV22'; end if;
  if v_zip is not null and v_zip !~ '^[0-9]{5}(-[0-9]{4})?$' then raise exception 'Enter a 5-digit ZIP code' using errcode = 'OGV22'; end if;
  if exists (select 1 from ogevia.offices o where o.organization_id = p_organization_id and o.id <> p_office_id and lower(btrim(o.name)) = lower(v_name)) then raise exception 'That office already exists' using errcode = 'OGC09'; end if;
  if (v_o.name, v_o.address_line1, v_o.city, v_o.postal_code, v_o.county) is not distinct from (v_name, v_addr, v_city, v_zip, v_county) then return 'unchanged'; end if;
  update ogevia.offices set name = v_name, address_line1 = v_addr, city = v_city, postal_code = v_zip, county = v_county, updated_by = v_actor, updated_at = now() where id = p_office_id;
  perform ogevia.write_audit(p_organization_id, 'office.updated', 'offices', p_office_id,
    jsonb_build_object('name', v_o.name, 'address', v_o.address_line1, 'city', v_o.city, 'postal_code', v_o.postal_code, 'county', v_o.county),
    jsonb_build_object('name', v_name, 'address', v_addr, 'city', v_city, 'postal_code', v_zip, 'county', v_county), null);
  return 'updated';
end;
$$;

create function ogevia_api.reactivate_office(p_organization_id uuid, p_office_id uuid)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_active boolean;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then raise exception 'Only the agency Administrator can manage offices' using errcode = 'OGA03'; end if;
  select o.is_active into v_active from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id for update;
  if not found then raise exception 'Office not found' using errcode = 'OGN04'; end if;
  if v_active then return 'already_active'; end if;
  update ogevia.offices set is_active = true, retired_by = null, retired_at = null, updated_by = v_actor, updated_at = now() where id = p_office_id;
  perform ogevia.write_audit(p_organization_id, 'office.reactivated', 'offices', p_office_id, jsonb_build_object('is_active', false), jsonb_build_object('is_active', true), null);
  return 'reactivated';
end;
$$;

-- Replace one person's whole office set: p_primary plus p_secondary. Offices already assigned may stay even if inactive; new ones must be active. Nothing is guessed or inherited.
create function ogevia_api.set_person_offices(p_organization_id uuid, p_subject_type text, p_subject_id uuid, p_primary_office_id uuid, p_secondary_office_ids uuid[] default '{}')
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_client boolean := p_subject_type = 'client';
  v_ids uuid[]; v_old jsonb; v_new jsonb; v_old_ids uuid[]; v_x uuid;
begin
  if p_subject_type not in ('client', 'caregiver') then raise exception 'Unknown record type' using errcode = 'OGV22'; end if;
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, case when v_client then 'clients.manage' else 'caregivers.manage' end) then
    raise exception 'You do not have permission to change office assignments' using errcode = 'OGA03';
  end if;
  if v_client then
    perform 1 from ogevia.clients c where c.id = p_subject_id and c.organization_id = p_organization_id and c.deleted_at is null for update;
  else
    perform 1 from ogevia.caregiver_records r where r.id = p_subject_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  end if;
  if not found then raise exception 'Record not found' using errcode = 'OGN04'; end if;
  v_ids := array(select distinct x from unnest(coalesce(p_secondary_office_ids, '{}') || coalesce(array[p_primary_office_id], '{}')) x where x is not null);
  if p_primary_office_id is null and cardinality(v_ids) > 0 then raise exception 'Choose a primary office' using errcode = 'OGV22'; end if;
  if cardinality(v_ids) > 20 then raise exception 'Too many offices' using errcode = 'OGV22'; end if;
  select coalesce(array_agg(a.office_id order by a.is_primary desc, a.office_id), '{}'), coalesce(jsonb_build_object('primary', (array_agg(a.office_id) filter (where a.is_primary))[1], 'offices', jsonb_agg(a.office_id order by a.is_primary desc, a.office_id)), jsonb_build_object('primary', null, 'offices', '[]'::jsonb))
    into v_old_ids, v_old from ogevia.office_assignments a
   where a.organization_id = p_organization_id and ((v_client and a.client_id = p_subject_id) or (not v_client and a.caregiver_record_id = p_subject_id));
  foreach v_x in array v_ids loop
    if not exists (select 1 from ogevia.offices o where o.id = v_x and o.organization_id = p_organization_id) then raise exception 'Office not found' using errcode = 'OGN04'; end if;
    if not (v_x = any (v_old_ids)) and not exists (select 1 from ogevia.offices o where o.id = v_x and o.organization_id = p_organization_id and o.is_active) then
      raise exception 'Choose an active office' using errcode = 'OGV22';
    end if;
  end loop;
  v_new := jsonb_build_object('primary', p_primary_office_id, 'offices', coalesce((select jsonb_agg(x order by (x = p_primary_office_id) desc, x) from unnest(v_ids) x), '[]'::jsonb));
  if (v_old -> 'primary') is not distinct from (v_new -> 'primary') and (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(v_old -> 'offices') x) is not distinct from (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(v_new -> 'offices') x) then
    return 'unchanged';
  end if;
  delete from ogevia.office_assignments a where a.organization_id = p_organization_id and ((v_client and a.client_id = p_subject_id) or (not v_client and a.caregiver_record_id = p_subject_id)) and not (a.office_id = any (v_ids));
  update ogevia.office_assignments a set is_primary = false where a.organization_id = p_organization_id and ((v_client and a.client_id = p_subject_id) or (not v_client and a.caregiver_record_id = p_subject_id)) and a.is_primary and a.office_id is distinct from p_primary_office_id;
  foreach v_x in array v_ids loop
    insert into ogevia.office_assignments (organization_id, client_id, caregiver_record_id, office_id, is_primary, assigned_by)
    values (p_organization_id, case when v_client then p_subject_id end, case when not v_client then p_subject_id end, v_x, v_x = p_primary_office_id, v_actor)
    on conflict do nothing;
  end loop;
  update ogevia.office_assignments a set is_primary = true where a.organization_id = p_organization_id and a.office_id = p_primary_office_id and ((v_client and a.client_id = p_subject_id) or (not v_client and a.caregiver_record_id = p_subject_id)) and not a.is_primary;
  if v_client then update ogevia.clients set responsible_office_id = p_primary_office_id where id = p_subject_id; end if;
  perform ogevia.write_audit(p_organization_id, case when v_client then 'client.offices_set' else 'caregiver.offices_set' end, case when v_client then 'clients' else 'caregiver_records' end, p_subject_id, v_old, v_new, null);
  return 'set';
end;
$$;

-- 0110's single-office function keeps working: it sets exactly that office as the only (primary) one, or clears all.
create or replace function ogevia_api.set_client_office(p_organization_id uuid, p_client_id uuid, p_office_id uuid)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_r text;
begin
  v_r := ogevia_api.set_person_offices(p_organization_id, 'client', p_client_id, p_office_id, '{}');
  return case when v_r = 'unchanged' then 'unchanged' when p_office_id is null then 'cleared' else 'set' end;
end;
$$;

create function ogevia_api.set_client_service_county(p_organization_id uuid, p_client_id uuid, p_county text)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_old text; v_new text := ogevia.normalize_county(p_county);
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to manage clients' using errcode = 'OGA03'; end if;
  select c.service_county into v_old from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null for update;
  if not found then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if v_old is not distinct from v_new then return 'unchanged'; end if;
  update ogevia.clients set service_county = v_new where id = p_client_id;
  perform ogevia.write_audit(p_organization_id, 'client.service_county_set', 'clients', p_client_id, jsonb_build_object('service_county', v_old), jsonb_build_object('service_county', v_new), null);
  return case when v_new is null then 'cleared' else 'set' end;
end;
$$;

create function ogevia_api.set_caregiver_service_counties(p_organization_id uuid, p_caregiver_record_id uuid, p_counties text[])
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_old text[]; v_new text[];
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then raise exception 'You do not have permission to manage caregivers' using errcode = 'OGA03'; end if;
  perform 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if not found then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  v_new := array(select distinct ogevia.normalize_county(x) from unnest(coalesce(p_counties, '{}')) x where nullif(btrim(coalesce(x, '')), '') is not null order by 1);
  if cardinality(v_new) > 58 then raise exception 'Too many counties' using errcode = 'OGV22'; end if;
  select coalesce(array_agg(county order by county), '{}') into v_old from ogevia.caregiver_service_counties where caregiver_record_id = p_caregiver_record_id;
  if v_old = v_new then return 'unchanged'; end if;
  delete from ogevia.caregiver_service_counties where caregiver_record_id = p_caregiver_record_id and not (county = any (v_new));
  insert into ogevia.caregiver_service_counties (organization_id, caregiver_record_id, county, set_by) select p_organization_id, p_caregiver_record_id, x, v_actor from unnest(v_new) x on conflict do nothing;
  perform ogevia.write_audit(p_organization_id, 'caregiver.service_counties_set', 'caregiver_records', p_caregiver_record_id, jsonb_build_object('counties', to_jsonb(v_old)), jsonb_build_object('counties', to_jsonb(v_new)), null);
  return 'set';
end;
$$;

create function ogevia_api.set_caregiver_color(p_organization_id uuid, p_caregiver_record_id uuid, p_color text)
returns text language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare v_actor uuid := ogevia.require_actor(); v_old text; v_new text := lower(nullif(btrim(coalesce(p_color, '')), ''));
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then raise exception 'You do not have permission to manage caregivers' using errcode = 'OGA03'; end if;
  if v_new is not null and v_new not in ('red', 'yellow', 'blue', 'green', 'purple', 'orange', 'teal', 'gray') then raise exception 'Choose one of the listed colors' using errcode = 'OGV22'; end if;
  select r.profile_color into v_old from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if not found then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_old is not distinct from v_new then return 'unchanged'; end if;
  update ogevia.caregiver_records set profile_color = v_new where id = p_caregiver_record_id;
  perform ogevia.write_audit(p_organization_id, 'caregiver.color_set', 'caregiver_records', p_caregiver_record_id, jsonb_build_object('color', v_old), jsonb_build_object('color', v_new), null);
  return case when v_new is null then 'cleared' else 'set' end;
end;
$$;

-- The offices list gains the address, county and counts of both kinds of record (the function is recreated: its result gained columns).
drop function ogevia_api.list_offices(uuid);
create function ogevia_api.list_offices(p_organization_id uuid)
returns table (office_id uuid, name text, is_active boolean, client_count integer, address_line1 text, city text, postal_code text, county text, caregiver_count integer)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select o.id, o.name, o.is_active,
         (select count(*)::integer from ogevia.office_assignments a join ogevia.clients c on c.id = a.client_id where a.office_id = o.id and c.deleted_at is null),
         o.address_line1, o.city, o.postal_code, o.county,
         (select count(*)::integer from ogevia.office_assignments a join ogevia.caregiver_records r on r.id = a.caregiver_record_id where a.office_id = o.id and r.deleted_at is null)
  from ogevia.offices o
  where o.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'billing.read')
         or ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'visits.manage')
         or ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'organization.update'))
  order by o.is_active desc, lower(o.name);
$$;

-- 0110's list of client offices now reads the assignments (primary office only, as before).
create or replace function ogevia_api.list_client_offices(p_organization_id uuid)
returns table (client_id uuid, client_code text, office_id uuid)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select c.id, c.client_code, a.office_id
  from ogevia.clients c join ogevia.office_assignments a on a.client_id = c.id and a.is_primary
  where c.organization_id = p_organization_id and c.deleted_at is null
    and ogevia.require_actor() is not null and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'billing.read'))
  order by c.client_code;
$$;

-- One read for the lists: who is assigned to which offices (primary flagged), service counties and caregiver colours. Codes only, no names.
create function ogevia_api.list_people_facets(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'billing.read') or ogevia.has_permission(p_organization_id, 'caregivers.manage')
          or ogevia.has_permission(p_organization_id, 'visits.manage') or ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'organization.update')) then
    raise exception 'You do not have permission to see this' using errcode = 'OGA03';
  end if;
  return jsonb_build_object(
    'clientOffices', coalesce((select jsonb_agg(jsonb_build_object('clientId', c.id, 'clientCode', c.client_code, 'officeId', a.office_id, 'isPrimary', a.is_primary) order by c.client_code, a.is_primary desc, a.office_id)
       from ogevia.office_assignments a join ogevia.clients c on c.id = a.client_id where a.organization_id = p_organization_id and c.deleted_at is null), '[]'::jsonb),
    'caregiverOffices', coalesce((select jsonb_agg(jsonb_build_object('caregiverRecordId', r.id, 'caregiverCode', r.caregiver_code, 'officeId', a.office_id, 'isPrimary', a.is_primary) order by r.caregiver_code, a.is_primary desc, a.office_id)
       from ogevia.office_assignments a join ogevia.caregiver_records r on r.id = a.caregiver_record_id where a.organization_id = p_organization_id and r.deleted_at is null), '[]'::jsonb),
    'clientCounties', coalesce((select jsonb_agg(jsonb_build_object('clientId', c.id, 'county', c.service_county) order by c.client_code) from ogevia.clients c
       where c.organization_id = p_organization_id and c.deleted_at is null and c.service_county is not null), '[]'::jsonb),
    'caregiverCounties', coalesce((select jsonb_agg(jsonb_build_object('caregiverRecordId', s.caregiver_record_id, 'county', s.county) order by s.caregiver_record_id, s.county)
       from ogevia.caregiver_service_counties s join ogevia.caregiver_records r on r.id = s.caregiver_record_id where s.organization_id = p_organization_id and r.deleted_at is null), '[]'::jsonb),
    'caregiverColors', coalesce((select jsonb_agg(jsonb_build_object('caregiverRecordId', r.id, 'userId', r.linked_user_id, 'color', r.profile_color) order by r.caregiver_code) from ogevia.caregiver_records r
       where r.organization_id = p_organization_id and r.deleted_at is null and r.profile_color is not null), '[]'::jsonb));
end;
$$;

revoke all on function ogevia.california_counties() from public;
revoke all on function ogevia.normalize_county(text) from public;
revoke all on function ogevia_api.update_office(uuid, uuid, text, text, text, text, text) from public;
revoke all on function ogevia_api.reactivate_office(uuid, uuid) from public;
revoke all on function ogevia_api.set_person_offices(uuid, text, uuid, uuid, uuid[]) from public;
revoke all on function ogevia_api.set_client_service_county(uuid, uuid, text) from public;
revoke all on function ogevia_api.set_caregiver_service_counties(uuid, uuid, text[]) from public;
revoke all on function ogevia_api.set_caregiver_color(uuid, uuid, text) from public;
revoke all on function ogevia_api.list_offices(uuid) from public;
revoke all on function ogevia_api.list_people_facets(uuid) from public;
grant execute on function ogevia_api.update_office(uuid, uuid, text, text, text, text, text) to ogevia_app;
grant execute on function ogevia_api.reactivate_office(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_person_offices(uuid, text, uuid, uuid, uuid[]) to ogevia_app;
grant execute on function ogevia_api.set_client_service_county(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_service_counties(uuid, uuid, text[]) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_color(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.list_offices(uuid) to ogevia_app;
grant execute on function ogevia_api.list_people_facets(uuid) to ogevia_app;
