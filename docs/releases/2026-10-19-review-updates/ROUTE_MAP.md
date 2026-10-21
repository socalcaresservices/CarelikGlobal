# Route map: Batch 4 navigation (owner directive 2026-10-19)

Status: written BEFORE any navigation change, then kept in step with the implementation. IMPLEMENTED and TESTED locally (synthetic data). NOT deployed.
Source of truth for the links: `apps/web/src/aws/nav-model.ts` (model) and `aws-shell.tsx` (the list of links and their `show` conditions). Routes: `aws-root.tsx`.
Rule: no route is removed and no permission changes. A moved item keeps its old path working (redirect that keeps the query string and fragment). Navigation only decides what is SHOWN; every screen's data is authorised again in PostgreSQL.

## 1. Definitions

- **Visits** = records of care delivered, plus the caregiver-side verification entry points. Children: **Visit records**, **Verify visit**.
- **Approvals** = decisions a person must make. Children: **Visits to review** (exception review) and **Ready for Approval** (billing approval). The two stay separate (owner's earlier decision, COUNT_DEFINITIONS.md section 2).
- No queue appears under both. Visit records is a list of every record (it is not a queue). Visits to review is the exception queue and lives only under Approvals. The Approvals link opens Ready for Approval for someone who may see billing, and the exception queue for everyone else (unchanged); it is never repeated as a child.

## 2. Main order and tree (after)

Desktop: left sidebar. Phone (below 768px): the existing Menu button opens the same menu as a drawer (scrim, focus moves in and is trapped, Escape closes and returns focus to the button, choosing a link keeps the route and closes it).

Administrator, manager, scheduler (each item shown only if the permission in section 3 is held):

1. Home
2. Schedule (badge: Scheduling count)
   - Shift requests (was Care requests)
   - Monthly calendar (was under Clients)
3. Visits
   - Visit records
   - Verify visit
4. Approvals (badge: Ready for Approval, or exception review for those who may not bill)
   - Visits to review (badge: exception review)
5. Clients
   - Authorizations (opens the existing Authorization changes screen)
6. Caregivers (badge: Caregivers count)
   - Recruiting
7. Documents (was "Documents & compliance", under Caregivers)
8. Reports
9. Settings (pinned last)
   - Services
   - Appearance
   - Continuity pack
   - Outage records
   - Accounts

Caregiver (unchanged list): My shifts, Verify visit, Availability, My documents, Appearance.

"Visits" has no page of its own: it is a section label (text, not a link) over Visit records and Verify visit, so no queue is opened twice. "Settings" is a link to `/settings/branding` for a person with `organization.update`; for everyone else it is a section label over their own pages (Services, Appearance ...). Section-label children stay reachable when the sidebar is collapsed to icons. Schedule is a real link to `/schedule`. Appearance is visible to every signed-in person.

## 3. Navigation items: current location -> new location

"Perm" is the condition in `aws-shell.tsx` today (unchanged). "Roles" are the roles that normally hold it (the permission is what counts).

| Current item (label, parent) | Current path | Perm / roles (unchanged) | New parent and label | New path | Path changes? | Old link keeps working by |
|---|---|---|---|---|---|---|
| Home | `/` | non-caregiver; AwsLanding needs `visits.read` | Home | `/` | no | n/a |
| Clients | `/clients` | `clients.names.read` | Clients | `/clients` | no | n/a |
| Care requests (child of Clients) | `/care-requests` | `care_requests.read` | Schedule > Shift requests | `/schedule/shift-requests` | YES | `/care-requests` redirects (query and fragment kept) |
| Monthly calendar (child of Clients) | `/service-verification/reports?view=calendar` | `visits.read` | Schedule > Monthly calendar | same | no (placement only) | n/a, same URL |
| Caregivers | `/care-team` | `caregivers.manage` or `visits.manage` | Caregivers | `/care-team` | no | n/a |
| Recruiting (child of Caregivers) | `/care-team/recruiting` | `caregivers.manage` (page also allows `readiness.read`) | Caregivers > Recruiting | same | no | n/a |
| Documents & compliance (child of Caregivers) | `/documents` | non-caregiver and `documents.read` | Documents (top level) | `/documents` | no | n/a |
| Scheduling | `/schedule` | `shifts.manage`, or non-caregiver `visits.manage` | Schedule | `/schedule` | no | n/a |
| Approvals | `/billing-review` (billing) or `/service-verification/reports?view=exceptions` | `billing.visits.read` / non-caregiver `visits.manage` | Approvals | same | no | n/a |
| Visits to review (child of Approvals) | `/service-verification/reports?view=exceptions` | `billing.visits.read` and `visits.read` | Approvals > Visits to review | same | no | n/a |
| Visit records (child of Approvals) | `/service-verification/reports` | `visits.read` | Visits > Visit records | same | no | n/a |
| Verify visit (child of Approvals; staff) | `/service-verification` | non-caregiver and `visits.manage` | Visits > Verify visit | same | no | n/a |
| Reports | `/service-verification/reports?view=overview` | `visits.read` | Reports | same | no | n/a |
| Services (Setup) | `/services` | non-caregiver and `authorizations.read` | Settings > Services | `/settings/services` | YES | `/services` redirects |
| Continuity pack (Setup) | `/continuity` | non-caregiver and `continuity.export` | Settings > Continuity pack | `/continuity` | no | n/a |
| Outage records (Setup) | `/outage-visits` | non-caregiver and `visits.manage` | Settings > Outage records | `/outage-visits` | no | n/a |
| Accounts (Setup) | `/accounts` | non-caregiver and `accounts.manage` | Settings > Accounts | `/accounts` | no | n/a |
| Settings (Setup) | `/settings/branding` | `organization.update` | Settings | `/settings/branding` | no | n/a |
| Appearance (Setup) | `/settings/appearance` | everyone | Settings > Appearance (caregiver: Appearance, as today) | `/settings/appearance` | no | n/a |
| (new link) Authorizations | `/authorization-impacts` (existed, no nav link) | `authorizations.update` or `shifts.manage` (page gate) | Clients > Authorizations | `/authorization-impacts` | no (new link to an existing screen) | n/a |
| My shifts (caregiver) | `/my-shifts` | caregiver | My shifts | same | no | n/a |
| Availability (caregiver) | `/availability` | caregiver | Availability | same | no | n/a |
| My documents (caregiver) | `/documents` | caregiver and `documents.manage_own` | My documents | same | no | n/a |
| Verify visit (caregiver) | `/service-verification` | caregiver | Verify visit | same | no | n/a |

In-page sections that are not routes (they stay where they are and are listed so nothing is lost): **Hours and limits** and **Manage repeating shifts** are buttons on the Schedule page (`shifts.manage`); **Availability** review/edit sits on the caregiver record; **Add shift** and **Repeat visits** are on Schedule.

## 4. Routes with no navigation row (kept as they are)

| Route | Page | Reached from | Gate |
|---|---|---|---|
| `/clients/:clientId` | Client detail (Authorizations section with service and Hours left, plus a link to Shift requests) | Clients | `clients.names.read` |
| `/care-team/:caregiverRecordId` | Caregiver detail | Caregivers | `caregivers.manage` or `visits.manage` |
| `/care-team/services-review` | Service approvals | Caregivers pages | `caregiver_services.read` |
| `/visits/:visitId` | Visit review (counts as Visit records for highlighting) | Visit records, Visits to review | data-level |
| `/attention`, `/action-needed`, `/staffing`, `/visit-review` | Needs attention, Action needed, Upcoming staffing, Visit queue | header badge, Home | per page |
| `/reporting` | Reporting page | Home/Reports | per page |
| `/compliance` | Compliance holds | Documents and caregiver pages | `readiness.read` |
| `/authorizations/rates` | Authorizations without a rate | Home/Reports | `billing.read` |
| `/settings/billing-rounding`, `/settings/visit-rules` | Billing rounding, Visit rules | Settings pages | per page |
| `/profile` | Profile | sidebar footer | signed in |
| `*` (unknown) | redirects to `/` | n/a | n/a |
| `/login`, `/auth/callback`, `/care`, `/care-offer`, `/confirm-visit` | public/auth routes, outside the shell | links sent to people | token / sign-in |

## 5. Care requests: where it goes and why

The Care requests page lists requests from a client or their representative for care on specific days; staff accept a request and it BECOMES A SHIFT (a shift row marked "From a Care Request"; the Schedule page links back to it). Its outcome is scheduling work, its queue is "requests waiting to become shifts", and the people who work it are schedulers. It is not client record keeping: nothing on it edits the client.
Decision: **Schedule > Shift requests** at `/schedule/shift-requests`. Reasons: (1) it sits one step before a shift on the Schedule -> Shift -> Caregiver -> Eligibility -> Assign flow; (2) the schedule already links shifts back to it; (3) putting it under Clients made a scheduler look in two places. Context kept: the client detail page shows a "Care requests" link (same permission) and the old `/care-requests` URL redirects. The page content, permission (`care_requests.read`) and the API are unchanged.

## 6. Authorizations visibility

- Nav: Clients > Authorizations opens the existing Authorization changes screen (`/authorization-impacts`), previously reachable only from a link inside a client record. It is the only standalone authorizations screen; per-client authorizations (service, authorized hours, Hours left, tier, Renew) are the "Authorizations" section of the client detail page (unchanged, open by default).
- Scheduling: the Add shift form and the Assign / Change caregiver panel show an "Authorization" line for the shift's client and service: the service name and Hours left for the shift's month, read from the server's monthly summary (`/v1/reports/monthly-service-summary`, the same figure the client page shows; the web does not recompute it). It stays visible through Shift -> Caregiver -> Eligibility -> Assign because it sits above the caregiver picker and the eligibility result. A person without `visits.read` sees no figure (the server refuses it), never a false zero.

## 7. Counts on moved items

Badges are unchanged in meaning and source (COUNT_DEFINITIONS.md): Schedule = Scheduling count (`shifts.manage` or `visits.manage`); Caregivers = urgent staff-document issues; Approvals = Ready for Approval (people who may bill) or exception review; Visits to review = exception review. Moving Care requests, Monthly calendar, Documents, Services and Appearance did not move any count. Shift requests, Monthly calendar and Documents carry no badge (they had none).

## 8. Tests

`apps/web/src/aws/route-map.test.tsx` walks every row above (screens replaced by markers): the authorised role reaches the page, old paths redirect to the right screen with the query string, unknown paths still fall back to Home, and the menu shows each link only to roles holding its permission. `route-denial.test.tsx` runs the REAL screens for a role without the permission and checks their existing refusal text (new and old address). `shift-authorization-context.test.tsx` covers the authorization line and the client-page link. `nav.test.tsx`, `sidebar-home.test.tsx` carry the grouping assertions.
