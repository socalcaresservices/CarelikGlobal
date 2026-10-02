-- ROLLBACK 0011_care_requests_availability | CLASS: SAFE AUTOMATED
-- Removes care-request workflow objects only. Existing shifts created from requests are retained.

drop function if exists ogevia_api.public_respond_care_offer(text, boolean);
drop function if exists ogevia_api.public_offer_context(text);
drop function if exists ogevia_api.public_cancel_care_request(text, uuid, text);
drop function if exists ogevia_api.public_create_care_request(text, uuid, timestamptz, timestamptz, text, uuid);
drop function if exists ogevia_api.public_request_link_context(text);
drop function if exists ogevia_api.assign_care_request(uuid, uuid);
drop function if exists ogevia_api.create_care_request_offer(uuid, uuid, text, timestamptz);
drop function if exists ogevia_api.list_care_request_offers(uuid);
drop function if exists ogevia_api.list_care_request_candidates(uuid);
drop function if exists ogevia_api.list_care_requests(uuid, ogevia.care_request_status);
drop function if exists ogevia_api.list_care_request_clients(uuid);
drop function if exists ogevia_api.create_client_request_link(uuid, uuid, text, timestamptz);
drop function if exists ogevia.write_care_request_event(uuid, uuid, text, jsonb);

drop table if exists ogevia.care_request_events;
drop table if exists ogevia.public_care_request_idempotency;
drop table if exists ogevia.care_request_offers;
drop table if exists ogevia.care_requests;
drop table if exists ogevia.client_request_links;

delete from ogevia.role_permissions where permission_key in ('care_requests.read','care_requests.manage');
delete from ogevia.permissions where key in ('care_requests.read','care_requests.manage');

drop type if exists ogevia.care_offer_status;
drop type if exists ogevia.care_request_source;
drop type if exists ogevia.care_request_status;
