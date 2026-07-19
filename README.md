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
