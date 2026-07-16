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
