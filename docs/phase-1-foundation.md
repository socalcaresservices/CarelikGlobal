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

This gap is closed in Increment 9 below.

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

## Increment 9 — Remaining test coverage

Shipped, closing the gap left in Increment 7:

- `apps/web/src/providers/organization-provider.test.tsx`: a platform
  owner gets every permission without a `role_permissions` query at all;
  a regular member's role and permissions resolve correctly from
  `role_permissions`; a pending `'invited'` membership triggers
  `accept_organization_invitation` on login. Uses a small generic
  Supabase query-builder mock (records every `.select()/.eq()/.order()`
  call so the resolver can tell two different queries against the same
  table apart, e.g. the "any status" pending-invite check vs. the
  "status = active" role check on `organization_memberships`).
- `apps/web/src/pages/login-page.test.tsx`: sign-in button, calling
  `signInWithGithub`, surfacing both a thrown error and an
  `?error_description=` query-string error, and redirecting away when
  already signed in.
- `apps/web/src/pages/access-page.test.tsx`: the permission-gated
  not-available state, invite form visibility and submission, and
  role-change/revoke controls (including that they never appear on your
  own row).
- `apps/web/src/pages/organizations-page.test.tsx`: create-organization
  form visibility (platform owner only), client-side slug validation
  before `create_organization` is ever called, the organization list's
  switch-active control, and the edit-active-org form's visibility and
  submission.

48 tests pass across all three packages with tests
(`packages/shared`: 16, `packages/auth`: 7, `apps/web`: 25). Full
pipeline — typecheck, lint, build, test — verified clean.

Not in this increment (still open):

- Server-side audit writer and event publisher worker have no tests of
  their own (SQL functions and a Deno edge function; no live Postgres or
  Deno runtime was available to test against — see Increment 8's commit
  message).
- No end-to-end tests (Playwright/Cypress) anywhere — everything so far
  is unit/component-level with mocked Supabase calls.

## Increment 10 — Verified against a real Supabase project

Everything up to Increment 9 had only ever been checked with `tsc`,
ESLint, and Vitest — there is no Postgres or Deno runtime in this
sandbox, so the SQL migrations and edge functions had never actually
run. This increment created a fresh Supabase project and applied every
migration to it, which surfaced three real bugs no amount of static
review would have caught:

- **`20260715000100_platform_foundation.sql`**: the role/permission seed
  query selected `permission_key` from `public.permissions`, but that
  table's column is `key`. Fixed in place (this migration had not yet
  been applied anywhere, including here, so no corrective migration was
  needed — the source file itself was wrong and is now correct).
- **Function grants** (`20260719170000_lock_down_function_grants.sql`,
  `20260719175000_lock_down_trigger_function_grants.sql`): every
  function in `public`, including the service-role-only outbox functions
  (`claim_domain_events` etc., which have no internal auth check),
  turned out to be callable by unauthenticated `anon` requests.
  `revoke all on function ... from public` — used throughout the schema
  — only revokes the implicit PUBLIC grant; it does not touch privileges
  Supabase's default-privilege setup grants directly to `anon` /
  `authenticated` / `service_role` at creation time, and functions that
  never had any revoke statement at all (`handle_new_user`,
  `set_updated_at`, `write_audit_log`) still carried their original
  PUBLIC grant, which flows through to every role regardless of later
  per-role revokes. Both layers are now closed and verified with direct
  `has_function_privilege()` checks.
- **`write_audit_log()` on the `organizations` table**
  (`20260719180000_fix_audit_writer_organizations_table.sql`,
  `20260719190000_fix_organizations_audit_delete_trigger_timing.sql`):
  the generic audit trigger assumed every audited table has an
  `organization_id` column, which is true for
  `organization_memberships` / `feature_flags` / `files` but not for
  `organizations` itself (it only has `id`). Fixed by special-casing
  `TG_TABLE_NAME = 'organizations'` to use the row's own `id`. That
  then surfaced a second issue on delete: `audit_logs.organization_id`
  foreign-keys to `organizations.id`, and an `AFTER DELETE` trigger
  fires once the row is already gone, so the audit insert violated the
  FK. Fixed by moving the delete-audit trigger to `BEFORE DELETE` for
  `organizations` specifically (insert/update stay `AFTER`); every other
  audited table is unaffected since their `organization_id` points at a
  parent row that a child delete never removes.

Verified end-to-end with live insert/update/delete smoke tests: the
`organizations` audit trail and `updated_at` trigger both now work
correctly, and a `get_advisors` pass afterward shows no unresolved
security findings (remaining `INFO`/`WARN` items — unindexed non-hot-path
foreign keys, RLS policies re-evaluating `auth.*()` per row, a couple of
overlapping permissive policies, and `SECURITY DEFINER` functions being
callable by `authenticated` — are pre-existing, intentional-by-design
characteristics from Phase 1, not new issues).

Not in this increment (still open):

- GitHub OAuth provider credentials (client ID/secret) still need to be
  configured on the new hosted project via the dashboard — `config.toml`
  only covers local CLI development.
- `apps/web`'s environment configuration still points at whatever
  Supabase project was previously configured; it needs the new project's
  URL and anon key.
- The `invite-member` and `process-events` edge functions have not been
  deployed to the new project yet (migrations were applied directly;
  function deployment is a separate step).

## Increment 11 — GitHub OAuth, edge functions, and advisor cleanup on the new project

Closed every remaining gap from Increment 10:

- `apps/web/.env` (gitignored, local-only) points at the new project's
  URL and anon key.
- `invite-member` and `process-events` are deployed and `ACTIVE`
  (`invite-member` requires a caller JWT; `process-events` uses its own
  `x-cron-secret` check, so it's deployed with JWT verification off).
- GitHub OAuth is configured on the new project via a dedicated OAuth
  App with callback `https://cdxxpdyobsqvqveabsda.supabase.co/auth/v1/callback`.
- `20260719200000_fix_advisor_findings.sql` closed every remaining
  `get_advisors` finding: moved the `citext` extension out of `public`,
  indexed every previously-unindexed foreign key, rewrote RLS policies
  that called `auth.uid()` directly so it only evaluates once per
  statement instead of once per row, and split three tables'
  `ALL`-scoped policies into per-command policies so `SELECT` no longer
  evaluates two overlapping permissive policies. Re-ran `get_advisors`
  afterward — clean except expected `unused_index` notices (the project
  has no real traffic yet) and the intentional `authenticated`-callable
  `SECURITY DEFINER` RPCs noted in Increment 10.

Not in this increment (still open):

- Nothing writes to `domain_events` yet (no event producers) and
  `dispatchEvent()` is still a stub — same gap noted since Increment 8.
- No end-to-end tests.

`20260719210000_add_creator_as_organization_owner.sql` (applied right
after, once the app was actually used for the first time): creating an
organization only ever inserted the `organizations` row — the creator
had no membership in the org they'd just made, so the Access page
showed zero members. Found by creating a real organization through the
live app. Fixed going forward, plus a one-time backfill for the
organization created before the fix.

## Increment 12 — Settings screen

`/settings` was a placeholder since Increment 1, even though
`public.organization_settings` (a generic per-organization key/value
store, RLS-gated by `settings.read`/`settings.update`) has existed the
whole time with nothing reading or writing it.

Shipped:

- `packages/shared/src/organization-settings.ts`: schema for a stored
  setting. Deliberately doesn't constrain `key` or `value` beyond basic
  shape, since the table's purpose is holding settings nobody's given a
  dedicated column yet.
- `apps/web/src/pages/settings-page.tsx`: lists every setting stored
  for the active organization, and — gated on `settings.update` — a
  form to add or edit one (key + a JSON value, since values are jsonb)
  and delete existing ones. Version is incremented client-side on every
  save (there's no DB-side trigger for it, unlike `updated_at`
  elsewhere).
- Removed `not-implemented-page.tsx`, now unused — it was only ever
  rendered at `/settings`.

53 tests pass across all three packages with tests (`packages/shared`:
22, `packages/auth`: 7, `apps/web`: 30). Full pipeline verified clean.

## Increment 13 — Audit trail viewer

`audit_logs` has had schema, RLS (`authorized_read_audit`, gated by
`audit.read`), and a trigger writing to it since Increments 1 and 8 -
same situation Settings was in before Increment 12: nothing ever
surfaced it.

Shipped:

- `list_audit_logs(target_organization_id, result_limit)`
  (`20260719220000_list_audit_logs.sql`): security-definer RPC, same
  reasoning as `list_organization_members` - RLS on `user_profiles`
  won't let a non-platform-owner join in another actor's display name
  directly, so this does the join server-side, gated inline by the same
  `has_permission(org, 'audit.read')` check the RLS policy itself uses.
  Left join, not inner: `actor_user_id` is nullable (service-role/system
  changes have no acting user), and a left join means those rows still
  show up, labeled "System", instead of silently vanishing.
- `apps/web/src/pages/audit-page.tsx`: read-only table of who did what
  and when, newest first. New "Audit" nav item, gated on `audit.read`
  like every other permission-gated nav item.
- Verified against the live project: real audit rows from actually
  using the app (creating and updating the "carelik" organization
  through the browser) came back with the correct actor name, and the
  one row inserted directly via SQL (the organization-owner membership
  backfill from Increment 11.5) correctly shows as "System".

58 tests pass across all three packages with tests (`packages/shared`:
22, `packages/auth`: 7, `apps/web`: 34). Full pipeline verified clean.

## Increment 14 — Caregiver scheduling: clients and shifts

The first real product feature beyond the platform foundation. Two new
tables, following the same shape as everything else: `clients` (the
people receiving care) and `shifts` (a caregiver assigned to a client
for a time window).

Shipped:

- `20260719230000_clients_and_shifts.sql`: `clients` and `shifts`
  tables, RLS, `set_updated_at`/`write_audit_log` triggers (both tables
  fit the generic audit trigger's assumptions - single uuid `id`, a real
  `organization_id`), and four new permissions (`clients.read`,
  `clients.update`, `shifts.read`, `shifts.update`). `shifts` RLS is
  deliberately not purely permission-gated: `caregiver_user_id =
  auth.uid()` is OR'd in, so a caregiver can always see their own
  assigned shifts even without the org-wide `shifts.read` permission -
  seeded that way for `staff`, who get `clients.read` but not
  `shifts.read`/`shifts.update`.
- `20260719231000_list_shifts.sql`: security-definer RPC resolving
  client and caregiver names (same reasoning as
  `list_organization_members`/`list_audit_logs` - RLS on `user_profiles`
  blocks a plain join), with the exact same access logic as the RLS
  policy so the "see your own shifts" carve-out works through the
  function too.
- `20260719232000_lock_down_new_rpc_grants.sql`: `get_advisors` caught
  both new RPCs (`list_audit_logs` and `list_shifts`) as callable by
  unauthenticated `anon` requests - the same grant gap fixed in
  Increment 10, reintroduced by not repeating the explicit
  `revoke ... from anon` when adding them. Fixed and reverified clean.
- `apps/web/src/pages/clients-page.tsx`: list/add/edit/soft-delete
  client records, gated on `clients.read`/`clients.update`.
- `apps/web/src/pages/schedule-page.tsx`: list of shifts plus a
  scheduling form (client + caregiver + time window), gated on
  `shifts.update`. The page itself has no permission gate on viewing -
  `list_shifts()` and RLS both already handle who can see what, so
  there's always something valid to render (a caregiver with no
  `shifts.read` still sees their own schedule).
- New "Clients" and "Schedule" nav items.
- Verified against the live project: inserted a real client and shift,
  confirmed `list_shifts()` resolves both names correctly, and confirmed
  both `clients_audit` and `shifts_audit` triggers fired, then cleaned
  up.

68 tests pass across all three packages with tests (`packages/shared`:
30, `packages/auth`: 7, `apps/web`: 42). Full pipeline verified clean.

Not in this increment (still open):

- No calendar/week view - shifts render as a flat list.
- No recurring shifts - every shift is a one-off entry.
- No conflict detection (double-booking a caregiver is allowed).

## Increment 15 — Design system and Action Center

The user set a non-negotiable design direction for every future screen:
Apple-level visual simplicity combined with Epic-level information
density, with an "Action Center" - what needs attention, before
anything else - as the single biggest UX improvement over typical home
care software. See `docs/design-system.md` for the full philosophy;
that file is the permanent reference every future screen should be
checked against.

Shipped:

- `docs/design-system.md`: the design system itself, plus an honest
  "current implementation status" section tracking what's real versus
  what still needs a data model before it can be built without faking
  numbers.
- `apps/web/src/components/action-center.tsx`: the dashboard's lead
  section. Four signals, each computed from data that actually exists
  today - shifts that ended without a status update, shifts happening
  today, active clients with no upcoming visit, and pending
  invitations. Each signal is permission-scoped (a caregiver without
  `shifts.read` still sees their own overdue/today counts via the same
  RLS carve-out `list_shifts()` already has; clients/invitations
  signals only appear if the viewer can see that data at all). A
  healthy state (green, "All caught up") is shown rather than hiding
  the card when the count is zero - always visible, never absent.
- `apps/web/src/pages/overview-page.tsx`: rewritten to lead with the
  Action Center, then a small "this week" KPI row. The previous
  content (an internal list of architecture concepts - authentication,
  multi-tenancy, RBAC, etc.) was removed from the page real users see;
  that's implementation detail belonging in this document, not
  something an agency owner needs on their dashboard.

Deliberately not attempted: CareScore/GeoScore or any scoring model,
credential/authorization/incident tracking, the record-level
KPI-header-plus-tabs layout, sortable/filterable/resizable lists, and
global search. Every one of those needs its own data model or is a
larger structural change - building them now would mean either
fabricating numbers or reworking every existing page without a clear
enough spec yet. `docs/design-system.md` tracks all of them as open so
they aren't lost.

## Increment 16 — Sortable, filterable lists

Closes one item from Increment 15's open list: every list in the app
(Clients, Schedule, Access, Audit) now has a search box and clickable,
sortable column headers.

- `apps/web/src/lib/use-table-controls.ts`: shared client-side search +
  sort hook, with unit tests covering filtering, sort-direction
  toggling, switching sort keys, and combining both. Client-side
  because every list in this app is scoped to a single organization's
  data, small enough that fetching everything and filtering in memory
  beats a server round-trip per keystroke - documented in the file
  itself as a call to revisit if that stops being true.
- `apps/web/src/components/sortable-header.tsx`: the clickable column
  header with a chevron indicating sort state.
- Wired into all four existing lists, each with search scoped to what
  makes sense for that list (name/phone/email for clients, client/
  caregiver for shifts, name for members, who/action/record for audit
  entries). Empty states now distinguish "nothing here at all" from
  "nothing matches your search."

50 web tests pass (5 new for the hook). Full pipeline verified clean.

## Increment 17 — Caregiver weekly hour targets

Closes the priority item the user picked from Increment 15's open
list. Decisions confirmed with the user before building: weekly
period, target set per caregiver (not per-org default), "scheduled +
completed" shift hours count toward the target, and going over target
surfaces as an Action Center alert rather than blocking scheduling.

Shipped:

- `supabase/migrations/20260719240000_caregiver_hour_targets.sql`:
  adds `target_hours_per_week` (numeric, 0-168, nullable) to
  `organization_memberships`. `set_caregiver_weekly_target()` (requires
  `shifts.update`) sets it; `get_caregiver_hours()` returns every
  active member's target alongside scheduled + completed shift hours
  for a given week window, computed directly from `shifts` (overlap-
  aware, so a shift spanning a week boundary is only counted for the
  hours that actually fall in that week). Both functions explicitly
  revoke `EXECUTE` from `anon` at creation time - the anon-grant gap
  that bit this project twice before (Increments 13 and 14) didn't
  happen a third time.
- `apps/web/src/lib/week.ts`: Monday-start week boundary helpers,
  shared between the Schedule page widget and the Action Center so
  both agree on what "this week" means.
- `apps/web/src/components/caregiver-hours.tsx`: "Caregiver hours this
  week" table on the Schedule page - target, scheduled, gap, and a
  status pill (no target set / over target / on track) per caregiver.
  Anyone with `shifts.update` can edit a target inline; everyone else
  sees it read-only. Hidden entirely if there's no caregiver data
  rather than showing an empty table.
- `apps/web/src/components/action-center.tsx`: new critical-toned
  signal, "Caregivers over their weekly hour target," using the same
  week boundaries. Zero caregivers over target shows the healthy state
  ("Everyone on track"), same pattern as every other signal.

Live-smoke-tested against the real Supabase project before shipping:
set a target, inserted a test shift, confirmed `get_caregiver_hours()`
computed hours correctly against real pre-existing shift data the user
had created earlier in the session (verified it was real data, not a
leftover test artifact, before concluding the function was correct
rather than deleting it), then cleaned up only the test-created rows.

60 web tests pass (10 new: 5 for `CaregiverHoursCard`, 1 for
`week.ts`'s helpers covering 4 cases, 1 new Action Center signal test).
Full pipeline (typecheck, lint, build, test) verified clean; `get_advisors`
confirmed no anon-execute gap on the new functions.

## Increment 18 — Caregiver credentials

Second of four features picked from Increment 15's open list (the user
chose all four at once: credentials, authorizations, incidents, and the
record-page layout - each is being shipped as its own increment rather
than one giant change).

`credential_type` is deliberately free text, not an enum - compliance
requirements vary by state and agency, and a fixed list would mean
guessing at business rules nobody has confirmed. `expires_at` is
nullable since not every credential expires. Status (no expiration /
active / expiring soon - within 30 days / expired) is computed at read
time in `packages/shared/src/credentials.ts`, never stored.

Shipped:

- `supabase/migrations/20260719250000_caregiver_credentials.sql`: new
  `caregiver_credentials` table, `credentials.read`/`credentials.update`
  permissions, RLS with the same own-row carve-out as shifts (a
  caregiver sees their own credentials even without `credentials.read`),
  and `list_caregiver_credentials()` to join caregiver names the same
  way `list_shifts()` does.
- `apps/web/src/pages/credentials-page.tsx`: new `/credentials` page -
  add/edit/remove for `credentials.update`, read-only list (own rows
  only, or everyone's with `credentials.read`) for everyone else.
- `apps/web/src/components/action-center.tsx`: new critical-toned
  signal, "Credentials expiring or expired."
- Nav item added with no permission gate, same reasoning as Schedule:
  there's always something valid to show via the own-row carve-out.

65 web tests pass (5 new: 4 for `CredentialsPage`, 1 new Action Center
signal test; plus 7 new schema/status tests in `packages/shared`). Full
pipeline verified clean; `get_advisors` confirmed no anon-execute gap.

Also fixed in this increment: a stray Git-for-Windows install folder had
ended up inside the project directory (`/Git`), which was silently making
every `git`/`rsync`/`cp` operation over the mounted drive crawl or hang.
Added to `.gitignore`. Doesn't affect anything in git history since it
was always untracked - just local clutter that's safe to delete by hand.

## Increment 19 — Client authorizations

Third of the four features picked from Increment 15's open list.

A client can carry multiple authorization rows over time (one per
payer/period), rather than a single current value - that doubles as a
history. `payer` is free text for the same reason `credential_type` is:
naming varies too much by agency to guess a fixed list. Utilization
status (under / on track / over) is computed by comparing authorized
hours against scheduled+completed shift hours within that authorization's
own period, with a small tolerance to avoid flagging rounding noise.

Shipped:

- `supabase/migrations/20260719260000_client_authorizations.sql`: new
  `client_authorizations` table, `authorizations.read`/
  `authorizations.update` permissions, straight permission-gated RLS
  (no own-row carve-out - an authorization isn't tied to a specific
  staff member the way a shift or credential is). `list_client_authorizations()`
  joins the client name and computes each row's scheduled hours
  server-side, same overlap-aware math as `get_caregiver_hours()`.
- `apps/web/src/pages/authorizations-page.tsx`: new `/authorizations`
  page - add/edit/remove for `authorizations.update`, read-only list for
  `authorizations.read`. Gated behind a "Not available" screen without
  the permission, same as Clients (no own-row fallback makes sense here).
- `apps/web/src/components/action-center.tsx`: new critical-toned
  signal, "Clients scheduled over their authorized hours," scoped to
  authorization periods that cover today.

70 web tests pass (8 new: 4 for `AuthorizationsPage`, 1 new Action
Center signal test, plus 10 new schema/status tests in
`packages/shared`). Full pipeline verified clean; `get_advisors`
confirmed no anon-execute gap.

## Increment 20 — Incident tracking

Last of the four features picked from Increment 15's open list.

`category` is free text, same reasoning as `credential_type`/`payer`.
`severity` (low/medium/high) and `status` (open/under_review/resolved)
are workflow enums, not business content, so those stayed structured.
The permission split is new for this one: `incidents.create` lets any
authorized staff member file a report (about themselves or something
they witnessed), while `incidents.update` is the higher bar needed to
edit, resolve, or delete any incident - a caregiver can report something
without being able to manage the whole organization's incident log.

Shipped:

- `supabase/migrations/20260719270000_incidents.sql`: new `incidents`
  table, `incidents.read`/`incidents.create`/`incidents.update`
  permissions, RLS with an own-row carve-out on select (reporter always
  sees their own) and a two-tier insert policy (`incidents.create` +
  `reported_by = auth.uid()`, or `incidents.update` for filing on
  someone else's behalf). `list_incidents()` joins client/caregiver/
  reporter names, same shape as `list_shifts()`.
- `apps/web/src/pages/incidents-page.tsx`: new `/incidents` page - file
  a report (`incidents.create` or better), change status
  (`incidents.update`), read-only list otherwise (own reports without
  `incidents.read`).
- `apps/web/src/components/action-center.tsx`: new critical-toned
  signal, "Incidents awaiting review" (anything not `resolved`).

75 web tests pass (9 new: 4 for `IncidentsPage`, 1 new Action Center
signal test, plus 6 new schema tests in `packages/shared`). Full
pipeline verified clean; `get_advisors` confirmed no anon-execute gap.

This closes every item the user picked from Increment 15's open list
(credentials, authorizations, incidents, and next the record-page
layout). `docs/design-system.md`'s "Not yet built" section now only
lists CareScore/GeoScore and the record-level layout pattern.

## Increment 21 — Record-level layout for Clients and Team

The last of the four features, and the biggest structural one: applies
the design system's header-plus-KPI-plus-tabs record pattern for real,
rather than describing it. No new data model was needed - every tab
reuses an existing list RPC filtered client-side to one record's id.

Shipped:

- `apps/web/src/pages/client-detail-page.tsx`: new `/clients/:id`.
  Header shows name and status; the KPI row shows upcoming shifts and
  open incidents always, and authorized/scheduled/gap hours only when
  there's an authorization whose period covers today (an explicit "no
  active authorization" state otherwise, never a fabricated zero). Tabs:
  Overview, Schedule, Authorizations (hidden without
  `authorizations.read`), Incidents, Notes, History (hidden without
  `audit.read`, filtered to `entity_type = 'clients'` and this client's
  id).
- `apps/web/src/pages/caregiver-detail-page.tsx`: new `/team/:id`,
  gated on `membership.read` (matches the Access page it's linked from).
  KPI row: upcoming shifts, credentials expiring, weekly target,
  scheduled hours this week. Tabs: Overview, Schedule, Credentials,
  Incidents (both what the caregiver was involved in and what they
  reported), History (this member's own actions, filtered by
  `actor_user_id` rather than by record - a different, equally useful
  cut of the same audit log).
- Client names on `/clients` and member names on `/access` now link to
  these pages.

81 web tests pass (6 new: 3 for each detail page). Full pipeline
verified clean.

With this, every feature the user asked for from Increment 15's open
list is shipped: caregiver hour targets, credentials, authorizations,
incidents, and the record-level layout. Remaining open items in
`docs/design-system.md` (CareScore/GeoScore, resizable columns, global
search, distance/geo data) still need real business decisions or data
sources the user hasn't provided yet.

## Increment 22 — CareScore caregiver/client matching

CareScore is a per-pair match score between one caregiver and one
client, not a general caregiver rating - confirmed with the user
directly ("caerescore is the match score to a client and caregiver").
Weighted by proximity and language and availability as most important,
plus skills and shift/incident history, per the user's picks. No real
geocoding or availability-calendar feature exists yet, so proximity and
availability are both text-match/proxy scores rather than true
distance or free-time calculations - documented in the migration
comments so a future increment can swap in real geocoding without
changing the scoring shape.

Shipped:

- `supabase/migrations/20260719280000_caregiver_client_matching.sql`:
  adds `address_city`/`address_state`/`address_zip`/`languages`/`skills`
  to `user_profiles`, and `address_city`/`address_state`/`address_zip`/
  `language_needs`/`care_needs` to `clients`. `set_caregiver_profile()`
  lets a caregiver edit their own location/languages/skills, or lets
  `membership.update` edit anyone's. `list_caregiver_matches()` scores
  every active member of the org against one client: proximity 30
  (zip match, else city+state match, else state-only match, else 0),
  language 25 (language_needs covered by the caregiver's languages,
  fraction-based), availability 20 (proxy from weekly-hour-target minus
  hours already scheduled this week), skills 10 (care_needs covered by
  the caregiver's skills, fraction-based), history 15 (bonus for
  completed shifts together, capped, minus a penalty for any unresolved
  incident together). Total is computed from the same per-component
  values it returns, so it can never drift out of sync with them.
- `supabase/migrations/20260719281000_get_caregiver_location.sql`:
  read-only `get_caregiver_location()`, gated on self or
  `membership.read`.
- `packages/shared/src/matching.ts`: `caregiverLocationSchema`,
  `clientLocationNeedsSchema`, `caregiverMatchSchema`.
- `apps/web/src/pages/caregiver-detail-page.tsx` and
  `client-detail-page.tsx`: new "Location, languages & skills" /
  "Location & care needs" section on the Overview tab, editable
  (comma-separated tags for languages/skills/care needs) when the
  viewer has edit rights, read-only otherwise.
- `apps/web/src/pages/schedule-page.tsx`: once a client is selected in
  the "Schedule a shift" form, the Caregiver dropdown switches from a
  plain alphabetical list to `list_caregiver_matches()` results, each
  option labelled `"{name} — CareScore {score}"` and already sorted
  best match first, with a small status line ("Ranking caregivers for
  this client…" while loading, "Ranked by CareScore, best match first."
  once loaded).

84 web tests pass (3 new: 1 for each detail page's profile-save flow,
1 for the ranked match list on Schedule) plus 59 in `packages/shared`
(6 new for the matching schemas). Full pipeline (typecheck, lint,
build, test) verified clean for both packages; both new migrations
applied live with `get_advisors` confirming no anon-execute gap.

Remaining open items: resizable list columns, global search, and real
geocoding/distance data (CareScore's proximity and availability scores
are still text-match proxies, not true distance/calendar data).

## Increment 23 — Global search

One search box in the header that finds a client, caregiver,
credential, authorization, or incident by name/category and jumps to
the right record. Deliberately excludes the more ambitious examples in
`docs/design-system.md`'s "Search everywhere" section (invoices,
documents, visits/diagnoses) - none of those have a table yet, and a
search result pointing at data that doesn't exist would be exactly the
kind of fabrication this project avoids. Shifts also aren't a separate
result type: a shift's only searchable identity is its client and
caregiver, both already covered.

Shipped:

- `supabase/migrations/20260719290000_global_search.sql`:
  `global_search(target_organization_id, search_query)` unions
  ILIKE-matched rows across `clients`, `organization_memberships` (with
  `user_profiles` for the name), `caregiver_credentials`,
  `client_authorizations`, and `incidents`. Each branch reuses that
  table's own permission check and own-row carve-out (credentials and
  incidents still show your own even without the org-wide read
  permission) - global_search can never surface a row the caller
  couldn't already see on that table's own page. Results are capped at
  8 per type.
- `packages/shared/src/search.ts`: `globalSearchResultTypeSchema`,
  `globalSearchResultSchema`.
- `apps/web/src/components/global-search.tsx`: debounced (250ms) search
  box, minimum 2 characters, dropdown grouped by result type with a
  label per row, closes on outside click. Clients and caregivers link
  to their detail page; credentials, authorizations, and incidents link
  to their list page (no per-record deep link exists yet for those).
- `apps/web/src/layout/app-shell.tsx`: wired into the header, visible
  whenever an organization is active.

88 web tests pass (4 new for `GlobalSearch`) plus 65 in
`packages/shared` (6 new for the search schemas). Full pipeline
verified clean; migration applied live with `get_advisors` showing only
the same baseline "authenticated can call this SECURITY DEFINER
function" notices every other RPC in this project already has (each is
intentional and gated internally by `has_permission`) - no new
anon-execute gap.

This closes every item from the CareScore-era open list except
resizable list columns and real geocoding/distance data, both of which
still need data sources the user hasn't provided.

## Increment 24 — Resizable list columns

The last item from the design system's original "sortable, filterable,
and resizable" list. Purely a display preference - drag a column
narrower or wider, and it's remembered per browser (via localStorage)
the next time that table loads. No data model needed; this is
client-side only.

Shipped:

- `apps/web/src/lib/use-column-widths.ts`: `useColumnWidths(storageKey,
  defaults)` tracks a `{ [columnKey]: pixelWidth }` map, persisted to
  localStorage under the given key, with a `startResize(columnKey)`
  handler that drives a mousedown/mousemove/mouseup drag and clamps to
  a 60px minimum. Each table uses its own storage key
  (`carelik:column-widths:<page>`) so widths don't collide across
  pages.
- `apps/web/src/components/resizable-th.tsx`: `ColumnResizeHandle` (the
  drag strip) and `PlainHeader` (a resizable, non-sortable header cell)
  for the handful of columns - Phone, Client, Payer, Authorized,
  Scheduled, Status - that don't sort but should still resize.
- `apps/web/src/components/sortable-header.tsx`: now accepts optional
  `width`/`onResizeStart` props and renders the same drag handle when
  given.
- Wired into all seven tables that already had sortable headers:
  Clients, Schedule, Access, Audit, Incidents, Authorizations,
  Credentials. Each table's `<table>` switched to `table-fixed` (so a
  `<th>` width actually holds) inside a new `overflow-x-auto` wrapper
  (so a heavily widened table scrolls instead of squeezing other
  columns to nothing).

99 web tests pass (11 new: 6 for `useColumnWidths`, 5 for the header
components' width/handle rendering). Full pipeline (typecheck, lint,
build, test) verified clean. No migration needed - nothing here touches
the database.

This closes every item from the design system's original open list
except real geocoding/distance data, which still needs a data source
the user hasn't provided.

## Increment 25 — Team page

User feedback while trying the app live: caregivers only had a bare
link from Access (which is about roles/invites/permissions) and no
roster of their own the way Clients has. Requested directly: "a
caregiver section just like the client [page]."

Shipped:

- `apps/web/src/pages/team-page.tsx`: new `/team` page, same shape as
  Clients - search box, sortable/resizable columns (Name, Role,
  Status), plus a non-sortable "This week" column. Backed by the same
  `list_organization_members()` RPC Access already uses for the roster,
  merged client-side with `get_caregiver_hours()` (the same RPC the
  Schedule page's hours widget uses) for target/scheduled hours - a row
  shows "-" rather than a fabricated number if the caller can't see
  that caregiver's hours (no shifts.read and it isn't their own row).
  Name links to the existing `/team/:id` detail page.
- `apps/web/src/layout/app-shell.tsx`: new "Team" nav item next to
  Clients, gated on `membership.read` (same as Access and the detail
  page it links to).
- No new migration - reuses two existing RPCs. Access still owns
  role/invite/permission management; Team is just the roster view.

104 web tests pass (5 new). Full pipeline (typecheck, lint, build,
test) verified clean.

## Increment 26 — Team CRUD and CareScore-based assignment

Two more requests from the user while trying the app live: "i need a
caregiver section just like the client" (they meant create/edit/
delete, not just viewing - Team was read-only after Increment 25) and
"assign based on match/CareScore" (a clear way to actually use
CareScore to pick a caregiver for a client, not just see the score on
Schedule).

Shipped:

- `apps/web/src/pages/team-page.tsx`: now has its own invite form
  (email + role, same `inviteMember()` edge function Access uses),
  inline role-change dropdown, and Revoke button per row - deliberately
  duplicating that slice of Access's mutation logic rather than
  sharing it, since the user asked for it directly on Team and Access
  stays the permissions-focused view. Same self-row and revoked-row
  guards as Access (can't edit/revoke yourself or an already-revoked
  member).
- `apps/web/src/pages/schedule-page.tsx`: the client dropdown now reads
  an optional `?clientId=` query param on load and preselects it, so
  arriving with a client already chosen goes straight to the
  CareScore-ranked caregiver list instead of making the user re-pick.
- `apps/web/src/pages/client-detail-page.tsx`: the Schedule tab has a
  new "Assign a caregiver (ranked by CareScore)" link
  (`/schedule?clientId={id}`), shown when the viewer holds
  `shifts.update` - the natural place to start an assignment from,
  since CareScore is a client/caregiver pair score.
- No new migration - both features reuse existing RPCs
  (`list_organization_members`, `get_caregiver_hours`,
  `list_caregiver_matches`) and the existing `organization_memberships`
  table.

111 web tests pass (7 new: 4 for Team's invite/edit/revoke, 1 for the
`?clientId=` preselection, 2 for the Schedule-tab link). Full pipeline
(typecheck, lint, build, test) verified clean.

## Increment 27: Add a caregiver without requiring login

The Team page's "Invite a caregiver" form only collected an email and
sent a sign-in link - the caregiver had to accept a GitHub OAuth invite
before they appeared in the roster with a real name, which didn't match
how the Clients page works (type in the info, saved immediately).

- `supabase/functions/invite-member/index.ts`: now branches on whether
  `firstName`/`lastName` are in the request body.
  - Given (Team page): creates the auth user directly via
    `auth.admin.createUser` with `email_confirm: true` - no email is
    sent. Name/phone are written into `user_profiles` via the metadata
    the existing `handle_new_user` trigger already reads, and the
    membership is inserted with `status: "active"` right away, so the
    caregiver is schedulable immediately.
  - Not given (Access page, for office/admin roles who actually need to
    log in and use the app): unchanged - still
    `auth.admin.inviteUserByEmail`, still `status: "invited"` until
    accepted. This keeps Access's existing invite flow untouched.
  - A duplicate email now returns a clear 409 ("That email is already
    on your team.") instead of a raw Supabase error.
- `apps/web/src/lib/invitations.ts`: `inviteMember` takes optional
  `firstName`/`lastName`/`phone`; result `status` is now
  `"invited" | "active"`.
- `apps/web/src/pages/team-page.tsx`: form renamed "Add a caregiver",
  now collects First name / Last name / Phone / Email / Role, button
  reads "Add caregiver", success message is "Added {name}." for the
  no-login path.
- Deployed `invite-member` (version 2) to the live project.

111 web tests pass (1 rewritten for the new form fields). Full pipeline
verified clean.

## Increment 28: Agency dashboard (fill rate, compliance, capacity)

carelik.com's marketing page advertises an agency-health dashboard
(fill rate, compliance score, available capacity hours). Compared what
it shows against what's built - matching, scheduling, credentials,
authorizations, RBAC, and audit logging already exist; applicant
tracking, a family/client portal, coverage-gap alerts, visit logging,
and MFA don't. User had no preference on which to build next, so
started with the dashboard - it needed no new data entry, only
aggregation of what's already on file.

- `supabase/migrations/20260719300000_agency_dashboard.sql`: new
  `get_agency_dashboard(target_organization_id)` RPC, gated by
  `membership.read` like the other roster-adjacent RPCs. Same "no
  fabricated numbers" rule as the rest of the schema - each metric
  returns null when there's nothing on file to measure it against,
  rather than a misleading 0% or 100%:
  - `fill_rate_pct`: this week's scheduled hours against this week's
    authorized hours (each `client_authorizations` row's
    `authorized_hours` is spread evenly across its period and
    converted to a weekly equivalent - documented simplification, not
    real daily granularity). Null with no live authorization on file.
  - `compliance_score_pct`: share of caregivers with at least one
    credential on file who have none expired. Caregivers with zero
    credential rows are excluded from both sides of the ratio. Null
    with no credentials on file anywhere in the org.
  - `available_capacity_hours`: sum of (weekly target − scheduled
    hours this week) across caregivers with a weekly target set,
    floored at 0 per caregiver. Null with no targets set.
- `apps/web/src/pages/overview-page.tsx`: new "Agency health" section
  below "This week", three cards matching the above, each showing "—"
  with a short reason (e.g. "no authorizations on file") instead of a
  fabricated number when the underlying data doesn't exist yet.
- Applied the migration to the live project; `get_advisors` shows only
  the same pre-existing SECURITY DEFINER info/warning pattern every
  other RPC in this schema already has - no new findings.

114 web tests pass (3 new for `OverviewPage`, which had no test file
before this). Full pipeline (typecheck, lint, build, test) verified
clean.
