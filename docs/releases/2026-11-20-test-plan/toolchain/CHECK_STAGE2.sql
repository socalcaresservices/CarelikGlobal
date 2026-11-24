-- READ-ONLY evidence for TEST stage 2 (open-shift texting with the MOCK sender, and the client service location). Writes nothing (read-only transaction). Run from this folder:
--   bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CHECK_STAGE2.sql
-- Prints counts, statuses, caregiver codes and the last four digits of numbers only. No name (other than the synthetic client label), full address line, full number, email or message body.
begin read only;
select 'ledger' as k, count(*) as rows, max(version) as last from ogevia_meta.schema_migrations;
select 'ledger_0117_0118' as k, version, name from ogevia_meta.schema_migrations where version in ('0117', '0118') order by version;
select 'sms_settings' as k, enabled, provider, sender_label, recruitment_days, escalation_hours, quiet_start, quiet_end, daily_limit, hourly_limit, per_recipient_daily from ogevia.sms_settings;
select 'sms_live_provider_rows (must be 0)' as k, count(*) as n from ogevia.sms_messages where provider <> 'mock';
select 'sms_by_status' as k, purpose, status, provider, count(*) as n from ogevia.sms_messages group by purpose, status, provider order by purpose, status;
select 'sms_provider_ids_are_mock (must be true)' as k, coalesce(bool_and(provider_message_id like 'mock-%'), true) as all_mock from ogevia.sms_messages where status = 'sent';
select 'email_deliveries' as k, status, count(*) as n from ogevia.notification_deliveries where channel = 'email' group by status order by status;
select 'cover_settings' as k, enabled, email_enabled, auto_notify, audience from ogevia.cover_notification_settings;
-- Demo Today A: the profile data the screen shows
select 'today_a' as k, c.client_code, z.city as service_city, z.zip as service_zip, c.city as details_city, c.service_county, o.name as coordinating_office
  from ogevia.clients c join ogevia.client_private_names n on n.client_id = c.id
  left join ogevia.client_service_zip z on z.client_id = c.id left join ogevia.offices o on o.id = c.responsible_office_id
 where lower(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, ''))) = 'demo today a';
-- its open shifts: which office handles the request, the service city, the alert round, the in-app notifications and the mock texts
select 'today_a_shift' as k, s.id, (s.starts_at at time zone 'America/Los_Angeles') as local_start, ogevia.shift_coverage_state(s) as coverage,
       (select o.name from ogevia.offices o where o.id = ogevia.cover_office_for(s.organization_id, s)) as handled_by_office, ogevia.cover_round(s.id) as round
  from ogevia.shifts s join ogevia.clients c on c.id = s.client_id join ogevia.client_private_names n on n.client_id = c.id
 where lower(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, ''))) = 'demo today a' and s.starts_at > now() order by s.starts_at limit 10;
select 'today_a_notification' as k, n.shift_id, cr.caregiver_code, n.category, n.title, n.in_app, n.read_at, n.archived_at, d.status as email_status
  from ogevia.user_notifications n join ogevia.shifts s on s.id = n.shift_id join ogevia.clients c on c.id = s.client_id join ogevia.client_private_names p on p.client_id = c.id
  left join ogevia.caregiver_records cr on cr.linked_user_id = n.recipient_user_id and cr.organization_id = n.organization_id and cr.deleted_at is null
  left join ogevia.notification_deliveries d on d.notification_id = n.id and d.channel = 'email'
 where lower(btrim(coalesce(p.legal_first_name, '') || ' ' || coalesce(p.legal_last_name, ''))) = 'demo today a' and s.starts_at > now() order by n.created_at;
select 'today_a_sms' as k, m.shift_id, m.purpose, m.status, m.provider, right(m.phone_e164, 4) as last4, m.send_after, m.sent_at
  from ogevia.sms_messages m join ogevia.shifts s on s.id = m.shift_id join ogevia.clients c on c.id = s.client_id join ogevia.client_private_names p on p.client_id = c.id
 where lower(btrim(coalesce(p.legal_first_name, '') || ' ' || coalesce(p.legal_last_name, ''))) = 'demo today a' order by m.created_at;
rollback;
