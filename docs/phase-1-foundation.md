# Phase 1 Foundation — Increment 1

## Included

- Workspace and build tooling
- Web application shell
- Environment validation
- Supabase browser client
- Authentication context
- Shared tenant and permission types
- Organization and membership tables
- Role-permission matrix
- Organization settings
- Feature flags
- Audit log schema
- Domain event outbox
- Notification queue
- Tenant-scoped files
- Storage bucket and policies
- RLS helper functions and policies
- CI workflow
- Netlify configuration

## Security constraints

- Browser code uses only the anonymous Supabase key.
- Service-role credentials are not referenced by the web application.
- Tenant access is enforced in PostgreSQL through RLS.
- Storage paths must begin with the organization UUID.
- Audit records are not directly writable from the browser.
- Event and notification writes are reserved for trusted server-side execution.

## Next increment

- Login and invitation flows
- Active-organization selection
- Protected route boundaries
- Organization administration UI
- Membership invitation API
- Permission-aware navigation
- Server-side audit writer
- Event publisher worker

## Increment 2 — Authentication & tenancy shell

Shipped:

- GitHub OAuth sign-in (invite-only; `enable_signup` stays `false`)
- Protected route boundary redirecting unauthenticated users to `/login`
- Active-organization selection, persisted per browser, backed by RLS-filtered
  reads of `organizations`
- Permission-aware navigation driven by `role_permissions` for the active
  organization's membership role

Not in this increment (still open):

- Organization administration UI (create/edit organization, manage members)
- Server-side audit writer
- Event publisher worker

## Increment 3 — Membership invitations

Shipped:

- `invite-member` edge function (`supabase/functions/invite-member`): the
  only place the service-role key is used. Verifies the caller holds
  `membership.invite` for the target organization (via `has_permission`,
  RLS-scoped to the caller's own JWT) before calling
  `auth.admin.inviteUserByEmail` and creating an `organization_memberships`
  row with `status = 'invited'`.
- `accept_organization_invitation` database function: lets a user activate
  their own invited membership once authenticated. Called automatically by
  `OrganizationProvider` after login.
- `apps/web/src/lib/invitations.ts`: client helper (`inviteMember`) that
  calls the edge function. Not yet wired to any screen — see "Organization
  administration UI" above.

Not in this increment (still open):

- Organization administration UI is still the only missing piece needed to
  actually use `inviteMember` from the app; today it can only be exercised
  via `supabase functions invoke invite-member` or a direct fetch call.
- Server-side audit writer
- Event publisher worker

## Increment 4 — Access control screen

Shipped:

- `list_organization_members` database function: security-definer, gated
  by `has_permission(org, 'membership.read')`. Needed because
  `users_read_own_profile` RLS only lets someone read their own
  `user_profiles` row (or a platform owner read any row), so an
  organization_admin couldn't otherwise join member display names from
  the browser.
- `/access` now renders a real page: an invite form (visible only with
  `membership.invite`) wired to `inviteMember()`, and a members table
  (visible with `membership.read`) showing name, role, and status.

Not in this increment (still open):

- `/organizations` is still a placeholder — no create/edit organization
  screen, no way to change a member's role or remove them once invited.
- Server-side audit writer
- Event publisher worker

## Increment 5 — Organization admin

Shipped:

- `create_organization` database function: platform-owner-only (the
  `organizations` table has no INSERT RLS policy on purpose — tenant
  creation is a platform-level action, not an org-scoped one).
- `/organizations` now lists every organization the user can see, lets a
  platform owner create new ones, and lets anyone with
  `organization.update` edit the active organization's legal name,
  display name, and timezone (a plain RLS-backed update — no new
  function needed there).
- `/access` members table now supports changing a member's role and
  revoking access (sets `status = 'revoked'`, not a hard delete — kept
  consistent with the soft-delete pattern used elsewhere, e.g. `files`).
  Both actions are gated on `membership.update` and disabled for your own
  row so you can't accidentally revoke or demote yourself.

Note: the `membership.remove` permission key exists in the `permissions`
table (and is granted to organization_owner/organization_admin) but no
RLS policy actually checks it — `authorized_manage_memberships` gates all
of insert/update/delete on `membership.update` alone. This predates this
increment; the UI is gated to match what RLS actually enforces rather
than the unused permission key.

Not in this increment (still open):

- Server-side audit writer
- Event publisher worker

## Increment 6 — Lint

Shipped:

- `apps/web/eslint.config.js` was missing entirely, even though the
  ESLint 9 flat-config dependencies (`@eslint/js`, `typescript-eslint`,
  `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`)
  were already in `package.json` — `pnpm lint` has been failing outright
  since Phase 1, it was just never caught because CI doesn't run it.
  Added the config matching those already-declared dependencies (the
  standard Vite React+TS template shape).
- Fixed the two real warnings it surfaced: `organization-provider.tsx`'s
  `organizations` fallback (`data ?? []`) created a new array every
  render, and the co-located `OrganizationProvider`/`useOrganization`
  export trips `react-refresh/only-export-components` (same shape as
  `useAuth` in `packages/auth/src/auth-provider.tsx`, so suppressed with
  a comment explaining why rather than restructured).
- `packages/*` still lint via `tsc --noEmit` rather than ESLint — that
  was the existing convention and wasn't changed.

## Increment 7 — Test coverage

There was zero test coverage anywhere before this. `pnpm test` passed
across every package only because each `test` script tolerated finding
no test files.

Shipped:

- `packages/shared`: schema tests for `permissions.ts`, `tenant.ts`, and
  `membership.ts` — no new dependencies needed, pure zod validation.
- `packages/auth` and `apps/web` gained jsdom + `@testing-library/react`
  + `@testing-library/jest-dom`, since testing components/hooks needs a
  DOM. Added `vitest.config.ts` (packages/auth) / a `test` block in
  `vite.config.ts` (apps/web) with `environment: "jsdom"`, plus a shared
  setup file per package that calls `cleanup()` after every test — with
  `globals: false`, `@testing-library/react`'s automatic cleanup never
  self-registers, so DOM was leaking between tests until this was added.
- `packages/auth/src/auth-provider.test.tsx`: session loading from
  `getSession`, updates from `onAuthStateChange`, unsubscribe on
  unmount, `signOut`, `signInWithGithub`, and `useAuth` throwing outside
  `AuthProvider`. `AuthProvider` takes its Supabase client as a prop, so
  these use a hand-rolled fake client rather than mocking the SDK.
- `apps/web/src/routes/protected-route.test.tsx`: loading state,
  redirect to `/login` when signed out, renders children when signed in.
- `apps/web/src/lib/invitations.test.ts`: `inviteMember` success, edge
  function error, and no-data-no-error paths.
- Root `package.json` gained a `pnpm.overrides` pinning `vite` to one
  version — without it, pnpm resolved two separate copies of vite
  (5.4.21 and 6.4.3) across the workspace once `vitest`'s dependency
  graph and `@vitejs/plugin-react`'s peer resolution disagreed, which
  broke `defineConfig`/`plugins` typechecking with duplicate,
  structurally-incompatible `Plugin` types.

Not in this increment (still open):

- No tests yet for `OrganizationProvider` (the accept-invitation-on-login
  effect, active-org persistence, permission resolution) or the page
  components (`AccessPage`, `OrganizationsPage`, `LoginPage`) — these
  need heavier Supabase-client mocking (chained `.from().select()...`
  calls) and were left for a follow-up rather than rushed.

## Increment 8 — Audit writer and event publisher worker

Shipped:

- `write_audit_log()` trigger (security definer, no INSERT policy exists
  on `audit_logs` on purpose) attached to `organizations`,
  `organization_memberships`, `feature_flags`, and `files`. Every
  insert/update/delete on those tables is now logged automatically —
  nothing in application code has to remember to call an audit function.
  `organization_settings` and `role_permissions` were left out: they use
  composite primary keys and this trigger assumes a single uuid `id`
  column.
- `claim_domain_events` / `complete_domain_event` / `fail_domain_event`:
  outbox-processing primitives, granted to `service_role` only (matches
  "Event and notification writes are reserved for trusted server-side
  execution"). Claiming uses `FOR UPDATE SKIP LOCKED` so concurrent
  worker runs can't double-process a row. Failures get exponential
  backoff (capped at 60 minutes) and move to `dead_letter` after 5
  attempts rather than retrying forever.
- `supabase/functions/process-events`: calls those three functions to
  actually drain the outbox. See README "Event processing" for the
  `pg_cron` scheduling example.

Honest gap: **`dispatchEvent()` in `process-events` is a stub.** There is
no webhook target, email provider, or any other downstream integration
defined anywhere in this codebase yet, and nothing currently writes rows
into `domain_events` either — the table has existed since Phase 1 with
no producer. Building a worker that "delivers" events to a nonexistent
destination would be fiction, so it logs and marks every event published
instead. The valuable, non-fictional part shipped here is the outbox
mechanics (atomic claiming, retry/backoff, dead-lettering) — real
dispatch logic and event producers are follow-up work once an actual
integration target is chosen.

Not in this increment (still open):

- Nothing writes to `domain_events` yet (no event producers)
- `dispatchEvent()` has no real handlers (no downstream integrations exist)
