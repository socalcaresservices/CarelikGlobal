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
