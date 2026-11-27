-- REVIEWED CLEAN-UP for the duplicate open-shift alerts that the 0117 upgrade created on TEST (found 2026-11-24): a person who was alerted for a shift BEFORE 0117 (key "cover:<shift>:<epoch>")
-- got a second alert after it (key "...:r0"). This archives the second (":r0") notification and skips its queued email. It deletes nothing and sends nothing.
--   preview (writes nothing):  bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CLEANUP_DUPLICATE_ALERTS.sql
--   apply (needs the owner's approval): bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -v apply=1 -f CLEANUP_DUPLICATE_ALERTS.sql
-- Run it AFTER migration 0119 (so nothing re-creates them). Counts only; no name, address, number or message body is printed.
begin;
create temp table dup on commit drop as
  select b.id as notification_id
    from ogevia.user_notifications b
    join ogevia.user_notifications a on a.organization_id = b.organization_id and a.recipient_user_id = b.recipient_user_id and a.shift_id = b.shift_id
     and a.dedupe_key = regexp_replace(b.dedupe_key, ':r0$', '') and a.dedupe_key ~ '^cover:[0-9a-f-]{36}:[0-9]+$'
   where b.dedupe_key ~ '^cover:[0-9a-f-]{36}:[0-9]+:r0$' and b.category = 'cover_shift'
     and (b.archived_at is null or exists (select 1 from ogevia.notification_deliveries x where x.notification_id = b.id and x.channel = 'email' and x.status in ('queued', 'retry')));   -- not yet cleaned up
select 'duplicate_alerts_found' as k, count(*) as n from dup;
select 'of_which_unread_and_not_archived' as k, count(*) as n from ogevia.user_notifications n join dup d on d.notification_id = n.id where n.archived_at is null and n.read_at is null;
select 'of_which_email_queued' as k, count(*) as n from ogevia.notification_deliveries x join dup d on d.notification_id = x.notification_id where x.channel = 'email' and x.status in ('queued', 'retry');
\if :{?apply}
  with e as (
    update ogevia.notification_deliveries x set status = 'skipped', updated_at = now() from dup d
     where x.notification_id = d.notification_id and x.channel = 'email' and x.status in ('queued', 'retry') returning x.id, x.organization_id)
  insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, detail) select organization_id, id, 'skipped', 'duplicate_alert' from e;
  update ogevia.user_notifications n set archived_at = now() from dup d where n.id = d.notification_id and n.archived_at is null;
  select 'APPLIED: duplicates archived, their queued emails skipped' as k;
  commit;
\else
  select 'PREVIEW ONLY: nothing was written (add -v apply=1 to apply)' as k;
  rollback;
\endif
