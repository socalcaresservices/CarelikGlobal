-- READ-ONLY trace of the LATEST Winchester open shift and its email deliveries (TEST). Writes nothing (read-only transaction). Times are Pacific.
--   bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CHECK_EMAIL_TRACE.sql
-- No full address, name, phone or message body is printed: addresses are masked and compared with the approved inbox as true/false only.
\set ON_ERROR_STOP on
begin read only;
select 'database' as k, current_database() as v;
select 'email setting' as k, enabled, email_enabled from ogevia.cover_notification_settings;
-- 1. the latest Winchester shift: the most recently CREATED shift whose service address city is Winchester
-- (a read-only transaction cannot make a temp table, so the same one-row subquery is repeated below)
select 'latest_winchester_shift' as k, l.id as shift_id, (l.created_at at time zone 'America/Los_Angeles') as created_pt, (l.starts_at at time zone 'America/Los_Angeles') as starts_pt, l.status, l.coverage,
       (select o.name from ogevia.offices o where o.id = ogevia.cover_office_for(l.organization_id, (select s from ogevia.shifts s where s.id = l.id))) as coordinating_office
  from (select s.id, s.organization_id, s.client_id, s.created_at, s.starts_at, s.status, ogevia.shift_coverage_state(s) as coverage, s.coordinating_office_id from ogevia.shifts s join ogevia.client_service_zip z on z.client_id = s.client_id and lower(z.city) = 'winchester' order by s.created_at desc limit 1) l;
-- 2. was an alert generated for it, and when
select 'alert_run' as k, (a.created_at at time zone 'America/Los_Angeles') as created_pt, a.recipients, a.service_city
  from ogevia.cover_alerts a join (select s.id, s.organization_id, s.client_id, s.created_at, s.starts_at, s.status, ogevia.shift_coverage_state(s) as coverage, s.coordinating_office_id from ogevia.shifts s join ogevia.client_service_zip z on z.client_id = s.client_id and lower(z.city) = 'winchester' order by s.created_at desc limit 1) l on l.id = a.shift_id order by a.created_at;
-- 3. every recipient of THIS shift: notification time, delivery state, which field would supply the address, and whether it is the approved inbox
select 'recipient' as k, cr.caregiver_code,
       (n.created_at at time zone 'America/Los_Angeles') as notified_pt, n.in_app,
       d.status as email_status, d.attempts, d.last_error_code, (d.sent_at at time zone 'America/Los_Angeles') as sent_pt, (d.next_attempt_at at time zone 'America/Los_Angeles') as next_attempt_pt,
       (d.provider_message_id is not null) as has_provider_id,
       case when nullif(btrim(ct.contact_email), '') is not null then 'caregiver_contacts.contact_email'
            when inv.email is not null then 'caregiver_invitations.email (latest invitation)'
            else 'none' end as address_field_used,
       coalesce(lower(nullif(btrim(ct.contact_email), '')) = 'admin.ogevia@gmail.com', false) as contact_is_approved_inbox,
       coalesce(lower(inv.email) = 'admin.ogevia@gmail.com', false) as invitation_is_approved_inbox,
       regexp_replace(coalesce(nullif(btrim(ct.contact_email), ''), inv.email, ''), '^(.).*@(.).*(\..*)$', '\1***@\2***\3') as masked_address_used
  from ogevia.user_notifications n join (select s.id, s.organization_id, s.client_id, s.created_at, s.starts_at, s.status, ogevia.shift_coverage_state(s) as coverage, s.coordinating_office_id from ogevia.shifts s join ogevia.client_service_zip z on z.client_id = s.client_id and lower(z.city) = 'winchester' order by s.created_at desc limit 1) l on l.id = n.shift_id
  join ogevia.caregiver_records cr on cr.linked_user_id = n.recipient_user_id and cr.organization_id = n.organization_id and cr.deleted_at is null
  left join ogevia.caregiver_contacts ct on ct.caregiver_record_id = cr.id
  left join lateral (select ci.email from ogevia.caregiver_invitations ci where ci.caregiver_record_id = cr.id order by ci.invited_at desc limit 1) inv on true
  left join ogevia.notification_deliveries d on d.notification_id = n.id and d.channel = 'email'
 where n.category = 'cover_shift' order by cr.caregiver_code;
-- 4. the delivery events of TEST-CG-01 for this shift, in order
select 'events_TEST-CG-01' as k, e.event, e.detail, e.attempt, (e.occurred_at at time zone 'America/Los_Angeles') as at_pt
  from ogevia.notification_delivery_events e join ogevia.notification_deliveries d on d.id = e.delivery_id
  join ogevia.user_notifications n on n.id = d.notification_id join (select s.id, s.organization_id, s.client_id, s.created_at, s.starts_at, s.status, ogevia.shift_coverage_state(s) as coverage, s.coordinating_office_id from ogevia.shifts s join ogevia.client_service_zip z on z.client_id = s.client_id and lower(z.city) = 'winchester' order by s.created_at desc limit 1) l on l.id = n.shift_id
  join ogevia.caregiver_records cr on cr.linked_user_id = n.recipient_user_id and cr.organization_id = n.organization_id and cr.caregiver_code = 'TEST-CG-01'
 order by e.occurred_at;
-- 5. what produced the refusals around 04:15 PT today: ALL email deliveries by outcome and the time window they were handled, whatever shift they belong to
select 'all_deliveries_today' as k, d.status, d.last_error_code, count(*) as n, min(d.created_at at time zone 'America/Los_Angeles') as first_created_pt, max(d.updated_at at time zone 'America/Los_Angeles') as last_updated_pt
  from ogevia.notification_deliveries d
 where d.channel = 'email' and d.updated_at >= now() - interval '24 hours' group by d.status, d.last_error_code order by d.status, d.last_error_code;
select 'refused_not_allowed_by_shift' as k, (s.starts_at at time zone 'America/Los_Angeles') as shift_starts_pt, count(*) as n, min(d.updated_at at time zone 'America/Los_Angeles') as first_pt, max(d.updated_at at time zone 'America/Los_Angeles') as last_pt
  from ogevia.notification_deliveries d join ogevia.user_notifications n on n.id = d.notification_id left join ogevia.shifts s on s.id = n.shift_id
 where d.channel = 'email' and d.last_error_code = 'recipient_not_allowed' group by 2 order by 4;
rollback;
