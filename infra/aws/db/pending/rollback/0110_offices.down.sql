-- Rollback of 0110 (PENDING). Drops the six functions, the clients column and the offices table.
-- Take a backup first if offices were used: the office names and every client's responsible office are lost (the audit events keep who set what).
drop function if exists ogevia_api.set_client_office(uuid, uuid, uuid);
drop function if exists ogevia_api.list_client_offices(uuid);
drop function if exists ogevia_api.list_offices(uuid);
drop function if exists ogevia_api.retire_office(uuid, uuid, text);
drop function if exists ogevia_api.rename_office(uuid, uuid, text);
drop function if exists ogevia_api.create_office(uuid, text, uuid);
alter table ogevia.clients drop constraint if exists clients_responsible_office_fk;
alter table ogevia.clients drop column if exists responsible_office_id;
drop table if exists ogevia.offices;
