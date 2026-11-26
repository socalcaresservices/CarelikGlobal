-- REVIEWED CLEAN-UP before the TEST email sender goes live: every email still QUEUED or waiting to RETRY from earlier TEST alerts (older wording, older /schedule link) is marked SKIPPED,
-- so the first email that arrives after you turn email on is a NEW one. It deletes nothing, sends nothing, and leaves the in-app notifications as they are.
--   preview (writes nothing):  bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -f CLEANUP_QUEUED_EMAIL.sql
--   apply (needs the owner's approval): bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -v apply=1 -f CLEANUP_QUEUED_EMAIL.sql
-- Counts only; no name, address or message body is printed. TEST database only.
\set ON_ERROR_STOP on
begin;
select 'database' as k, current_database() as v;
select 'queued_or_retry_emails' as k, count(*) as n from ogevia.notification_deliveries where channel = 'email' and status in ('queued', 'retry');
select 'email_setting_on' as k, coalesce(bool_or(email_enabled), false) as v from ogevia.cover_notification_settings;
\if :{?apply}
  do $$ begin if current_database() <> 'ogevia_sv_test' then raise exception 'This clean-up is for the TEST database only'; end if; end $$;
  with e as (
    update ogevia.notification_deliveries x set status = 'skipped', updated_at = now()
     where x.channel = 'email' and x.status in ('queued', 'retry') returning x.id, x.organization_id)
  insert into ogevia.notification_delivery_events (organization_id, delivery_id, event, detail) select organization_id, id, 'skipped', 'before_sender' from e;
  select 'APPLIED: earlier queued emails skipped' as k;
  commit;
\else
  select 'PREVIEW ONLY: nothing was written (add -v apply=1 to apply)' as k;
  rollback;
\endif
