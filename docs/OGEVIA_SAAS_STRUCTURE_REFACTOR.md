# Ogevia SaaS Structure Cleanup & UX Refactor

**Status:** Increment 1 of N — foundational identity fixes shipped and verified. This is a large, multi-session refactor by design (the spec itself is ~27 sections covering platform/tenant/staff separation, navigation, and a redesign of nearly every operational page). This document is the repository audit (spec §24) plus the honest status report (spec §27) for what has actually shipped so far, updated as later increments land.

---

## Repository audit: route → target workspace → action

| Route | Current shell | Target workspace | Action | Notes |
|---|---|---|---|---|
| `/organizations` | PlatformShell | Platform | KEEP | Already platform-only, already excludes agency nav. |
| `/feature-flags` | PlatformShell | Platform | KEEP | Same. |
| `/audit` | PlatformShell | Platform | KEEP | Same. |
| *(none yet)* | — | Platform | **BUILD** | Platform Home/dashboard, Subscriptions/Plans (distinct from the Organizations registry), Platform Analytics, Support, Security, System Health, Platform Settings are all still `// TODO` comments in `platform-routes.tsx` itself — the codebase already tracks this gap. |
| `/` (Command Center) | AppShell | Tenant: Home | KEEP | |
| `/owner-dashboard` | AppShell | Tenant: Home (owner-only) | KEEP | |
| `/schedule` | AppShell | Tenant: Operations | KEEP (regroup only) | Regrouped under a new "Operations" nav label this increment; content unchanged. |
| `/staff/visits` | AppShell | Tenant: Operations *or* Staff Portal | REFACTOR (deferred) | Spec §5 wants scheduling consolidated into one Schedule workspace with a `+ Schedule Visit` drawer, not a separate primary nav destination. Not done this increment. |
| `/service-verification` | AppShell | Tenant: Operations (Visits) *and* Staff Portal shortcut | MERGE (deferred) | Spec §6 wants this unified with Visits/Reports into one workspace with tabs (Today/Upcoming/In Progress/Completed/Exceptions/Verification/Reports), while keeping a direct caregiver shortcut. Not done this increment - real, working feature, left exactly as-is. |
| `/service-verification/reports` | AppShell | Tenant: Operations (Visits → Reports tab) | MERGE (deferred) | Same Visits consolidation as above. |
| `/applicants`, `/applicants/:id` | AppShell | Tenant: People | REFACTOR (deferred) | Spec §9 wants pipeline stage columns and more list columns. Not done this increment. |
| `/clients`, `/clients/:id` | AppShell | Tenant: People | REFACTOR (deferred) | Spec §7 wants list-first with a drawer for Add Client, richer columns (authorized/scheduled/completed/remaining hours). Not done this increment. |
| `/team` | AppShell | Tenant: People (rename → Workforce) | REFACTOR (deferred) | Spec §8 rename + roster columns + caregiver record tabs. Not done this increment. |
| `/credentials` | AppShell | Tenant: Compliance | REFACTOR (deferred) | Spec §11 wants compliance-intelligence default view, not an entry form first. Not done this increment. |
| `/authorizations` | AppShell | Tenant: Compliance | REFACTOR (deferred) | Spec §10, same pattern. Not done this increment. |
| `/incidents` | AppShell | Tenant: Compliance | REFACTOR (deferred) | Spec §12, same pattern. Not done this increment. |
| `/access` | AppShell | Tenant: Administration | REFACTOR (deferred, small) | Spec §14 wants expanded role vocabulary and a guarantee platform staff never appear as ordinary members by default — the live-data instance of this was found and fixed manually this session (see below); no code enforcement added yet. |
| `/settings` | AppShell | Tenant: Administration | REFACTOR (deferred, partially done) | Duplicate org-name heading fixed this increment (see below). Full tabbed restructure (Organization/Branding/Workforce/Services/Compliance/Matching/Notifications/Integrations/Billing/Security) not done. |
| `/organizations/new` | AppShell (`/organizations/new` only) | Platform | KEEP | Already gated to platform-owner-initiated org creation, mounted inside the tenant route tree only for the create flow itself. |
| `/login`, `/set-password`, `/reset-password` | none (public) | Public (any host) | KEEP | Already host-independent per `App.tsx:70-72` - this is what made `www.ogevia.com/login` work even before the `app.ogevia.com` domain-alias fix landed. |
| `/apply/:orgSlug`, `/upload/:token` | none (public) | Public (any host) | KEEP | |
| `/` on marketing hosts | none (public) | Marketing | KEEP | |
| `/pricing` | none (public) | Marketing | KEEP | |
| *(none yet)* | — | **Staff Portal** | **BUILD** | A dedicated `StaffShell` (Home / My Schedule / Visit-Clock In / Service Verification / Tasks / Messages / Documents / Profile per spec §1C) does not exist. Today, a `caregiver`-role user gets the *same* `AppShell` as an `organization_owner`, just with fewer nav items visible via permission gating - functionally closer than the spec implies (caregivers already can't reach client management, authorization admin, etc., because those routes are permission-gated), but it is literally the same shell/chrome, not a distinct simplified mobile-first one. This is the single largest piece of unbuilt spec (§1C, §20).

## Problems found (this session)

1. **Header leaked the raw `platform_owner` system-role string into agency UX** (`app-shell.tsx`, spec §2) - `useOrganization()`'s `role` resolves to the literal string `"platform_owner"` for platform owners regardless of which org's workspace they're viewing, and the header rendered it verbatim: "Good evening · platform owner" while displaying a full agency operations workspace. Confirmed live via the user's own screenshot.
2. **Organization identity repeated up to three times on one screen** (spec §3) - sidebar header, `ContextBar`, and (on Settings) the page's own H2 all showed the org's display name simultaneously.
3. **A real paying customer held `organization_owner` membership inside Ogevia's own internal org** - found live, in the database, not in code. Documented in full in `OGEVIA_HOSTILE_AUDIT_2026-08-11.md`'s Stage 5; fixed live by the user through the app's own Access/Revoke UI. A second instance (the same account also owns a separate `ogethinks` org) remains open pending the user's decision.
4. **`app.ogevia.com` itself was unreachable in production** until this session - a missing Netlify domain alias, unrelated to code, also documented in the hostile audit's Stage 4 and fixed live.
5. **No `StaffShell` exists** - caregivers use the same shell as owners/admins, differing only by permission-gated nav visibility, not a purpose-built mobile-first experience.
6. **Platform nav is missing most of its target surface** - Subscriptions/Plans, Analytics, Support, Security, System Health, and Platform Settings are still TODOs in `platform-routes.tsx` itself.

## Architecture before → after (this increment only)

| | Before | After |
|---|---|---|
| Header, platform owner viewing a tenant org | "Good evening · platform owner" | "Good evening, {their name}" - no raw system-role label |
| Header, ordinary org member | "Good evening · organization owner" | "Good evening, {their name} · organization owner" - name-first, matching the spec's example format |
| Org name repetitions on Settings | 3 (sidebar, context bar, page H2) | 2 (sidebar, context bar) - Settings' own H2 is now "Settings," its actual page title |
| Org name in `ContextBar` | Shown | Removed - sidebar chrome already shows it once |
| Sidebar top-level grouping | Overview (unlabeled, 5 items) / People / Compliance / Administration | Home (2 items) / **Operations (new label, 4 items)** / People / Compliance / Administration - same routes, same permissions, closer to the spec's HOME/OPERATIONS taxonomy |

Everything else in the spec (Platform Home dashboard, Subscriptions/Analytics/Support/Security/System Health pages, StaffShell, the Visits merge, Client/Workforce/Applicant/Authorizations/Credentials/Incidents redesigns, Settings tabs, Command Center rebuild, CareScore-in-workflow, card-fatigue removal, page-density pass, org-resolution architecture for future custom domains) is **unchanged this increment** - see Recommended Next Build.

## Routes moved / merged / refactored / removed

- **Moved:** none this increment (labeling/grouping only - see nav regroup above).
- **Merged:** none this increment.
- **Refactored:** `app-shell.tsx` (header + nav grouping), `organization-provider.tsx` (added `userDisplayName`), `context-bar.tsx` (dropped redundant org name), `settings-page.tsx` (fixed duplicate heading).
- **Removed:** nothing.

## Components reused / refactored / removed

- **Reused as-is:** every page component, every RPC, every permission check. Nothing was rewritten or duplicated.
- **Refactored:** `AppShell`, `ContextBar`, `SettingsPage` (header section only in each case).
- **Removed:** nothing.

## Database / RLS changes

None. This increment is presentation-layer only. The one data-level fix this session (revoking a cross-org membership) was a **data** change made live by the user through the existing, unmodified Access UI - no schema, RLS, or RPC changes were needed or made.

## Navigation changes

Sidebar now groups Command Center + Workforce Insights under an unlabeled "Home" position and Schedule / Schedule a visit / Service Verification / Visit Reports under a new "Operations" label, matching the spec's requested taxonomy at the label level. The deeper restructuring the spec wants - merging Schedule/Visits/Reports into one workspace, adding an Insights group, moving Organization/Services/Users & Access/Settings under one Administration umbrella distinct from today's flatter Access + Settings - is not done.

## UX changes

Header identity fix (above) and duplicate-heading fix (above) are the only shipped UX changes. No visual redesign (card-fatigue removal, page-density pass, empty-state/skeleton polish) was attempted this increment - that is a large, cross-cutting effort explicitly scoped to a later build.

## CareScore integration

Not touched this increment. CareScore already exists as a real per-pair computed score (per `docs/design-system.md`) but is not yet surfaced in the Schedule/matching workflow the spec describes (ranked recommended caregivers with explainable reasoning). Deferred.

## Capacity integration

Not touched this increment. Workforce desired/scheduled/remaining hours and client authorized/scheduled/completed/remaining utilization are not yet surfaced in list/table views as the spec describes. Deferred.

## Tests

`pnpm test`: **418/418 passing** (55 test files). Two tests required updates to match intentional behavior changes (not regressions): `context-bar.test.tsx` no longer asserts the organization name renders in that component (it deliberately doesn't anymore), and `settings-page.test.tsx`'s no-permission test now asserts on the actual message text instead of a heading that no longer exists. All other test mocks across ~13 files needed a `userDisplayName` field added to their `OrganizationContextValue` mocks to satisfy the type - mechanical, no behavior changes.

## Build results

- `pnpm typecheck`: clean, 5/5 packages.
- `pnpm lint`: clean, 0 warnings (`--max-warnings=0`).
- `pnpm test`: 418/418 passing.
- `pnpm build`: succeeds. Bundle unchanged at ~1.37 MB minified / 351 KB gzipped (pre-existing chunk-size warning, not addressed this increment - tracked as a Phase 6 finding in the hostile audit).

## Remaining risks

- **StaffShell doesn't exist yet.** Caregivers today get the full `AppShell` with most items permission-gated away, not a purpose-built mobile-first shell. Functionally adequate, structurally not what the spec (or good practice for a phone-in-the-field user) wants.
- **Platform nav is still missing most of its target surface** (Subscriptions/Plans as its own page, Analytics, Support, Security, System Health, Platform Settings) - all pre-existing TODOs, not newly introduced.
- **The `ogethinks` cross-org-ownership question is still open** (flagged in the hostile audit's Stage 5) - same account, same class of vendor/client boundary question, unresolved pending the user's decision.
- **No code-level guard prevents the account-hygiene bug from recurring.** The fix this session was manual (one Revoke click). Nothing stops another account from ending up with owner rights in Ogevia's own org again.
- **The large content refactors (§5-16) are unstarted** and are where most of the real user-facing value in this spec lives. Increment 1 deliberately prioritized the mandatory, low-risk, foundational items (§2, §3, part of §4) over these larger ones to ship something real, verified, and low-risk rather than a large unverified change.

## Recommended next build

In priority order:

1. **Platform Home + the missing Platform nav pages** (Subscriptions/Plans, Analytics, Support, Security, System Health, Settings) - closes the platform-side half of spec §1A and turns the existing TODO comments into real pages.
2. **StaffShell** - a genuinely separate, mobile-first shell for the `caregiver` role (spec §1C), reusing existing pages/RPCs where the underlying data is already correctly scoped (it is - RLS/permission gating doesn't change), just presenting them differently.
3. **Visits merge** (spec §6) - Schedule a visit / Service Verification / Visit Reports into one tabbed Visits workspace, preserving the direct caregiver shortcut. This is the module most directly relevant to the hostile audit's still-open EVV-duplication question, since it's the actual clock-in/verify/sign flow.
4. **Client, Workforce, Authorizations, Credentials, Incidents list-first redesigns** (spec §7, §8, §10, §11, §12) - same shape of change each time (list-first default, creation moved to a drawer/modal), can likely share one new list-page pattern/component rather than four bespoke rebuilds.
5. **Settings tabs** (spec §13) and **Access role vocabulary expansion** (spec §14).
6. **Command Center rebuild, CareScore-in-workflow, capacity integration, visual/density pass** (spec §15-19) - the largest, most subjective, most design-heavy pieces; sequenced last because they depend on the data/list patterns from #4 being settled first.
7. **Org-resolution architecture for future custom domains** (spec §21) - `tenant-resolver.ts` already has the extension point (`PlatformArea` includes `"tenant"` for exactly this); no urgent need until a client actually requests a custom domain.
