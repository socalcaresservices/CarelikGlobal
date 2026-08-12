# Ogevia SaaS Structure Cleanup & UX Refactor

**Status:** Increment 3 of N — foundational identity fixes (1), a real Subscriptions/Plans platform page (2), and a genuinely separate StaffShell for the caregiver role (3), all shipped and verified. This is a large, multi-session refactor by design (the spec itself is ~27 sections covering platform/tenant/staff separation, navigation, and a redesign of nearly every operational page). This document is the repository audit (spec §24) plus the honest status report (spec §27) for what has actually shipped so far, updated as later increments land.

---

## Repository audit: route → target workspace → action

| Route | Current shell | Target workspace | Action | Notes |
|---|---|---|---|---|
| `/organizations` | PlatformShell | Platform | KEEP (trimmed) | Already platform-only, already excludes agency nav. Increment 2: `PlatformPlanManager` extracted out to its own page (see below) - this page is now the registry list plus per-org billing/support expand only. |
| `/subscriptions` | PlatformShell | Platform | **BUILT (increment 2)** | New page, new route, new nav item. Hosts `PlatformPlanManager` (already-existing, already-tested component - reused verbatim, not rewritten), which had no per-organization dependency and never belonged embedded in the org registry. |
| `/feature-flags` | PlatformShell | Platform | KEEP | Same. |
| `/audit` | PlatformShell | Platform | KEEP | Same. |
| *(none yet)* | — | Platform | **BUILD (remaining)** | Platform Home/dashboard, Platform Analytics, Security, System Health, Platform Settings are still `// TODO` comments in `platform-routes.tsx`. Per-organization Billing & Support (currently the row-expand on `/organizations`) still needs an org-picker pattern before it can become its own standalone page - deferred, not done this increment. |
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
| *(new)* | **StaffShell** | **Staff Portal** | **BUILT (increment 3)** | A genuinely separate shell now exists (`staff-shell.tsx`), rendered instead of `AppShell` for the `caregiver` role via a new `TenantShell` router (`tenant-shell.tsx`) that both shells sit behind. Nav: Home (`/`), My Schedule (`/schedule` - already self-scoping server-side, see below), Schedule a visit (`/staff/visits`), Clock in / Verify visit (`/service-verification`). Desktop sidebar + mobile bottom tab bar, no admin nav groups at all (not permission-hidden - structurally absent). Spec §1C also lists Tasks, Messages, Documents, and a self-service Profile - none of those exist as real features anywhere in this codebase, so they are deliberately **not** in this nav (no stub pages built) rather than faked; see Remaining Risks. |

## Problems found (this session)

1. **Header leaked the raw `platform_owner` system-role string into agency UX** (`app-shell.tsx`, spec §2) - `useOrganization()`'s `role` resolves to the literal string `"platform_owner"` for platform owners regardless of which org's workspace they're viewing, and the header rendered it verbatim: "Good evening · platform owner" while displaying a full agency operations workspace. Confirmed live via the user's own screenshot.
2. **Organization identity repeated up to three times on one screen** (spec §3) - sidebar header, `ContextBar`, and (on Settings) the page's own H2 all showed the org's display name simultaneously.
3. **A real paying customer held `organization_owner` membership inside Ogevia's own internal org** - found live, in the database, not in code. Documented in full in `OGEVIA_HOSTILE_AUDIT_2026-08-11.md`'s Stage 5; fixed live by the user through the app's own Access/Revoke UI. A second instance (the same account also owns a separate `ogethinks` org) remains open pending the user's decision.
4. **`app.ogevia.com` itself was unreachable in production** until this session - a missing Netlify domain alias, unrelated to code, also documented in the hostile audit's Stage 4 and fixed live.
5. **No `StaffShell` exists** - caregivers use the same shell as owners/admins, differing only by permission-gated nav visibility, not a purpose-built mobile-first experience.
6. **Platform nav is missing most of its target surface** - Subscriptions/Plans, Analytics, Support, Security, System Health, and Platform Settings are still TODOs in `platform-routes.tsx` itself.

## Architecture before → after (cumulative, increments 1-3)

| | Before | After |
|---|---|---|
| Header, platform owner viewing a tenant org | "Good evening · platform owner" | "Good evening, {their name}" - no raw system-role label |
| Header, ordinary org member | "Good evening · organization owner" | "Good evening, {their name} · organization owner" - name-first, matching the spec's example format |
| Org name repetitions on Settings | 3 (sidebar, context bar, page H2) | 2 (sidebar, context bar) - Settings' own H2 is now "Settings," its actual page title |
| Org name in `ContextBar` | Shown | Removed - sidebar chrome already shows it once |
| Sidebar top-level grouping | Overview (unlabeled, 5 items) / People / Compliance / Administration | Home (2 items) / **Operations (new label, 4 items)** / People / Compliance / Administration - same routes, same permissions, closer to the spec's HOME/OPERATIONS taxonomy |
| Platform nav | Organizations / Feature Flags / Audit, with the plan catalog editor embedded inside Organizations | Organizations / **Subscriptions (new page)** / Feature Flags / Audit - plan catalog is its own destination |
| Caregiver role's shell | Same `AppShell` as every other role, nav items just permission-hidden | **`StaffShell` (new)** - a structurally separate, mobile-first shell (sidebar + bottom tab bar) with only Home/My Schedule/Schedule a visit/Clock in-Verify visit, chosen by a new `TenantShell` router based on `role === "caregiver"` |

Everything else in the spec (Platform Home dashboard, Analytics/Support/Security/System Health pages, the Visits merge, Client/Workforce/Applicant/Authorizations/Credentials/Incidents redesigns, Settings tabs, Command Center rebuild, CareScore-in-workflow, card-fatigue removal, page-density pass, org-resolution architecture for future custom domains) is **unchanged** - see Recommended Next Build.

## Routes moved / merged / refactored / removed

- **Moved:** `PlatformPlanManager`'s mount point from `/organizations` to a new `/subscriptions` route (increment 2). No page content changed, only which route renders it.
- **Merged:** none.
- **New:** `/subscriptions` (`subscriptions-page.tsx`, increment 2). No new *tenant* routes - `StaffShell` (increment 3) reuses the exact same tenant routes (`/`, `/schedule`, `/staff/visits`, `/service-verification`) that already existed, just wrapped in different chrome for the caregiver role.
- **Refactored:** `app-shell.tsx` (header + nav grouping), `organization-provider.tsx` (added `userDisplayName`), `context-bar.tsx` (dropped redundant org name), `settings-page.tsx` (fixed duplicate heading), `organizations-page.tsx` (plan manager removed), `platform-shell.tsx` (nav item added), `platform-routes.tsx` (route added), `App.tsx` (mounts `TenantShell` instead of `AppShell` directly).
- **Removed:** nothing.

## Components reused / refactored / removed

- **Reused as-is:** every existing page component, every RPC, every permission check, `PlatformPlanManager` (moved but not modified). Nothing was rewritten or duplicated.
- **New:** `SubscriptionsPage`, `StaffShell`, `TenantShell`.
- **Refactored:** `AppShell`, `ContextBar`, `SettingsPage`, `OrganizationsPage`, `PlatformShell` (each touched only in the specific section described above).
- **Removed:** nothing.

## Database / RLS changes

None across all three increments. This refactor is presentation-layer only. The one data-level fix this session (revoking a cross-org membership) was a **data** change made live by the user through the existing, unmodified Access UI - no schema, RLS, or RPC changes were needed or made.

## Navigation changes

Tenant sidebar: Home (2 items) / Operations (4 items, new label) / People / Compliance / Administration - same routes and permissions as before, regrouped. Platform sidebar: Organizations / Subscriptions (new) / Feature Flags / Audit. Staff (caregiver role): an entirely separate, shorter nav in `StaffShell` - Home / My Schedule / Schedule a visit / Clock in-Verify visit, with no admin groups present at all (not hidden - structurally absent from that shell).

## UX changes

Header identity fix, duplicate-heading fix, the Subscriptions split, and the caregiver-role shell split are the shipped UX changes so far. No visual redesign (card-fatigue removal, page-density pass, empty-state/skeleton polish) has been attempted - that remains a large, cross-cutting effort explicitly scoped to a later build.

## CareScore integration

Not touched. CareScore already exists as a real per-pair computed score (per `docs/design-system.md`) but is not yet surfaced in the Schedule/matching workflow the spec describes (ranked recommended caregivers with explainable reasoning). Deferred.

## Capacity integration

Not touched. Workforce desired/scheduled/remaining hours and client authorized/scheduled/completed/remaining utilization are not yet surfaced in list/table views as the spec describes. Deferred.

## Tests

`pnpm test`: **425/425 passing** (58 test files), cumulative across all three increments. Notable non-regression changes along the way: `context-bar.test.tsx` no longer asserts the organization name renders there (deliberate); `settings-page.test.tsx`'s no-permission test asserts on the real message text instead of a heading that no longer exists; ~13 files needed a mechanical `userDisplayName` field added to their `OrganizationContextValue` mocks. Two new test files added for the new shells (`staff-shell.test.tsx`, `tenant-shell.test.tsx`) and one for the new page (`subscriptions-page.test.tsx`).

## Build results

- `pnpm typecheck`: clean, 5/5 packages.
- `pnpm lint`: clean, 0 warnings (`--max-warnings=0`).
- `pnpm test`: 425/425 passing.
- `pnpm build`: succeeds. Bundle ~1.38 MB minified / 352 KB gzipped, essentially unchanged (pre-existing chunk-size warning, not addressed - tracked as a Phase 6 finding in the hostile audit).

## Remaining risks

- **StaffShell's nav is intentionally short.** It omits Tasks, Messages, Documents, and a self-service Profile because none of those exist as real features in this codebase - building stub pages for them would be fabricated functionality, not a real refactor. A caregiver today lands on Home/My Schedule/Schedule a visit/Clock in-Verify visit only. If any of the missing four are wanted, they need to be built as real features first (their own follow-up work), then added to this nav - not the other way around.
- **The role → shell mapping is exact-match only.** `TenantShell` renders `StaffShell` only when `role === "caregiver"` precisely; every other role (including `read_only`, which the spec's own §14 role list includes) gets `AppShell`. Whether `read_only` or other lighter roles should also get a simplified shell wasn't in scope for this increment and isn't decided.
- **Not yet verified against the live app.** This shell split was built and unit-tested (`staff-shell.test.tsx`, `tenant-shell.test.tsx`) but not walked through in a real browser against the live `CarelikGlobal` Supabase project, the way the marketing/pricing/login pages were in the hostile audit's Stage 3. The caregiver test account discussed earlier in this session (`admin@gmail.com`) was flagged for removal, not confirmed removed - a real end-to-end check needs either that account restored or a new caregiver-role account to sign in as.
- **Platform nav is still missing most of its target surface** (Platform Home, Analytics, Security, System Health, Platform Settings, and a standalone per-org Billing/Support page) - Subscriptions/Plans shipped this increment; the rest are pre-existing TODOs, not newly introduced.
- **The `ogethinks` cross-org-ownership question is still open** (flagged in the hostile audit's Stage 5) - same account, same class of vendor/client boundary question, unresolved pending the user's decision.
- **No code-level guard prevents the account-hygiene bug from recurring.** The fix this session was manual (one Revoke click). Nothing stops another account from ending up with owner rights in Ogevia's own org again.
- **The large content refactors (§5-16) are unstarted** and are where most of the real user-facing value in this spec lives. Increments 1-2 deliberately prioritized mandatory, low-risk, foundational items over these larger ones to ship something real, verified, and low-risk rather than a large unverified change.

## Recommended next build

In priority order:

1. ~~Platform Home + the missing Platform nav pages~~ **Subscriptions/Plans shipped (increment 2).** Remaining: Platform Home/dashboard, Analytics, Security, System Health, Platform Settings, and a standalone Billing/Support page (needs an org-picker pattern first, since that content is currently embedded per-row in Organizations).
2. ~~StaffShell~~ **Shipped (increment 3).** Remaining: decide whether Tasks/Messages/Documents/Profile get built as real features (then added to the nav), and whether any role besides `caregiver` should also get a simplified shell.
3. **Visits merge** (spec §6) - Schedule a visit / Service Verification / Visit Reports into one tabbed Visits workspace, preserving the direct caregiver shortcut. This is the module most directly relevant to the hostile audit's still-open EVV-duplication question, since it's the actual clock-in/verify/sign flow.
4. **Client, Workforce, Authorizations, Credentials, Incidents list-first redesigns** (spec §7, §8, §10, §11, §12) - same shape of change each time (list-first default, creation moved to a drawer/modal), can likely share one new list-page pattern/component rather than four bespoke rebuilds.
5. **Settings tabs** (spec §13) and **Access role vocabulary expansion** (spec §14).
6. **Command Center rebuild, CareScore-in-workflow, capacity integration, visual/density pass** (spec §15-19) - the largest, most subjective, most design-heavy pieces; sequenced last because they depend on the data/list patterns from #4 being settled first.
7. **Org-resolution architecture for future custom domains** (spec §21) - `tenant-resolver.ts` already has the extension point (`PlatformArea` includes `"tenant"` for exactly this); no urgent need until a client actually requests a custom domain.
