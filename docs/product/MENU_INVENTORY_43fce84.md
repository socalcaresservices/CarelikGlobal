# Real menu inventory and comparison with the design-review mockup

**Repository commit read:** `43fce84553f2e1fa42f5ce3878cfaf7f8209098a` (branch `claude/determined-goodall-syvv7s`, clean working tree). Source read: the repository code. **No deployed build was read.** Which build is deployed (AWS or the older Supabase build): NOT VERIFIED.

**Sources.** Menu entries and show conditions: `apps/web/src/aws/aws-shell.tsx:147-165`. Group order: `apps/web/src/aws/nav-model.ts:12`. Routes: `apps/web/src/aws/aws-root.tsx:57-93`. Role labels: `apps/web/src/aws/aws-workspace.ts:96-111`. Which permissions each role holds comes from the migrations in `infra/aws/db/migrations`: 0002:78-93, 0011:16-23, 0020:84-86 and :432-437, 0021:35-41, 0023:35-38, 0026:35-37, 0027:30-31, 0048:20. A later migration that revokes a grant: NOT VERIFIED. Roles `staff`, `read_only`, `organization_admin`, `coordinator`: their menus are NOT VERIFIED (their grants were not fully read).

Two builds exist at this commit. `apps/web/src/main.tsx:12` selects the AWS build only when `VITE_AUTH_PROVIDER` is `cognito`; otherwise the older Supabase build loads. The mockup follows the AWS build.

## Menu by role (AWS build)

### Administrator (organization_owner)

| Group | Menu item | Route | Menu line | Route line |
|---|---|---|---|---|
| HOME | Home | `/` | aws-shell.tsx:147 | aws-root.tsx:71 |
| CAREGIVERS | Care Team | `/care-team` | aws-shell.tsx:148 | aws-root.tsx:83 |
| CAREGIVERS | Schedule | `/schedule` | aws-shell.tsx:149 | aws-root.tsx:87 |
| CAREGIVERS | Verify visit | `/service-verification` | aws-shell.tsx:150 | aws-root.tsx:72 |
| CLIENTS | Clients | `/clients` | aws-shell.tsx:154 | aws-root.tsx:81 |
| CLIENTS | Care requests | `/care-requests` | aws-shell.tsx:155 | aws-root.tsx:76 |
| CLIENTS | Client monthly calendar | `/service-verification/reports?view=calendar` | aws-shell.tsx:156 | aws-root.tsx:73 |
| VISITS | Visit records | `/service-verification/reports` | aws-shell.tsx:157 | aws-root.tsx:73 |
| BILLING | Billing review | `/billing-review` | aws-shell.tsx:158 | aws-root.tsx:74 |
| REPORTS | Reports | `/service-verification/reports?view=overview` | aws-shell.tsx:159 | aws-root.tsx:73 |
| DOCUMENTS | Documents | `/documents` | aws-shell.tsx:160 | aws-root.tsx:80 |
| SETUP | Services | `/services` | aws-shell.tsx:161 | aws-root.tsx:86 |
| SETUP | Continuity pack | `/continuity` | aws-shell.tsx:162 | aws-root.tsx:89 |
| SETUP | Outage records | `/outage-visits` | aws-shell.tsx:163 | aws-root.tsx:90 |
| SETUP | Accounts | `/accounts` | aws-shell.tsx:164 | aws-root.tsx:77 |
| SETUP | Settings | `/settings/branding` | aws-shell.tsx:165 | aws-root.tsx:91 |

### Manager (manager)

| Group | Menu item | Route | Menu line | Route line |
|---|---|---|---|---|
| HOME | Home | `/` | aws-shell.tsx:147 | aws-root.tsx:71 |
| CAREGIVERS | Care Team | `/care-team` | aws-shell.tsx:148 | aws-root.tsx:83 |
| CAREGIVERS | Schedule | `/schedule` | aws-shell.tsx:149 | aws-root.tsx:87 |
| CAREGIVERS | Verify visit | `/service-verification` | aws-shell.tsx:150 | aws-root.tsx:72 |
| CLIENTS | Clients | `/clients` | aws-shell.tsx:154 | aws-root.tsx:81 |
| CLIENTS | Care requests | `/care-requests` | aws-shell.tsx:155 | aws-root.tsx:76 |
| CLIENTS | Client monthly calendar | `/service-verification/reports?view=calendar` | aws-shell.tsx:156 | aws-root.tsx:73 |
| VISITS | Visit records | `/service-verification/reports` | aws-shell.tsx:157 | aws-root.tsx:73 |
| BILLING | Billing review | `/billing-review` | aws-shell.tsx:158 | aws-root.tsx:74 |
| REPORTS | Reports | `/service-verification/reports?view=overview` | aws-shell.tsx:159 | aws-root.tsx:73 |
| DOCUMENTS | Documents | `/documents` | aws-shell.tsx:160 | aws-root.tsx:80 |
| SETUP | Services | `/services` | aws-shell.tsx:161 | aws-root.tsx:86 |
| SETUP | Continuity pack | `/continuity` | aws-shell.tsx:162 | aws-root.tsx:89 |
| SETUP | Outage records | `/outage-visits` | aws-shell.tsx:163 | aws-root.tsx:90 |

### Scheduler (scheduler)

| Group | Menu item | Route | Menu line | Route line |
|---|---|---|---|---|
| HOME | Home | `/` | aws-shell.tsx:147 | aws-root.tsx:71 |
| CAREGIVERS | Schedule | `/schedule` | aws-shell.tsx:149 | aws-root.tsx:87 |
| CLIENTS | Care requests | `/care-requests` | aws-shell.tsx:155 | aws-root.tsx:76 |
| CLIENTS | Client monthly calendar | `/service-verification/reports?view=calendar` | aws-shell.tsx:156 | aws-root.tsx:73 |
| VISITS | Visit records | `/service-verification/reports` | aws-shell.tsx:157 | aws-root.tsx:73 |
| REPORTS | Reports | `/service-verification/reports?view=overview` | aws-shell.tsx:159 | aws-root.tsx:73 |
| SETUP | Services | `/services` | aws-shell.tsx:161 | aws-root.tsx:86 |

### Caregiver (caregiver)

| Group | Menu item | Route | Menu line | Route line |
|---|---|---|---|---|
| CAREGIVERS | Verify visit | `/service-verification` | aws-shell.tsx:150 | aws-root.tsx:72 |
| CAREGIVERS | My shifts | `/my-shifts` | aws-shell.tsx:151 | aws-root.tsx:88 |
| CAREGIVERS | Availability | `/availability` | aws-shell.tsx:152 | aws-root.tsx:78 |
| DOCUMENTS | My documents | `/documents` | aws-shell.tsx:160 | aws-root.tsx:80 |

A caregiver opening `/` is redirected to `/service-verification` (`aws-shell.tsx:422`). Caregivers have no Home item (`aws-shell.tsx:147`).

### Platform

The AWS build has no platform menu: `apps/web/src/aws/aws-organization-provider.tsx:74` sets `isPlatformOwner: false`. The only platform menu is in the older Supabase build: Dashboard, Organizations, Feature Flags, Audit, System Health (`apps/web/src/layout/platform-shell.tsx:30-34`; routes `apps/web/src/routes/platform-routes.tsx:33-37`).

### Older Supabase build (reference only, not copied)

Tenant sidebar, `apps/web/src/layout/app-shell.tsx:68-155`: Operations Dashboard, Schedule, Service Verification, Report Center, Billing; Candidates, Clients, Care Team; Credentials, Authorizations, Incidents; Access, Settings. Caregiver sees My Visits and Verify Visit (`app-shell.tsx:314-315`).

### Routes outside the menu

| Route | File:line |
|---|---|
| `/clients/:clientId` | aws-root.tsx:82 |
| `/care-team/:caregiverRecordId`, `/care-team/services-review` | aws-root.tsx:85, :84 |
| `/visits/:visitId` (visit review) | aws-root.tsx:75 |
| `/profile` | aws-root.tsx:79 |
| `/settings/billing-rounding` | aws-root.tsx:92 |
| Public: `/login`, `/auth/callback`, `/care`, `/care-offer`, `/confirm-visit` | aws-root.tsx:57-62 |

## Comparison: real menu vs mockup version 4

### 1. In the real menu, missing from the mockup (shown there as "not modeled" pages)

Care Team (aws-shell.tsx:148); Verify visit for office roles (:150); Availability (:152, caregiver); Care requests (:155); Client monthly calendar (:156); Documents / My documents (:160); Services (:161); Continuity pack (:162); Outage records (:163); Accounts (:164); Settings sub-pages Branding and Billing rounding (aws-root.tsx:91-92). Routes outside the menu are not modeled: client detail, visit review, profile, public token pages.

### 2. In the mockup, not in the real menu

| Mockup item | Where it sits now | Real status |
|---|---|---|
| Exceptions as its own tab | Visit records › Action needed | The real app has this as a view of Visit records (`service-verification-reports-page.tsx:1267`), not a menu item |
| Audit log | Reports › Audit log | Not built (table at `0005_service_visits.sql:246`; no screen found) |
| Monthly chain report | Reports › Monthly chain | Not built |
| Visit rules (schedule variance) | Settings | Not built; real Settings opens Branding (aws-root.tsx:91) |
| Open shifts and Pick up | My shifts | Decided (D-P), not built |
| Clients and authorizations on one page | Clients | Real authorizations live in each client's page (`client-detail-page.tsx:218, 280-284`) |
| Authorization monitor panel | Home | Partly real (`routes.ts:1013`; `home-page.tsx:54`) |
| View as, Reset demo, Test script, sign-in picker | top bar / sidebar | Mockup controls only |

### 3. Same item, different label or placement (before this version, now corrected)

| Real | Mockup before | Mockup now |
|---|---|---|
| Home | Dashboard | Home |
| Visit records (VISITS) | Visits tab | Visit records (VISITS) |
| Billing review (BILLING) | Billing tab | Billing review (BILLING) |
| Reports (REPORTS) | Report tab | Reports (REPORTS) |
| Clients (CLIENTS) | Clients & authorizations tab | Clients (CLIENTS) |
| Grouped sidebar; drawer on narrow screens (aws-shell.tsx:276-280, :379) | flat row of tabs | grouped sidebar; Menu button on phones |
| Caregiver: Verify visit, My shifts, Availability, My documents, no Home | one home page holding shifts, open shifts and unscheduled start | the four real items |

## Items flagged (reported, not copied)

- **Four-screen flow:** no AWS menu item conflicts. Verify visit holds the four screens; My shifts and Availability are separate pages. The older Supabase build adds a caregiver "My Visits" list (`app-shell.tsx:314`), a fifth caregiver screen if that build is used.
- **Caregiver pages carry a client code only:** `schedule-page.tsx:48, 377` (MyShift has clientCode, no name). A search of schedule-page.tsx, caregiver-availability-page.tsx, documents-page.tsx and service-verification-page.tsx for date of birth, UCI, Medicaid and payer found no match.
- **Office schedule shows client name and code** (`schedule-page.tsx:112, 248`). Only Administrator and Manager hold `clients.names.read` (0020:432-437). Whether the server hides the name from a Scheduler: NOT VERIFIED.
- **Continuity pack exports client names** (`continuity-pack.ts:19-21`) for Administrator and Manager (0027:30-31). Office-only; your decision whether names belong in that file.
- **NOT VERIFIED for identifiers:** Client monthly calendar, Care requests, and the public `/care`, `/care-offer`, `/confirm-visit` pages.
