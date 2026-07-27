begin;

-- Build 022 follow-up: actually schedules the two jobs the previous
-- migration left callable-but-inert, per explicit user confirmation.
-- queue-document-reminders runs daily and needs no network access (it's
-- pure SQL). process-domain-events runs every 15 minutes via pg_net and
-- drains the domain_events outbox - this also closes the pre-existing
-- gap where README.md documented a pg_cron recipe for process-events
-- that was never actually applied to the project. No secret header is
-- sent because PROCESS_EVENTS_SECRET isn't currently configured as a
-- function secret; the function's own `if (cronSecret)` guard skips the
-- check entirely in that case (see supabase/functions/process-events/
-- index.ts). If that secret is set later, this job's headers need
-- updating via cron.alter_job to match.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'queue-document-reminders',
  '0 13 * * *',
  $$ select public.queue_document_reminders(); $$
);

select cron.schedule(
  'process-domain-events',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://cdxxpdyobsqvqveabsda.supabase.co/functions/v1/process-events',
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  $$
);

commit;
