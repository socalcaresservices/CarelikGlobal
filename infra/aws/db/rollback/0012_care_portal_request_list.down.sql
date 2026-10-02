-- ROLLBACK 0012_care_portal_request_list | CLASS: SAFE AUTOMATED
-- Function only; no data is stored by 0012.
drop function if exists ogevia_api.public_list_care_requests(text);
