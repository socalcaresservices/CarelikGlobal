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
