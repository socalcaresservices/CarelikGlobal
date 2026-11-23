# Phase 5 — Sorting completion

Date: 2026-11-23 · Branch: `stabilization/main-reconciliation` · STATUS: **COMPLETE for the AWS web app; NEEDS HUMAN INPUT for legacy Supabase-path pages (below)**

Framework used: the existing shared pattern only (`useSortedRows`, `SortTh`, `SortButton` in `apps/web/src/aws/ui/`). No new sort system. Rules unchanged: text A–Z, dates newest first, empty values last, server order kept until a heading is clicked, exports keep the standard order (R39).

## Requested targets

| Target | Location | Before | After | How |
|---|---|---|---|---|
| Dashboard Hours (Hours by service) | `aws/home-page.tsx` → `HoursByServiceTable` | none | all 11 columns | module-level component (hook not after early returns); test `aws/hours-table-sort.test.tsx` |
| Monthly Chain Reports | `aws/monthly-chain-report.tsx` | none | every column of "Full chain for the month"; "Sorted view" note (export keeps standard order) | SortTh |
| Reconciliation Reports (monthly hours table) | `pages/service-verification-reports-page.tsx` | none | 14 columns (Client … Difference, Approved when shown); "No." renumbers after sort | SortTh; CSV/print order unchanged |
| Correction History | same page | none | 11 columns (dates sort as dates; Original/Corrected by worked minutes) | SortTh |
| Caregiver Hours (reports view) | same page | none | Caregiver, Worked, Billable, Visits | SortTh |
| Caregiver Hours (weekly target card) | `components/caregiver-hours.tsx` | none | Caregiver, Target, Scheduled, Gap, Status | SortTh (hook placed before the empty-state return) |
| Authorization Impacts | `aws/amendment-impacts.tsx` | none | groups: Client/Service/Version/Amended; items: When/What; phone uses SortButton | `ImpactGroups`/`ImpactItems` |
| Readiness Issues | `aws/readiness/readiness-card.tsx` | none | Issue, Affected (count), Status; phones get SortButtons | `ReadinessIssues` |
| Schedule Day Lists | `aws/schedule-page.tsx` → `ShiftList` | none | Time/Client/When, Service, Caregiver, Call-out reason, Status; later day tables keep sr-only plain headings (one visible header per section); phones get Time/Client/Status buttons | SortTh/SortButton |

Visits table (reports) was already sorted (2026-11-17) and is unchanged.

## Inventory of every `<table>` in `apps/web/src` (computed by grep of `<table` vs `SortTh|SortButton`)

Sorted (AWS app): amendment-impacts, billing-review-page, care-requests-page, care-team-page, clients-page, documents-page, home-page, monthly-chain-report, readiness-card, schedule-page, staff-pages (3), service-verification-reports-page (4), caregiver-hours.

Not sorted, by design: `aws/ui/chart.tsx` (screen-reader data table of a chart), test fixtures.

Not sorted, legacy tree: `pages/{access,audit,authorizations,billing,candidate-detail,candidates,care-team-detail,care-team,clients,credentials,incidents,organizations,schedule,settings}-page.tsx`, `components/{calendar-summary,platform-plan-manager}.tsx`. These are imported by `routes/tenant-routes.tsx` / `platform-routes.tsx` (the Supabase-backend route tree, `App.tsx` `getTenantRoutes`). I did not verify whether production (AWS backend) serves any of them. **Needs owner input:** if any is reachable in production, tell me which and I will apply the same pattern; I will not sort pages that are not live (INFERRED: they are not, because `aws/` equivalents exist for clients, care team, billing review).
`components/calendar-summary.tsx` is rendered inside the reports "calendar" view (print layout); left unsorted because it is a fixed calendar grid, not a list.

## Verification

- `pnpm run typecheck` (apps/web): clean. `pnpm run lint`: clean (`--max-warnings=0`).
- `pnpm exec vitest run` (apps/web): 156 files / 1417 tests passed before adding the new test; new test `hours-table-sort.test.tsx` passes (1/1).
- Not verified: visual/mobile rendering of the new headers on a real phone; deployed behavior (no deployment performed).
