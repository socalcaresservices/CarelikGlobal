begin;

-- Platform system health: getPlatformRoutes()'s own comment has flagged
-- "System Health" as unbuilt since the shell was first written, and
-- unlike the platform dashboard there's no APM/monitoring integration
-- anywhere in this codebase to aggregate. What *does* exist is real
-- internal job/queue infrastructure with its own failure tracking:
-- the domain_events outbox (20260719160000_domain_event_outbox_processing.sql,
-- processed on a pg_cron schedule by supabase/functions/process-events)
-- and stripe_webhook_events (20260811165350). A stuck outbox or a run of
-- failed Stripe webhook syncs is exactly the kind of operational problem
-- a platform owner needs visible, and both are pure aggregation over
-- data this app already writes - not a new integration.
create function public.get_platform_system_health()
returns table (
  domain_events_pending integer,
  domain_events_failed integer,
  domain_events_dead_letter integer,
  domain_events_oldest_due_minutes integer,
  stripe_webhook_failures_last_24h integer,
  stripe_webhook_last_failure_event_type text,
  stripe_webhook_last_failure_error text,
  stripe_webhook_last_failure_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::integer from public.domain_events where status = 'pending'),
    (select count(*)::integer from public.domain_events where status = 'failed'),
    (select count(*)::integer from public.domain_events where status = 'dead_letter'),
    -- How stuck the oldest still-due event is, in minutes past its own
    -- available_at - a healthy queue (cron running, dispatch succeeding)
    -- keeps this near zero; a large number means either a specific event
    -- type is broken or process-events itself has stopped running.
    (
      select greatest(0, extract(epoch from (now() - min(available_at))) / 60)::integer
      from public.domain_events
      where status in ('pending', 'failed') and available_at <= now()
    ),
    -- processed_at is null, not just failed_at is not null - Stripe
    -- redelivers a failed event, and claim_stripe_webhook_event's own
    -- retry path sets processed_at on that later success without
    -- clearing the earlier failed_at/last_error. Only a still-null
    -- processed_at means the event genuinely never made it through.
    (
      select count(*)::integer from public.stripe_webhook_events
      where failed_at is not null and processed_at is null and failed_at >= now() - interval '24 hours'
    ),
    (
      select event_type from public.stripe_webhook_events
      where failed_at is not null and processed_at is null order by failed_at desc limit 1
    ),
    (
      select last_error from public.stripe_webhook_events
      where failed_at is not null and processed_at is null order by failed_at desc limit 1
    ),
    (
      select failed_at from public.stripe_webhook_events
      where failed_at is not null and processed_at is null order by failed_at desc limit 1
    )
  where public.is_platform_owner();
$$;

revoke all on function public.get_platform_system_health() from public, anon;
grant execute on function public.get_platform_system_health() to authenticated;

commit;
