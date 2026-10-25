# Application redesign: navigation, help, Reports, Staff, Roles & Permissions (DRAFT, review branch)

Status: **implemented and tested locally; not merged; not deployed; nothing on TEST, Demo or Production has been touched or verified.**

## 1. Identification

| | |
|---|---|
| Repository | `socalcaresservices/CarelikGlobal` |
| Review branch | `claude/redesign-review-nav-ui` (created from the branch below) |
| Starting branch / commit | `claude/staff-management-nav-ui` at `96ba51843383ad3bc5ee9c33a307fa182f0604a2` (pushed; itself based on `main` 466f8ac) |
| Why that base | Staff, Staff Types and Roles & Permissions exist only on that branch (pending migration 0086, not in any release set). `main` does not contain them, so the redesign of those pages cannot start from `main`. |
| Intended target | Development (local harness) first; then TEST on approval. Production is not a target of this branch. |
| Deployment status | **This branch: not deployed.** Starting branch: not deployed. Migration 0086 is staged in `infra/aws/db/pending/` and is in no release package; the 13 staff API routes are created only where `features.staffManagement` is true (off for the `prd` stack). What is live on TEST/Demo/Production was not inspected in this task (UNKNOWN). |

## 2. Navigation inventory (before) and mapping (after)

Before (starting commit): six groups, 31 links (My work, Home, Schedule, People, Operations, Settings) built in `aws-shell.tsx`, with a tab strip above the page. Every link keeps its existing route and its existing permission condition; only grouping, labels and presentation changed.

| Before (group · label) | Route | Visible when | After (group · label) | Where |
|---|---|---|---|---|
| Home · Dashboard | `/` | staff | Dashboard | sidebar (plain link) |
| Home · Action Needed | `/action-needed` | staff + visits.read | Dashboard · Action Needed | tab |
| Schedule · Calendar | `/service-verification/reports?view=calendar` | visits.read | Scheduling · Calendar | tab (under Schedule) |
| Schedule · Shifts | `/schedule` | shifts.manage, or staff + visits.manage | Scheduling · **Schedule** | sidebar |
| Schedule · Requests | `/schedule/shift-requests` | care_requests.read | Scheduling · Requests | tab (under Schedule) |
| People · Clients | `/clients` | clients.names.read | Clients · Clients | sidebar |
| People · Authorization changes | `/authorization-impacts` | authorizations.update or shifts.manage | Clients · Authorization changes | sidebar (stands in for "Care Plans", see section 4) |
| People · Caregivers | `/care-team` | caregivers.manage or visits.manage | Staff · Caregivers | sidebar |
| People · Staff | `/staff` | staff + staff.read | Staff · Staff | sidebar |
| People · Recruiting | `/care-team/recruiting` | caregivers.manage | Staff · Recruiting | tab (under Caregivers) |
| Operations · Documents | `/documents` | staff + documents.read | Staff · Documents | tab (under Caregivers) |
| Operations · Visits | `/service-verification/reports` | visits.read | Operations · Visits | tab (under Reports) |
| Operations · Verify visit | `/service-verification` | staff + visits.manage | Operations · Verify visit | tab (under Reports) |
| Operations · Outage records | `/outage-visits` | staff + visits.manage | Operations · Outage records | tab (under Reports) |
| Operations · Approvals (may bill) | `/billing-review` | billing.visits.read | Operations · **Billing** | sidebar |
| Operations · Approvals (may not bill) / Visits to review | `/service-verification/reports?view=exceptions` | visits.manage (or billing + visits.read) | Operations · Visits to review | tab (under Reports) |
| Operations · Reports | `/service-verification/reports?view=overview` | visits.read | Operations · Reports | sidebar |
| Settings · Roles & Permissions | `/settings/roles` | staff + staff.read | Settings · Roles & Permissions | sidebar |
| Settings · Staff Types | `/settings/staff-types` | staff + staff.read | Staff · Staff Types | sidebar |
| Settings · Accounts | `/accounts` | staff + accounts.manage | Settings · Accounts | tab (under Roles & Permissions) |
| Settings · Branding | `/settings/branding` | staff + organization.update | Settings · **Agency Settings** | sidebar (opens branding) |
| Settings · Services | `/settings/services` | staff + authorizations.read | Settings · Services | tab (under Agency Settings); Agency Settings opens it for people who cannot change branding |
| Settings · Continuity | `/continuity` | staff + continuity.export | Settings · Continuity | tab (under Agency Settings); same fallback |
| Settings · Appearance | `/settings/appearance` | everyone | Settings · Appearance | tab, **and** a footer link next to Profile for everyone (so a person with no Settings group still reaches it) |
| My work · Verify visit | `/service-verification` | caregiver | My Work · Verify Visit | sidebar |
| My work · My shifts | `/my-shifts` | caregiver | My Work · **My Schedule** | sidebar |
| My work · Availability | `/availability` | caregiver | My Work · Availability | tab |
| My work · My documents | `/documents` | caregiver + documents.manage_own | My Work · My documents | tab |

Never in the menu, before or after (reached from the pages that link to them, unchanged): `/compliance`, `/staffing`, `/visit-review`, `/authorizations/rates`, `/attention`, `/reporting`, `/care-team/services-review`, `/settings/billing-rounding`, `/settings/visit-rules`, `/profile`, and the detail routes (`/clients/:id`, `/care-team/:id`, `/visits/:id`). Old redirects (`/care-requests`, `/services`) are untouched.

Route ownership is unchanged (`apps/web/src/aws/aws-root.tsx`); no route, page, permission, API, table or migration was added.

## 3. What changed

- **Sidebar**: groups Dashboard, Clients, Staff, Scheduling, Operations, Settings (agency staff) or My Work (caregivers); collapsible with chevrons; the group of the current page opens by itself and is highlighted, other groups keep the state the person gave them; a closed group shows the count of what waits inside it when one page has work waiting, or a bare dot when several do (counts of different things are never added). Children are indented alike, have no icons, active page has a filled row and a bar on its left edge; 32px rows (44px on touch); the agency block is flat; Settings follows the other groups after a divider (no empty gap); footer has Profile, Appearance, Sign out. The drawer closes after choosing a page.
- **Tabs** above the page carry the related pages of each group (section 2), so nothing was dropped to shorten the menu.
- **Top status**: "Nothing urgent 0" is now "No urgent items" (no number, lower emphasis); urgent items keep the red/amber badge with their count.
- **Help**: `InfoTip` now has an optional title and further-detail link, opens on hover, focus, click and tap, closes on Escape, its close button, the icon again or a tap elsewhere; floats (never blocks); text stays in the page for screen readers; a test fails the build if any help text exceeds 250 characters (four were shortened). Standard texts: Clients, Schedule, Caregivers, Roles & Permissions ("Controls system access by role."), Staff Types.
- **Terminology**: page titles match the menu (Dashboard, Schedule, Caregivers, My Schedule, Visits to review); role names are Owner, Administrator, Manager, Scheduler, Coordinator, Staff, Read-only, Caregiver.
- **Reports**: heading, actions (Print / PDF and Export CSV together; the CSV buttons are shown in the action row through a portal, their data and server export call are untouched), one filter bar (report, then Month for the two monthly reports or Start date / End date for the others, Clear Filters), results, existing expandable details. Monthly reports show only the filters their data honours (Client and Service; the calendar only Client and Month).
- **Staff**: columns Name, Staff Type, Role, Status, Email, Phone (and the existing No.); search; Staff Type, Role and Status filters; Clear Filters; Edit, Invite (Invite again for a pending one), Disable / Enable (only where true), More (Change role, History, Add profile); labelled lines on a phone instead of a table. Email is the contact email, never the sign-in email.
- **Roles & Permissions**: Role / Description / Users Assigned table (counts are the real active memberships), then a read-only matrix: ✓ granted, – not granted, grouped by area, plain permission descriptions, no keys. Descriptions of a role with no permissions say "No permissions granted" (taken from the data).
- **Density**: shared Card has less padding and no shadow; page titles are bold and uniform.

## 4. Requested but not in the application (documented, not built, no placeholder)

| Requested | Finding | What the menu does instead |
|---|---|---|
| Clients · **Care Plans** | No care-plan page, route or table exists. | Clients · Authorization changes (the closest existing screen); authorizations also live on each client's page. |
| Scheduling · **Open Shifts** | No staff-facing open-shifts page exists (open shifts are the caregiver's own pickup list in My Schedule; unfilled shifts are handled on Schedule with "Unfilled only"). | Scheduling · Schedule and Requests. |
| Operations · **Payroll** | No payroll page or data exists. | Not shown. |
| My Work · **My Tasks** | No tasks page exists. | My Work · Verify Visit (the caregiver's task). |
| Settings · **Agency Settings** (hub) | No hub page exists. | Opens branding for an administrator, otherwise Services, otherwise Continuity; the others are its tabs. |

## 5. Findings to decide on (not changed)

1. **The Administrator role has almost no permissions in the database** (`organization_admin`: only care-request management). The requested description "Operational management" would not be true, so the page describes what is enforced. Likewise Staff and Read-only have none. Changing role permissions is a database change and needs your decision.
2. The Owner's footer still reads "ADMINISTRATOR VIEW" (a view label, not the role name); the role is shown as "Owner" on Staff and Roles & Permissions.
3. Staff screens and role assignment still allow one role per person.

## 6. Verification performed (local, synthetic data, local PostgreSQL; nothing deployed)

Real browser (`verify-redesign.mjs`, Chromium; desktop 1360 and EMULATED 390 phone with touch, not a real device): **ALL PASS**: owner sidebar contents; all 24 distinct destinations reachable from the sidebar and tabs open a titled page with no error and at most one current sidebar item; current group opens by itself and a group opened by hand stays open; Help opens on hover, keyboard focus and tap, closes when the pointer leaves, on Escape and on its close button (a defect found here, "Close" not hiding the tip while the icon kept focus, was fixed); Staff search, role filter, Clear Filters, numbering follows the filter, row actions; Roles table counts, matrix, no permission keys; Manager and Scheduler lose Staff Types and Roles & Permissions (the Roles page refuses them); caregiver sees only My Work and still reaches Appearance; the phone drawer closes after choosing a page; no sideways page scroll on phone Staff, Roles & Permissions, Reports and Dashboard.

Appearance matrix (`local-harness/appearance-matrix.mjs`: Large text and Compact density, Light/White/Soft gray/Dark, Standard/Minimal, desktop and phone):
- First run, 4 screens, 128 runs: 16 runs with sideways page scroll, all on the phone Roles & Permissions page (screen-reader-only text inside the scrolling table escaped its box). **Fixed**; re-run of Roles & Permissions and Staff, 64 runs: 0 overflow, 0 low-contrast, 0 hidden alerts, 0 undersized controls.
- Still open on Reports (Visits overview), in every combination: low text contrast on the coloured summary tiles ("Worked hours", "Billable hours") and one undersized link ("Reporting & billing", 18px high). Those lines were not changed by this branch (diff-checked, not re-measured on the starting commit). **Not fixed.**
- The script applied the requested appearance in 94 of 128 first-run combinations (64 of 64 in the re-run); the other first-run combinations were measured in the previous setting.

## 7. Automated tests (actual results)

- `@carelik/web`: 128 files, **1254 tests passed**. New or rewritten: navigation (31), route map (36), sidebar (18), badges (8), Staff/Roles/Staff Types (14), Reports filter bar and actions (50 in file), Help control incl. a source scan that fails if any help text exceeds 250 characters (4).
- `@carelik/ui`: 73 passed. `pnpm typecheck` (7 tasks) and `pnpm lint` (6 tasks) passed. `@carelik/web` production build passed.
- Not re-run on this branch (files unchanged since the starting commit's run): infra-aws unit and database suites, sv-api database suite. The starting commit's known unrelated failure (`dst-local-times`, date-dependent) is unchanged.

## 8. Not verified / known issues

- Real phone, real keyboard-only walkthrough, screen reader, print / Save as PDF of the changed Reports layout, the CSV file contents of the three exports (export logic and server call untouched; button is shown through a portal and its click is tested), TEST, Demo and Production.
- Scheduler (holds `authorizations.read`) sees Agency Settings, which opens Services for them, because that is the only agency page their permissions allow; the old menu showed them Services too.
- "ADMINISTRATOR VIEW" footer label for the Owner (section 5.2).
- The Administrator role finding (section 5.1) is a data/permission decision, not changed here.

## 9. Evidence

`screenshots/before` (starting commit) and `screenshots/after` (this branch): desktop navigation (all groups open), Dashboard, Reports, Staff, Roles & Permissions; phone drawer, Reports, Staff, Roles & Permissions. Captured by `shots2.mjs` on the local harness as the synthetic Owner. Tool scripts: `shots2.mjs`, `verify-redesign.mjs`.
