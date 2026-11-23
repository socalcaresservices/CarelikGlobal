-- 0110 (PENDING: infra/aws/db/pending) | CLASS: ADDITIVE (one table, one nullable client column, six functions). Not applied to any database.
-- Owner request (2026-11-21, "both" to filtering Billing review by review reason AND by office): the agency can name its offices, give each client a
-- RESPONSIBLE office, and filter Billing review, Reports and the client list by office.
--   * offices: a short list per agency. A retired office stays in the data (history keeps its attribution) and cannot be chosen for new assignments.
--   * clients.responsible_office_id: optional. Nothing is required of existing clients; no existing function or report changes.
--   * Managing offices needs organization.update (the agency Administrator); assigning a client needs clients.manage; reading needs clients.names.read or billing.read.
-- Every change is tenant-scoped, permission-checked server-side and audited. Rollback: pending/rollback/0110_offices.down.sql.

create table ogevia.offices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  is_active boolean not null default true,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  retired_by uuid references ogevia.app_users(id),
  retired_at timestamptz,
  unique (id, organization_id)
);
create unique index offices_org_name_unique on ogevia.offices (organization_id, lower(btrim(name)));
alter table ogevia.offices enable row level security;
create policy readonly_select on ogevia.offices for select to ogevia_readonly using (true);
grant select on ogevia.offices to ogevia_readonly;

alter table ogevia.clients add column responsible_office_id uuid;
alter table ogevia.clients add constraint clients_responsible_office_fk
  foreign key (responsible_office_id, organization_id) references ogevia.offices (id, organization_id);

create function ogevia_api.create_office(p_organization_id uuid, p_name text, p_idempotency_key uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_name text := btrim(coalesce(p_name, ''));
  v_fp text := concat_ws('|', p_organization_id, lower(v_name));
  v_prior jsonb;
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only the agency Administrator can manage offices' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('create_office', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'id')::uuid; end if;
  if length(v_name) not between 2 and 80 then raise exception 'Enter an office name between 2 and 80 characters' using errcode = 'OGV22'; end if;
  if exists (select 1 from ogevia.offices o where o.organization_id = p_organization_id and lower(btrim(o.name)) = lower(v_name)) then
    raise exception 'That office already exists' using errcode = 'OGC09';
  end if;
  insert into ogevia.offices (organization_id, name, created_by) values (p_organization_id, v_name, v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'office.created', 'offices', v_id, null, jsonb_build_object('name', v_name), null);
  perform ogevia.idempotency_finish('create_office', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.rename_office(p_organization_id uuid, p_office_id uuid, p_name text)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_name text := btrim(coalesce(p_name, ''));
  v_old text;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only the agency Administrator can manage offices' using errcode = 'OGA03';
  end if;
  if length(v_name) not between 2 and 80 then raise exception 'Enter an office name between 2 and 80 characters' using errcode = 'OGV22'; end if;
  select o.name into v_old from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id for update;
  if not found then raise exception 'Office not found' using errcode = 'OGN04'; end if;
  if exists (select 1 from ogevia.offices o where o.organization_id = p_organization_id and o.id <> p_office_id and lower(btrim(o.name)) = lower(v_name)) then
    raise exception 'That office already exists' using errcode = 'OGC09';
  end if;
  if v_old = v_name then return 'unchanged'; end if;
  update ogevia.offices set name = v_name where id = p_office_id;
  perform ogevia.write_audit(p_organization_id, 'office.renamed', 'offices', p_office_id, jsonb_build_object('name', v_old), jsonb_build_object('name', v_name), null);
  return 'renamed';
end;
$$;

create function ogevia_api.retire_office(p_organization_id uuid, p_office_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_active boolean;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'organization.update') then
    raise exception 'Only the agency Administrator can manage offices' using errcode = 'OGA03';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then raise exception 'Give a reason (3 to 500 characters)' using errcode = 'OGV22'; end if;
  select o.is_active into v_active from ogevia.offices o where o.id = p_office_id and o.organization_id = p_organization_id for update;
  if not found then raise exception 'Office not found' using errcode = 'OGN04'; end if;
  if not v_active then return 'already_retired'; end if;
  update ogevia.offices set is_active = false, retired_by = v_actor, retired_at = now() where id = p_office_id;
  perform ogevia.write_audit(p_organization_id, 'office.retired', 'offices', p_office_id, jsonb_build_object('is_active', true), jsonb_build_object('is_active', false), v_reason);
  return 'retired';
end;
$$;

create function ogevia_api.list_offices(p_organization_id uuid)
returns table (office_id uuid, name text, is_active boolean, client_count integer)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
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

create function ogevia_api.list_client_offices(p_organization_id uuid)
returns table (client_id uuid, client_code text, office_id uuid)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select c.id, c.client_code, c.responsible_office_id
  from ogevia.clients c
  where c.organization_id = p_organization_id and c.deleted_at is null and c.responsible_office_id is not null
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'clients.names.read') or ogevia.has_permission(p_organization_id, 'billing.read'))
  order by c.client_code;
$$;

create function ogevia_api.set_client_office(p_organization_id uuid, p_client_id uuid, p_office_id uuid)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
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

revoke all on function ogevia_api.create_office(uuid, text, uuid) from public;
revoke all on function ogevia_api.rename_office(uuid, uuid, text) from public;
revoke all on function ogevia_api.retire_office(uuid, uuid, text) from public;
revoke all on function ogevia_api.list_offices(uuid) from public;
revoke all on function ogevia_api.list_client_offices(uuid) from public;
revoke all on function ogevia_api.set_client_office(uuid, uuid, uuid) from public;
grant execute on function ogevia_api.create_office(uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.rename_office(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.retire_office(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.list_offices(uuid) to ogevia_app;
grant execute on function ogevia_api.list_client_offices(uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_office(uuid, uuid, uuid) to ogevia_app;
