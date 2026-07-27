begin;

-- Build 022: automated reminders for outstanding document requests - the
-- one piece of the original Document Request Engine brief still open
-- after Build 021's upload page and verification workflow. Per that
-- brief: "Nothing should be hardcoded. Everything should be configurable
-- by organization" - so reminder cadence lives in a per-organization
-- settings table with sane defaults, not a fixed interval.
--
-- Reminders are queued as domain_events (public.domain_events, the
-- existing outbox from 20260719160000_domain_event_outbox_processing.sql)
-- rather than a parallel notification mechanism - dispatchEvent() in
-- supabase/functions/process-events/index.ts is exactly the place a real
-- email/SMS integration will eventually plug in a
-- 'document_request.reminder_due' handler. That integration itself is
-- NOT built here (no email provider is configured anywhere in this
-- codebase yet, and inventing one without real credentials would be
-- fake work) - this build stops at "the reminder is correctly computed
-- and queued," which is honestly the whole automatable part.
--
-- NOTE: this migration deliberately stops short of actually scheduling
-- anything (no pg_cron/pg_net, no cron.schedule call). README.md
-- documents a pg_cron recipe for process-events as a manual "run this
-- once yourself" step that was never actually applied to the project -
-- confirmed via search, no cron.schedule call existed anywhere before
-- this build. Enabling pg_cron/pg_net and scheduling both
-- queue_document_reminders() and process-events would close that gap
-- and make reminders actually fire on their own, but recurring
-- extension/network-scheduling changes are exactly the kind of
-- standing infrastructure decision that gets a deliberate go/no-go
-- rather than being folded into an autonomous build - see the chat
-- response accompanying this build for the question asked.
--
-- Per-organization reminder cadence. No row for an organization means
-- "use the defaults" (enabled, every 3 days, up to 3 reminders) - same
-- nullable-row-means-default pattern the rest of this schema doesn't
-- otherwise use, but justified here because most organizations will
-- never touch this setting and forcing a row-per-org at creation time
-- would mean threading reminder defaults through create_organization
-- for no benefit.
create table public.document_reminder_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  interval_days integer not null default 3,
  max_reminders integer not null default 3,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_reminder_settings_interval_check check (interval_days between 1 and 90),
  constraint document_reminder_settings_max_check check (max_reminders between 0 and 20)
);

create trigger document_reminder_settings_set_updated_at
before update on public.document_reminder_settings
for each row execute function public.set_updated_at();

create trigger document_reminder_settings_audit
after insert or update or delete on public.document_reminder_settings
for each row execute function public.write_audit_log();

alter table public.document_reminder_settings enable row level security;

create policy "read_document_reminder_settings"
on public.document_reminder_settings for select
to authenticated
using (public.has_permission(organization_id, 'documents.read'));

create policy "authorized_manage_document_reminder_settings"
on public.document_reminder_settings for all
to authenticated
using (public.has_permission(organization_id, 'documents.manage'))
with check (public.has_permission(organization_id, 'documents.manage'));

-- Per-batch reminder tracking - how many have gone out and when, so
-- queue_document_reminders() below can enforce both the interval and
-- the max_reminders cap without a separate history table.
alter table public.document_request_batches
  add column reminders_sent integer not null default 0,
  add column last_reminder_sent_at timestamptz;

-- get_document_reminder_settings: the effective settings for an
-- organization, with defaults applied via coalesce when no row exists
-- yet - the Settings UI reads this rather than reading the table
-- directly, so it doesn't have to duplicate the default values.
create function public.get_document_reminder_settings(target_organization_id uuid)
returns table (enabled boolean, interval_days integer, max_reminders integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(s.enabled, true),
    coalesce(s.interval_days, 3),
    coalesce(s.max_reminders, 3)
  from (select 1) as one
  left join public.document_reminder_settings s on s.organization_id = target_organization_id
  where public.has_permission(target_organization_id, 'documents.read');
$$;

revoke all on function public.get_document_reminder_settings(uuid) from public, anon;
grant execute on function public.get_document_reminder_settings(uuid) to authenticated;

-- set_document_reminder_settings: upsert - the Settings UI always calls
-- this rather than distinguishing insert-vs-update itself.
create function public.set_document_reminder_settings(
  target_organization_id uuid,
  target_enabled boolean,
  target_interval_days integer,
  target_max_reminders integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to manage reminder settings for this organization';
  end if;

  insert into public.document_reminder_settings (
    organization_id, enabled, interval_days, max_reminders, created_by, updated_by
  ) values (
    target_organization_id, target_enabled, target_interval_days, target_max_reminders, auth.uid(), auth.uid()
  )
  on conflict (organization_id) do update
  set enabled = excluded.enabled,
      interval_days = excluded.interval_days,
      max_reminders = excluded.max_reminders,
      updated_by = auth.uid();
end;
$$;

revoke all on function public.set_document_reminder_settings(uuid, boolean, integer, integer) from public, anon;
grant execute on function public.set_document_reminder_settings(uuid, boolean, integer, integer) to authenticated;

-- queue_document_reminders: the scheduled job itself. Finds every batch
-- with at least one document still awaiting applicant action
-- (requested/rejected/replacement_requested/missing - deliberately NOT
-- uploaded/pending_review, since those are waiting on staff, not the
-- applicant, and a reminder would be nagging the wrong person), applies
-- that organization's cadence and cap, and queues one domain_events row
-- plus bumps reminders_sent/last_reminder_sent_at. Idempotency_key
-- (batch id + reminder number) means re-running this within the same
-- cycle - a cron misfire, a manual re-run - can't double-queue the same
-- reminder.
--
-- No permission check: this isn't callable by any organization's own
-- members (see the revoke below) - it processes every organization in
-- one pass, the same trust model as claim_domain_events.
create function public.queue_document_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_queued integer := 0;
  v_batch record;
begin
  for v_batch in
    select
      b.id,
      b.organization_id,
      b.subject_name,
      b.subject_email,
      b.token,
      b.reminders_sent,
      b.last_reminder_sent_at,
      b.created_at,
      coalesce(s.enabled, true) as enabled,
      coalesce(s.interval_days, 3) as interval_days,
      coalesce(s.max_reminders, 3) as max_reminders,
      array_agg(dt.name order by dt.name)
        filter (where dr.status in ('requested', 'rejected', 'replacement_requested', 'missing')) as outstanding_names
    from public.document_request_batches b
    left join public.document_reminder_settings s on s.organization_id = b.organization_id
    join public.document_requests dr on dr.batch_id = b.id
    join public.document_types dt on dt.id = dr.document_type_id
    where b.deleted_at is null
      and (b.expires_at is null or b.expires_at > now())
    group by b.id, s.enabled, s.interval_days, s.max_reminders
    having count(*) filter (
      where dr.status in ('requested', 'rejected', 'replacement_requested', 'missing')
    ) > 0
  loop
    if not v_batch.enabled or v_batch.reminders_sent >= v_batch.max_reminders then
      continue;
    end if;

    if v_batch.last_reminder_sent_at is null then
      if v_batch.created_at > now() - make_interval(days => v_batch.interval_days) then
        continue;
      end if;
    elsif v_batch.last_reminder_sent_at > now() - make_interval(days => v_batch.interval_days) then
      continue;
    end if;

    insert into public.domain_events (
      organization_id, event_type, aggregate_type, aggregate_id, payload, metadata, idempotency_key
    ) values (
      v_batch.organization_id,
      'document_request.reminder_due',
      'document_request_batch',
      v_batch.id::text,
      jsonb_build_object(
        'batch_id', v_batch.id,
        'subject_name', v_batch.subject_name,
        'subject_email', v_batch.subject_email,
        'upload_url_token', v_batch.token,
        'outstanding_document_names', to_jsonb(v_batch.outstanding_names),
        'reminder_number', v_batch.reminders_sent + 1
      ),
      '{}'::jsonb,
      'document_request_reminder:' || v_batch.id || ':' || (v_batch.reminders_sent + 1)
    )
    on conflict (organization_id, idempotency_key) do nothing;

    update public.document_request_batches
    set reminders_sent = reminders_sent + 1,
        last_reminder_sent_at = now()
    where id = v_batch.id;

    v_queued := v_queued + 1;
  end loop;

  return v_queued;
end;
$$;

revoke all on function public.queue_document_reminders() from public, anon, authenticated;

-- Deliberately NOT scheduled here - see the note at the top of this
-- file. queue_document_reminders() works correctly when called directly
-- (e.g. `select public.queue_document_reminders();` from the SQL
-- editor, or a manually-triggered edge function later) but nothing
-- calls it automatically yet.

commit;
