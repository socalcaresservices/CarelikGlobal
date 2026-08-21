# CareLik Global

CareLik Global is the commercial multi-tenant care operations platform.

## Phase 1 Foundation

This repository currently establishes:

- React + TypeScript + Vite application shell
- Monorepo package boundaries
- Supabase client and environment validation
- Multi-tenant organizations
- Organization memberships
- Role-based access control
- Audit logging
- Domain event outbox
- Notification framework
- File metadata and storage policies
- Feature flags
- Organization settings
- Row-level security policies
- CI validation

## Local setup

1. Install Node.js 20+ and pnpm 9.
2. Copy `.env.example` to `apps/web/.env.local`.
3. Set the Supabase project URL and anonymous key.
4. Run:

```bash
pnpm install
pnpm dev
```

## Database

Apply migrations with the Supabase CLI:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Never place a Supabase service-role key in the browser application.

## Authentication

Sign-up is disabled (`enable_signup = false`); accounts are provisioned by an
administrator and users sign in with GitHub OAuth.

1. Create a GitHub OAuth App at https://github.com/settings/developers.
   - Local development callback: `http://127.0.0.1:54321/auth/v1/callback`
   - Hosted project callback: `https://<project-ref>.supabase.co/auth/v1/callback`
2. Copy `.env.example` to `.env` at the repository root and set
   `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET`.
   This file is read by `supabase start`, not by the web app.
3. For a hosted project, set the same two values under
   Authentication → Providers → GitHub in the Supabase dashboard.

## Inviting members

New members are provisioned by email through the `invite-member` edge
function (`supabase/functions/invite-member`), never from the browser
directly — that keeps the service-role key off the client.

```bash
supabase functions deploy invite-member
supabase secrets set SITE_URL=https://your-app-domain.example
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
provided automatically to edge functions by the Supabase platform (and by
`supabase functions serve` locally) — no need to set them manually.

The function checks that the caller already holds `membership.invite` for
the target organization (via the `has_permission` database function)
before it will send an invite. Call it from the client with:

```ts
import { inviteMember } from "@/lib/invitations";

await inviteMember({ email, organizationId, role });
```

The invited person is created with membership `status = 'invited'`. The
first time they authenticate — via the invite email link or by signing in
with GitHub using the same address — `OrganizationProvider` calls the
`accept_organization_invitation` database function to flip their
membership to `active`.

## Audit trail

`audit_logs` has no INSERT policy — the only writer is a database trigger
(`write_audit_log`, `supabase/migrations/20260719150000_audit_writer.sql`)
attached to `organizations`, `organization_memberships`, `feature_flags`,
and `files`. Every insert/update/delete on those tables is logged
automatically; nothing in application code needs to remember to audit
anything. Read access is still gated by `audit.read` per the existing RLS
policy.

## Event processing

`domain_events` is a transactional outbox. A handful of things enqueue to
it today: document-request reminders, billing usage-threshold alerts, and
(as of `20260821150000_shift_notification_events.sql`) two shift-coverage
events — `shift.assigned` (a caregiver, with or without a login, now owns
a scheduled shift) and `shift.needs_coverage` (a shift lost its caregiver
to a call-out and has no replacement yet).

`supabase/functions/process-events` is the worker: it calls
`claim_domain_events` (atomic, `FOR UPDATE SKIP LOCKED` so concurrent runs
can't double-process the same row), attempts to dispatch each event, then
calls `complete_domain_event` or `fail_domain_event` (exponential backoff,
capped at 60 minutes, moving to `dead_letter` after 5 attempts). A
`process-domain-events` pg_cron job runs this every minute in production
(`select cron.alter_job(job_id := <id>, schedule := '<cron expr>')` to
change it — find the id with `select jobid from cron.job where jobname =
'process-domain-events'`).

**`dispatchEvent()` sends SMS for the two shift-coverage event types via
Twilio** — the first real downstream integration this stub has had. Every
other `event_type` still falls through to a log-and-succeed no-op, same as
before, so nothing dead-letters just because a given event type has no
handler yet. Set these as Supabase Edge Function secrets to turn SMS on:

```bash
supabase secrets set TWILIO_ACCOUNT_SID=<from your Twilio console>
supabase secrets set TWILIO_AUTH_TOKEN=<from your Twilio console>
supabase secrets set TWILIO_FROM_NUMBER=<a Twilio phone number capable of SMS, e.g. +15551234567>
```

Without them, `shift.assigned`/`shift.needs_coverage` events are logged
and marked complete rather than dead-lettered — turning Twilio on later
doesn't require replaying a backlog, only newly-emitted events get texted.
Recipients are resolved from data already in the app: the assigned
caregiver's `user_profiles.phone` (logged-in) or `caregiver_records.phone`
(no-login) for `shift.assigned`, and every active org member holding
`shifts.update` with a phone on file for `shift.needs_coverage` — add
phone numbers to those records for anyone who should actually get texted.

Deploy and schedule it:

```bash
supabase functions deploy process-events
supabase secrets set PROCESS_EVENTS_SECRET=$(openssl rand -hex 32)
```

`PROCESS_EVENTS_SECRET` is optional but recommended — if set, the function
requires it as an `x-cron-secret` header, since (unlike `invite-member`)
there is no per-user permission check to fall back on here. Schedule
periodic invocation with
[Supabase Cron](https://supabase.com/docs/guides/functions/schedule-functions)
(built on `pg_cron` + `pg_net`), for example every minute:

```sql
select cron.schedule(
  'process-domain-events',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/process-events',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<same value as PROCESS_EVENTS_SECRET>'
    )
  );
  $$
);
```
