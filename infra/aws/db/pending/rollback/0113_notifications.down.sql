-- Rollback of 0113 (PENDING). BACKUP REQUIRED once any notification exists: this drops the notification tables (history is lost). The audit events written by the
-- functions stay in the audit trail. Run only with the owner's approval and a snapshot.
drop function if exists ogevia_api.system_email_record(uuid, text, text, text);
drop function if exists ogevia_api.system_email_claim(integer);
drop function if exists ogevia_api.list_cover_notification_history(uuid, integer);
drop function if exists ogevia_api.set_my_notification_preferences(uuid, text, boolean, boolean);
drop function if exists ogevia_api.get_my_notification_preferences(uuid);
drop function if exists ogevia_api.mark_user_notifications(uuid, uuid[], text);
drop function if exists ogevia_api.list_user_notifications(uuid, text, text, integer, timestamptz);
drop function if exists ogevia_api.system_cover_notify_org(uuid);
drop function if exists ogevia_api.system_cover_notify_orgs();
drop function if exists ogevia_api.notify_cover_shift(uuid, uuid, uuid);
drop function if exists ogevia.cover_notify(uuid, uuid, uuid, uuid);
drop function if exists ogevia.cover_service_address(uuid, uuid);
drop function if exists ogevia_api.list_cover_office_audiences(uuid);
drop function if exists ogevia_api.set_cover_office_audience(uuid, uuid, text, text);
drop function if exists ogevia_api.set_cover_notification_settings(uuid, boolean, boolean, boolean, integer, integer, text, text, text);
drop function if exists ogevia_api.get_cover_notification_settings(uuid);
drop table if exists ogevia.notification_delivery_events;
drop table if exists ogevia.notification_deliveries;
drop table if exists ogevia.notification_preferences;
drop table if exists ogevia.user_notifications;
drop function if exists ogevia.user_notifications_guard();
drop table if exists ogevia.cover_alerts;
alter table ogevia.shifts drop constraint if exists shifts_coordinating_office_fk;
alter table ogevia.shifts drop column if exists coordinating_office_id;
drop table if exists ogevia.cover_notification_office_audience;
drop table if exists ogevia.cover_notification_settings;
