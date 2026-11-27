-- Rollback of 0114 (PENDING). Drops the office branding table (the looks are lost; the audit events stay). Invitations then use the company look.
drop function if exists ogevia_api.get_invitation_look(uuid, uuid);
drop function if exists ogevia_api.list_office_branding(uuid);
drop function if exists ogevia_api.set_office_branding(uuid, uuid, text, text, text);
drop table if exists ogevia.office_branding;
