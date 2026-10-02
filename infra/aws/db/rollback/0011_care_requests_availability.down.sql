-- ROLLBACK 0011_care_requests_availability | CLASS: BACKUP REQUIRED
-- Removes the new scheduling-request objects. Do not run after real request data is accepted without a backup.

drop function if exists ogevia_api.revoke_client_care_portals(uuid,uuid);
drop function if exists ogevia_api.respond_my_care_opportunity(uuid,uuid,boolean,text);
drop function if exists ogevia_api.list_my_care_opportunities(uuid);
drop function if exists ogevia_api.replace_care_alert_staff(uuid,uuid[]);
drop function if exists ogevia_api.list_care_alert_staff(uuid);
drop function if exists ogevia_api.list_client_portal_options(uuid);
drop function if exists ogevia_api.list_care_request_offers(uuid,uuid);
drop function if exists ogevia_api.list_staff_care_notifications(uuid);
drop function if exists ogevia_api.replace_my_availability(uuid,jsonb,jsonb);
drop function if exists ogevia_api.get_my_availability(uuid);
drop function if exists ogevia_api.public_cancel_assigned_offer(text,text);
drop function if exists ogevia_api.assign_care_request(uuid,uuid,uuid);
drop function if exists ogevia_api.public_respond_care_offer(text,boolean,text);
drop function if exists ogevia_api.public_get_care_offer(text);
drop function if exists ogevia_api.send_care_offer(uuid,uuid,uuid,text);
drop function if exists ogevia_api.list_available_caregivers(uuid,uuid);
drop function if exists ogevia_api.list_care_requests(uuid,ogevia.care_request_status);
drop function if exists ogevia_api.public_cancel_care_request(text,uuid,text);
drop function if exists ogevia_api.public_get_care_request(text,uuid);
drop function if exists ogevia_api.public_create_care_request(text,uuid,timestamptz,timestamptz,text,uuid);
drop function if exists ogevia_api.get_public_care_portal(text);
drop function if exists ogevia_api.create_client_care_portal(uuid,uuid,text,text);
drop function if exists ogevia.care_request_reserved_usage(uuid,date,uuid);
drop function if exists ogevia.care_offer_by_token(text);
drop function if exists ogevia.care_portal_by_token(text);

drop table if exists ogevia.care_request_events;
drop table if exists ogevia.care_request_events;
drop table if exists ogevia.care_notifications;
drop table if exists ogevia.care_request_alert_recipients;
drop table if exists ogevia.authorization_reservations;
drop table if exists ogevia.care_request_offers;
drop table if exists ogevia.care_requests;
drop table if exists ogevia.caregiver_unavailable_dates;
drop table if exists ogevia.caregiver_availability_windows;
drop table if exists ogevia.client_care_portals;

alter table ogevia.shift_coverage_events
  drop column if exists after_snapshot,
  drop column if exists before_snapshot,
  drop column if exists reason,
  drop column if exists replacement_caregiver_record_id,
  drop column if exists original_caregiver_record_id,
  drop column if exists actor_user_id;

delete from ogevia.role_permissions where permission_key in ('care_requests.read','care_requests.manage','availability.manage_own');
delete from ogevia.permissions where key in ('care_requests.read','care_requests.manage','availability.manage_own');

drop type if exists ogevia.care_notification_recipient;
drop type if exists ogevia.care_offer_status;
drop type if exists ogevia.care_request_status;
