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

`domain_events` is a transactional outbox. Rows get inserted by
application code (not yet wired up anywhere — no table currently writes
to it) and need a worker to actually process them; nothing does that on
its own.

`supabase/functions/process-events` is that worker: it calls
`claim_domain_events` (atomic, `FOR UPDATE SKIP LOCKED` so concurrent runs
can't double-process the same row), attempts to dispatch each event, then
calls `complete_domain_event` or `fail_domain_event` (exponential backoff,
capped at 60 minutes, moving to `dead_letter` after 5 attempts).

**`dispatchEvent()` is currently a stub** — there is no webhook target,
email provider, or other downstream integration defined anywhere in this
codebase yet, so it just logs and reports success. Replace the switch
statement in `supabase/functions/process-events/index.ts` with real
handlers per `event_type` once a concrete integration exists.

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
