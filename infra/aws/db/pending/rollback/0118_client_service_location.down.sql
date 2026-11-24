-- Rollback of 0118. The stored city, county, ZIP and office assignments stay as they are (nothing was overwritten except the one-time empty-city gap-fill, which is not reverted).
-- Drops the new objects. Run in one transaction as ogevia_owner.
drop function ogevia_api.set_client_service_location(uuid, uuid, text, text, text, uuid);
drop function ogevia_api.get_client_service_location(uuid, uuid);
drop function ogevia.client_county_suggestion(uuid, uuid, text);
drop trigger client_service_zip_sync_city on ogevia.client_service_zip;
drop function ogevia.client_service_zip_sync_city();
drop table ogevia.zip_county_reference;
