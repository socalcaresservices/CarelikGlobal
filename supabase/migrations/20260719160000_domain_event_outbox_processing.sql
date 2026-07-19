begin;

-- Outbox processing primitives for domain_events. "Event and notification
-- writes are reserved for trusted server-side execution" (see
-- docs/phase-1-foundation.md) - these are grantable to service_role only,
-- never to authenticated/anon, since arbitrary users must not be able to
-- claim or resolve events themselves.

-- Atomically claims a batch of due events for processing. FOR UPDATE
-- SKIP LOCKED means multiple concurrent worker invocations can run
-- against the same table without double-claiming a row.
create or replace function public.claim_domain_events(
  batch_size integer default 20
)
returns setof public.domain_events
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.domain_events
  set status = 'processing',
      attempts = attempts + 1
  where id in (
    select id
    from public.domain_events
    where status in ('pending', 'failed')
      and available_at <= now()
    order by available_at
    limit greatest(batch_size, 0)
    for update skip locked
  )
  returning *;
end;
$$;

create or replace function public.complete_domain_event(
  target_event_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.domain_events
  set status = 'published',
      processed_at = now(),
      last_error = null
  where id = target_event_id;
$$;

-- Requeues with exponential backoff (capped at 60 minutes) until
-- max_attempts is reached, then moves the event to dead_letter so it
-- stops being retried but isn't lost.
create or replace function public.fail_domain_event(
  target_event_id uuid,
  error_message text,
  max_attempts integer default 5
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_attempts integer;
begin
  select attempts into current_attempts
  from public.domain_events
  where id = target_event_id;

  if current_attempts is null then
    return;
  end if;

  if current_attempts >= max_attempts then
    update public.domain_events
    set status = 'dead_letter',
        last_error = error_message
    where id = target_event_id;
  else
    update public.domain_events
    set status = 'failed',
        last_error = error_message,
        available_at = now() + (least(power(2, current_attempts), 60) * interval '1 minute')
    where id = target_event_id;
  end if;
end;
$$;

revoke all on function public.claim_domain_events(integer) from public;
revoke all on function public.complete_domain_event(uuid) from public;
revoke all on function public.fail_domain_event(uuid, text, integer) from public;

grant execute on function public.claim_domain_events(integer) to service_role;
grant execute on function public.complete_domain_event(uuid) to service_role;
grant execute on function public.fail_domain_event(uuid, text, integer) to service_role;

commit;
