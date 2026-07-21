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
