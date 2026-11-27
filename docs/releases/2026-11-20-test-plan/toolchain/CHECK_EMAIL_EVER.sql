-- READ-ONLY: has TEST EVER sent an open-shift email? Counts only (no address, no message text). Writes nothing.
--   bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CHECK_EMAIL_EVER.sql
-- "provider accepted" would show as status 'sent' with a provider_message_id and a sent_at. Any other status means the app did not send it.
begin read only;
select 'email setting' as k, enabled, email_enabled from ogevia.cover_notification_settings;
select 'deliveries by status' as k, d.status, count(*) as n, min(d.created_at) as first_at, max(d.created_at) as last_at,
       count(d.provider_message_id) as with_provider_message_id, count(d.sent_at) as with_sent_at
  from ogevia.notification_deliveries d where d.channel = 'email' group by d.status order by d.status;
select 'ever accepted by a provider' as k, count(*) as n
  from ogevia.notification_deliveries d where d.channel = 'email' and (d.provider_message_id is not null or d.sent_at is not null or d.status = 'sent');
select 'delivery events' as k, e.event, count(*) as n from ogevia.notification_delivery_events e group by e.event order by e.event;
rollback;
