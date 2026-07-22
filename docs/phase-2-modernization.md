# Phase 2 — Operations UI Modernization

Branch: `feature/ops-ui-modernization`. Tracks the modernization effort
requested on top of Phase 1 (see `docs/phase-1-foundation.md` for the
30 increments that built the platform this branch is modernizing).

## Scope decision

The original request assumed a services catalog, applicant tracking,
referral pipeline, and a document upload/verification workflow already
existed to "inspect and reuse." They don't - the audit below confirms
what's actually there. Building those from scratch is new feature work,
not modernization, so the user chose to scope this branch to
modernizing what already exists: reusable components, the client
services/authorization data model, the client form redesign, caregiver
credentials/capacity views, universal filters, global search polish,
and the owner dashboard - all against real, already-persisted data.
Applicants, referrals, and document upload remain explicitly out of
scope until asked for.

## Audit findings (before any changes)

Already built and reusable:

- `clients`, `client_authorizations` (payer, authorized_hours,
  period_start/end - no service dimension, no monthly used/scheduled
  split, no status field)
- `caregiver_credentials` (credential_type, issued_date, expires_at,
  notes - no issuing authority, no document upload, no verification
  workflow)
- `caregiver_availability` (day_of_week, start_time, end_time - added
  in Phase 1 Increment 30)
- `global_search` RPC covering clients + caregivers
- `use-table-controls.ts` (client-side search/sort, no filters)
- `@carelik/ui`: only `Card` and `cn` existed before this branch

Does not exist at all (out of scope for this branch per the decision
above): a services/service-catalog table, applicants, referrals, a
documents/upload workflow, "visits" as distinct from shifts, call-outs,
locations as their own entity, service rates for revenue math.

## Increment 1: Reusable UI/search component library

Added to `@carelik/ui` (all new files under `packages/ui/src/`):

- `PageHeader` - the "eyebrow + title + actions" pattern every page
  wrote inline
- `SectionCard` - Card + heading/description, used by every
  detail-page tab and form section
- `FormSection` - a labeled, responsive-column group of fields, the
  building block for the upcoming client-form redesign
- `StatusBadge` - the five-tone pill pattern (neutral/success/warning/
  danger/info) every status column previously re-derived per page
- `ProgressBar` + `usageTone`/`usageLabel`/`UsageBadge` - shared
  "normal / approaching limit / over limit" thresholds for anything
  measured against a cap (authorized hours, caregiver utilization), so
  the definition of "approaching" can't drift between pages
- `MetricCard` - the big-number-plus-label dashboard card; deliberately
  router-agnostic (no react-router-dom dependency in this package) -
  wrap it in the app's own `<Link>` for clickable metrics rather than
  passing a href here
- `EmptyState` / `LoadingState` / `ErrorState` - the three "nothing to
  show yet" states every query-backed page rewrote slightly differently
- `PermissionGate` - takes an already-evaluated boolean (this package
  has no knowledge of organizations/Supabase), replaces the copy-pasted
  "if (!hasPermission) return Not available" block at the top of every
  page
- `UtilizationCard` - the caregiver capacity summary (available/
  scheduled/completed/remaining + utilization % + bar), with a
  `compact` mode for list rows vs. the full detail-page card
- `FilterBar` + `FilterChip` - one shared "controls row + active-filter
  chips + clear all" shell; the filter controls themselves stay
  page-specific
- `SearchableCombobox` - the one reusable searchable single-select the
  spec asked for; supports both a static `options` array (client-side
  filtered) and an async debounced `onSearch` (for large,
  organization-scoped lookups like clients/caregivers), native ARIA
  combobox pattern, no new dependency
- `MultiSelectCombobox` - same two data modes, tracks an array of
  selected values as removable chips (for "Services Requested")
- `QuickActionMenu` - a kebab-style dropdown for row actions, so dense
  rows don't need several separate inline buttons
- `ResponsiveDataView` - renders a real `<table>` on wider screens and a
  stacked card list on narrow ones from the same rows, so list pages
  don't horizontally scroll on mobile

Also added to `packages/ui`: jsdom + `@testing-library/react` +
`@testing-library/jest-dom` (mirroring the setup `packages/auth`
already uses) - this package had zero interactive components before,
so it had no DOM test environment.

No existing component was duplicated - `Card`/`cn` are reused inside
the new components rather than reimplemented (`SectionCard`,
`MetricCard`, and `UtilizationCard` all wrap `Card`).

47 new tests across 14 test files, all passing. Full pipeline
(typecheck, lint, build, test) verified clean across all 4 packages.
No schema changes, no migrations - this increment is pure UI, nothing
touches Supabase yet.

## Increment 2: Client services + authorization data model

Migration: `supabase/migrations/20260721010000_services_and_authorization_usage.sql`,
applied to the live project.

- New `services` table - the agency's own catalog of billable service
  types (org-scoped, soft-deletable, unique per-org name), with
  `services.read`/`services.update` permissions granted to the same
  roles as `authorizations.read`/`authorizations.update`
  (owner/admin/manager/coordinator manage, read_only reads).
- `client_authorizations`: `authorized_hours` renamed to
  `max_monthly_hours` - not a new parallel column, a rename, safe
  because the table had 0 rows in production (checked live
  immediately before writing the migration). The old name never
  conveyed that the cap resets monthly, which is the behavior this
  increment actually builds. Added `service_id` (required - every new
  authorization must reference a service) and `authorization_number`
  (optional). `period_start`/`period_end` remain the authorization's
  overall validity window; the monthly cap applies within it.
- `shifts.service_id` - nullable, added so hours can be attributed to
  the right authorization when a client has more than one. The 3
  existing shifts and any future shift left without a service simply
  don't count toward a specific authorization's usage rather than
  being guessed at. Wiring a service picker into shift creation on the
  Schedule page is follow-up work, not part of this increment.
- `list_client_authorizations` rewritten to join the service name and
  return `hours_used_this_month`/`hours_scheduled_this_month` (from
  completed/scheduled shifts, clamped to the overlap of "this
  calendar month" and the authorization's own period) instead of a
  single whole-period `scheduled_hours`. No status column - the same
  "derive at read time, don't store" rule as `caregiver_credentials`.
- `get_agency_dashboard`'s fill-rate calculation depended on the old
  whole-period `authorized_hours`; rewritten to spread the new monthly
  cap into a weekly equivalent instead (`* 7 / 30.4375`) so it keeps
  working with the new column's meaning.
- `packages/shared`: `authorizations.ts` rewritten around the new
  fields; `getUtilizationStatus` (3 states) replaced by
  `getAuthorizationUsageStatus` (4 states - normal/approaching
  limit/at limit/over limit, counting both used and already-scheduled
  hours against the cap) and a new `getAuthorizationExpiryStatus`
  (expired/expiring soon/active), mirroring `getCredentialStatus`'s
  shape and 30-day threshold. New `services.ts` schema. `permissions.ts`
  gained `services.read`/`services.update`.
- `packages/ui`: `usageTone`/`usageLabel` extended from 3 tiers to 4
  (added "At limit" as its own state, distinct from "Over limit") so
  the authorization and caregiver-capacity views can't drift apart on
  what "approaching" vs "at" vs "over" means.
- `AuthorizationsPage` rebuilt on the new model: a permission-gated
  Services management card (add + activate/deactivate), and the
  authorization form now uses `SearchableCombobox` for client and
  service selection (first real usage of Increment 1's component
  library) plus `FormSection` for layout and `StatusBadge` for the
  usage/expiry pills, replacing the page's own hand-rolled status
  classNames.
- `ClientDetailPage`'s KPI row and Authorizations tab updated to the
  monthly cap/usage/expiry model; `ActionCenter`'s over-authorized
  signal now flags clients whose used+scheduled hours exceed their
  monthly cap this month rather than their whole-period total.

Full pipeline (typecheck, lint, build, test) verified clean across all
4 packages - 243 tests passing, including new coverage for
`getAuthorizationUsageStatus`, `getAuthorizationExpiryStatus`, the new
4-tier `usageTone`/`usageLabel`, `serviceSchema`, and the rebuilt
`AuthorizationsPage` and `ClientDetailPage` behavior.

Not done in this increment (explicitly deferred, tracked separately):
wiring service selection into shift creation on the Schedule page, and
enforcing an `authorizations.override` permission + recorded reason
for scheduling over the monthly cap. Both extend beyond the data-model
and authorizations-UI scope of this increment into the Schedule page,
which the client-form redesign (next increment) and later increments
will touch.

## Increment 3: Client form redesign (sections + services + authorizations)

Migration: `supabase/migrations/20260721020000_client_requested_services.sql`,
applied to the live project.

- New `client_requested_services` join table - a lightweight many-to-
  many between clients and services, distinct from
  `client_authorizations`: it records "the client has asked for this
  service" with no hours or payer, versus an authorization which is a
  payer's approval for a specific number of hours per month. Reuses
  `clients.read`/`clients.update` for access rather than new
  permission keys, since this is part of the client record. Rows are
  pure add/remove (no `updated_at`), but still audited via the same
  `write_audit_log()` trigger every other table uses.
- `ClientsPage`'s add/edit form and `ClientDetailPage`'s profile-edit
  form were both flat, unsectioned grids - both now use `FormSection`
  (Basic information / Contact information / Care notes on Clients;
  Location / Needs / Services requested on the detail page's profile
  form), directly addressing the spec's "compact sectioned layout"
  requirement.
- `ClientDetailPage`'s profile form gained a "Services requested"
  field using `MultiSelectCombobox` against the org's active services
  - the first real use of that component, which was built in
    Increment 1 specifically for this ("Services Requested") case.
  Saving replaces the full set of `client_requested_services` rows for
  the client (delete-then-insert) rather than diffing, since this
  changes rarely and isn't a high-write list. The client record is now
  fetched with the join embedded (`clients.select("*,
  client_requested_services(service_id, services(id, name))")`)
  instead of a second round trip.
- `ClientDetailPage`'s Authorizations tab now links to "Add
  authorization for this client" (`/authorizations?clientId=`),
  mirroring the existing `/schedule?clientId=` pattern from the
  Schedule tab's "Assign a caregiver" link. `AuthorizationsPage` reads
  that param, pre-fills the client combobox, and disables it while
  adding (not while editing an existing row) so the person doesn't
  have to re-pick a client they just came from and can't accidentally
  change it mid-add.
- `SearchableCombobox` now hides its clear (×) button when `disabled`
  - previously a disabled combobox still exposed a clickable clear
  button, which would have let someone "unlock" the pre-filled client
  despite the field being disabled.

Full pipeline (typecheck, lint, build, test) verified clean across all
4 packages - 246 tests passing, including new coverage for the
requested-services save flow, the disabled-clear-button fix, and the
`?clientId=` pre-fill/lock behavior on `AuthorizationsPage`.

Not done in this increment (deferred, same reasons as Increment 2):
applicant tracking, referrals, and document upload remain out of
scope. The Schedule page's shift-creation form still doesn't collect a
`service_id`, so newly created shifts still won't be attributed to a
specific authorization's monthly usage - that's still tracked as
follow-up work, not yet scheduled into a specific increment.

## Increment 4: Caregiver credentials workflow

No schema changes this increment - `caregiver_credentials` already had
everything the UI needed (credential_type, issued_date, expires_at,
notes); this was a UI modernization pass, same treatment
`AuthorizationsPage` got in Increment 2.

- `CredentialsPage`'s add/edit form: native `<select>` caregiver picker
  replaced with `SearchableCombobox`; form sectioned with `FormSection`
  (Caregiver & credential / Dates / Notes); the hand-rolled status pill
  className map replaced with `StatusBadge`.
- Added `?caregiverId=` support to `CredentialsPage`, mirroring the
  `?clientId=`/`?authorizations?clientId=` pattern from Increments 2-3
  - pre-fills and locks the caregiver combobox while adding (not while
  editing an existing row).
- `CaregiverDetailPage`'s Credentials tab previously showed only a raw
  expiry date with no status signal at all - now shows a `StatusBadge`
  per row (Active/Expiring soon/Expired/No expiration) and links to
  "Add credential for this caregiver" (`/credentials?caregiverId=`).

Full pipeline (typecheck, lint, build, test) verified clean across all
4 packages - 247 tests passing, including new coverage for the
`?caregiverId=` pre-fill/lock behavior and the Caregiver detail page's
credential status badges and add-credential link.

Not done in this increment: document upload and a formal verification
workflow (issuing-authority sign-off, uploaded proof) remain explicitly
out of scope per the original scope decision - `caregiver_credentials`
has no document storage or verification-status concept, and none was
added here.

## Increment 5: Caregiver capacity calculations + presentation

No schema changes this increment - `get_caregiver_hours` already
returned everything needed (`target_hours_per_week`,
`scheduled_hours`); this was purely a presentation pass, finally giving
`UtilizationCard` (built in Increment 1 "for the caregiver capacity
summary") its first real caller.

- `CaregiverDetailPage`'s KPI section: the 4-column grid's
  target/scheduled hand-rolled cells (a raw "Xh" number plus a
  separate "(over target)" text flag) are replaced with a 2-column
  grid (Upcoming shifts, Credentials expiring) followed by a "This
  week's capacity" `UtilizationCard` in `compact` mode - the same
  available/scheduled/remaining + progress-bar summary already used
  elsewhere, now wired to a real single-caregiver caller instead of
  sitting unused.
- `caregiver-hours.tsx` (the Schedule page's org-wide caregiver hours
  table) had its own separate 3-state hand-rolled status column
  ("No target set" / "Over target" / "On track", each a colored dot +
  text) - replaced with `StatusBadge` driven by the shared
  `usageTone`/`usageLabel` functions, so the status vocabulary now
  matches the 4-tier system already used by authorizations and the new
  `UtilizationCard` (Normal usage / Approaching limit / At limit / Over
  limit), instead of a third, table-specific 3-state naming scheme.
  The table's structure, inline target-editing, and Gap column are
  unchanged - only the Status cell's presentation changed.
- Removed now-dead code left behind by both swaps: `hasTarget`/
  `isOverTarget`/`formatHours` (unused after the KPI grid replacement)
  in `CaregiverDetailPage`, and `isOver`/the `cn` import (unused after
  the status column replacement) in `caregiver-hours.tsx`.

Full pipeline (typecheck, lint, build, test) verified clean across all
4 packages - 254 tests passing, including updated assertions for the
new "125% utilized" `UtilizationCard` label and the new "Over limit"/
"Normal usage" status badge text.

Not done in this increment: `team-page.tsx`'s dense sortable roster
table still shows plain "Xh / Yh" scheduled-vs-target text rather than
`UtilizationCard` or a `StatusBadge` - deliberately left as-is, since
the compact multi-block card layout would be visually inappropriate
inside a `<td>` in an already-dense, resizable-column table; the
existing minimal text there stays consistent with every other list
page's dense-table convention.

## Increment 6: Universal filter system across list pages

`FilterBar` (built in Increment 1) had a shell but no caller - every
list page still only had search + sort via `useTableControls`, no way
to narrow by status/role/severity. This increment wires it into all 8
list pages and adds the missing piece: a generic client-side filter
hook.

- New `apps/web/src/lib/use-filters.ts` (`useFilters<T>(rows,
  matchers)`): the filtering counterpart to `useTableControls`,
  deliberately kept as a separate hook rather than folded into it, so
  the existing, already-tested search+sort API doesn't change shape.
  Each page composes them: `useFilters` narrows the raw query rows
  first, then `useTableControls` does search+sort on what's left.
  Filters are AND-ed; a filter is "active" only when its value is a
  non-empty string.
- Wired into all 8 list pages, one dropdown per categorical field the
  page already has, reusing each page's existing zod enum or derived-
  status function rather than inventing new option lists: Clients
  (status), Team and Access (role, status - two AND-ed filters),
  Schedule (shift status), Credentials (derived status via
  `getCredentialStatus`), Authorizations (derived usage status via
  `getAuthorizationUsageStatus` and derived expiry status via
  `getAuthorizationExpiryStatus` - two AND-ed filters), Incidents
  (severity, status - two AND-ed filters), and Audit (record/entity
  type - options derived from what's actually in the log, since audit
  entries can come from any table and there's no fixed enum for "every
  entity type that could ever appear").
- Each page's `FilterBar` renders active-filter chips with a "Clear
  all" button, and each empty-state message now distinguishes "no
  rows at all" from "no rows match your search or filters."
- `FilterBarProps.onClearAll`/`activeFilters`/`className` widened to
  accept `undefined` explicitly - the same `exactOptionalPropertyTypes`
  fix pattern as `StatusBadgeProps.className` and
  `SearchableComboboxProps.selectedLabel` from earlier increments.

Fixed an unrelated test-fragility issue this surfaced: several
existing tests asserted on bare enum text like `screen.getByText("high")`
or `screen.getByText("active")`, which now also matches the new filter
`<option>` elements with the same text. Scoped those assertions to
`{ selector: "span" }` (status badges) or `getByRole("cell", ...)`
(plain table cells) so they target the actual rendered value instead
of whichever matching node happens to come first in the DOM.

Full pipeline (typecheck, lint, build, test) verified clean across all
4 packages - 262 tests passing, including a new `use-filters` unit
test suite and new filter-interaction tests on `ClientsPage` (single
filter + clear) and `TeamPage` (two AND-ed filters + clear).

Not done in this increment: filters are client-side only, consistent
with `useTableControls`'s existing "every list here is small enough to
filter in memory" design note - revisit both together if any list ever
needs server-side pagination. No date-range filters were added (e.g.
Schedule's "When" or Audit's "When" columns) - the existing sort
already covers ordering by date, and no one asked for a range filter
specifically; easy to add on top of `useFilters` later if needed.
