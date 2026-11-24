-- READ-ONLY check of one open-shift alert (shift starting 2026-11-24 09:00 agency time): was a notification created, and what happened to its email? Writes nothing (read-only transaction).
--   bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CHECK_ALERT_EMAIL.sql
-- Recipients are shown by caregiver code and a masked address. No name, full address, or message body is printed.
begin read only;
select 'settings' as k, enabled, email_enabled, auto_notify from ogevia.cover_notification_settings;
select 'shift' as k, s.id, (s.starts_at at time zone 'America/Los_Angeles') as local_start, s.status, ogevia.shift_coverage_state(s) as coverage, c.client_code
  from ogevia.shifts s join ogevia.clients c on c.id = s.client_id
 where s.starts_at = (timestamp '2026-11-24 09:00' at time zone 'America/Los_Angeles');
select 'alert' as k, a.shift_id, a.created_at, a.recipients, a.service_city
  from ogevia.cover_alerts a join ogevia.shifts s on s.id = a.shift_id
 where s.starts_at = (timestamp '2026-11-24 09:00' at time zone 'America/Los_Angeles') order by a.created_at;
select 'notification' as k, n.shift_id, cr.caregiver_code, n.created_at, n.in_app, n.read_at, n.archived_at,
       d.status as email_status, d.attempts, d.last_error_code, d.provider_message_id, d.sent_at, d.next_attempt_at,
       regexp_replace(coalesce(ct.contact_email, ''), '^(.).*@(.).*(\..*)$', '\1***@\2***\3') as masked_email
  from ogevia.user_notifications n
  join ogevia.shifts s on s.id = n.shift_id
  left join ogevia.caregiver_records cr on cr.linked_user_id = n.recipient_user_id and cr.organization_id = n.organization_id and cr.deleted_at is null
  left join ogevia.caregiver_contacts ct on ct.caregiver_record_id = cr.id
  left join ogevia.notification_deliveries d on d.notification_id = n.id and d.channel = 'email'
 where n.category = 'cover_shift' and s.starts_at = (timestamp '2026-11-24 09:00' at time zone 'America/Los_Angeles') order by n.created_at;
select 'delivery_event' as k, d.notification_id, e.event, e.detail, e.attempt, e.occurred_at
  from ogevia.notification_delivery_events e join ogevia.notification_deliveries d on d.id = e.delivery_id
  join ogevia.user_notifications n on n.id = d.notification_id join ogevia.shifts s on s.id = n.shift_id
 where s.starts_at = (timestamp '2026-11-24 09:00' at time zone 'America/Los_Angeles') order by e.occurred_at;
rollback;
