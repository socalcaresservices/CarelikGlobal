-- ROLLBACK 0022_client_authorization_admin | CLASS: BACKUP REQUIRED
-- Removes the client and authorization administration functions. Refuses while
-- any client type exists or any client has a city or client type: those values
-- exist only because of 0022 and would be lost. Clients, names and
-- authorizations created through these screens are ordinary rows in tables
-- that predate 0022, so they stay (nothing here deletes them).
do $$ begin
  if to_regclass('ogevia.client_types') is not null and (
       exists (select 1 from ogevia.client_types)
       or exists (select 1 from ogevia.clients where city is not null or client_type_id is not null)) then
    raise exception 'Refusing: client types, cities or client types on clients exist. Snapshot + owner approval + forward fix required.';
  end if;
end $$;
drop function if exists ogevia_api.create_client_authorization(uuid, uuid, uuid, text, integer, date, date, text, date, text, integer, uuid);
drop function if exists ogevia_api.set_client_status(uuid, uuid, ogevia.client_status, text, uuid);
drop function if exists ogevia_api.update_client(uuid, uuid, text, text, text, uuid, text, uuid);
drop function if exists ogevia_api.create_client(uuid, text, text, text, uuid, text, uuid);
drop function if exists ogevia_api.create_client_type(uuid, text, uuid);
drop function if exists ogevia_api.list_client_authorizations(uuid, uuid);
drop function if exists ogevia_api.list_clients(uuid);
drop function if exists ogevia_api.list_services(uuid);
drop function if exists ogevia_api.list_client_types(uuid);
drop function if exists ogevia.client_type_in_org(uuid, uuid);
drop function if exists ogevia.client_admin_guard(uuid);
alter table ogevia.clients drop constraint if exists clients_client_type_fk, drop column if exists client_type_id, drop column if exists city;
drop table if exists ogevia.client_types;
delete from ogevia.role_permissions where permission_key in ('clients.manage', 'authorizations.rates.manage');
delete from ogevia.permissions where key in ('clients.manage', 'authorizations.rates.manage');
