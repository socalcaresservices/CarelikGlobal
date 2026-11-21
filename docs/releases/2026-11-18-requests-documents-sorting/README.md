# Care requests, document requests, client calendar and table sorting (2026-11-18)

Status: **implemented and tested locally. Not deployed. Migration 0109 applied to no database. Release switch `requestCleanup` OFF everywhere.**

## Owner brief (2026-11-17, from screenshots of app.ogevia.com)
1. Care requests: "2 new alerts" is not clickable; what does it represent?
2. Care requests: a cancelled request still shows as "1 open request"; a closed request should be minimised and only what needs attention shown; filter on unresolved.
3. Reports → Client monthly calendar: the client list is empty.
4. Documents: retract or cancel a request for documents.
5. Every table column should sort A–Z or new to old, across the app.
The owner said "generate all the fix" and, on 2026-11-17 at 23:50, "approved".

## Root causes (from code, branch `claude/ogevia-ux-audit-redesign-w36cov`)
1. The pill was a plain label counting unread rows from `list_staff_care_notifications`. No function ever set `care_notifications.read_at`, so the count could only grow.
2. The list showed every status from `list_care_requests`, including `client_cancelled`, and the page called all of them "open". The Matches panel was offered for any selected request.
3. The calendar's client list was built from the visit rows already loaded on the page, so with no loaded visits it was empty.
4. No cancel path existed. The duplicate requests seen for one caregiver come from two document types for the same thing (for example "TB" and "TB TEST"; 0107 created standard "CPR" and "TB" types next to manually created ones).
5. The AWS tables were hand-built with no sorting.

## What changed
| # | Change | Where | Needs 0109 + switch? |
|---|---|---|---|
| 1 | The pill is a button listing each alert (what happened, which request); Open request, Mark read, Mark all read (the person's own alerts only). | `care-requests-page.tsx`, 0109 `mark_staff_care_notifications_read`, `POST /v1/care-notifications/read` | Clearing: yes. Listing: no. |
| 2 | Default view "Needs action" (not assigned, filled, closed or client cancelled); filter Needs action / Closed / All with counts; a closed request opens read-only. | `care-requests-page.tsx` | No |
| 3 | Client pickers list every active client from `GET /v1/clients`, plus any client with visits on the page. | `service-verification-reports-page.tsx` | No |
| 4 | "Cancel request" (no upload yet, reason required, kept and audited); "Retire" a document type (not the CPR/TB requirement type, not while it has open requests). | `documents-page.tsx`, 0109, two routes | Yes |
| 5 | Shared sorting (`aws/ui/table-sort.ts`, `sort-th.tsx`) on Documents, Care requests, Clients, Caregivers, Staff, Billing review and the Reports visit table. Text A–Z first, dates newest first, empty values last, `aria-sort` on headings. | listed files | No |

Until 0109 is applied and the switch is on, the new buttons answer "not available in this environment yet" instead of failing.

## Not done (follow-up)
- Sorting on summary/figure tables: dashboard hours, monthly chain report, monthly reconciliation, correction history, caregiver hours, authorization impacts, readiness issues, schedule day lists.
- On phones, Documents and Staff show cards without headings, so their sorting is desktop-only.

## Security / data
- All three functions are `security definer`, tenant-scoped, permission-checked (`documents.manage`, `care_requests.read`) and audited (cancel, retire). A person can only clear their own alerts; another person's id is ignored.
- Nothing is deleted. Cancel sets `closed_at` (the existing compliance trigger re-evaluates the caregiver). A request that already has an upload cannot be cancelled.
- Reasons are not written to logs (API test checks this).

## Cost
None. No new AWS resource. Three API routes are added only when the switch is turned on.

## Release steps (owner approval required; demo first)
1. Apply `infra/aws/db/pending/migrations/0109_request_cleanup.sql` to the demo database through the existing ledger runner, after a snapshot.
2. Set `features.requestCleanup: true` for the demo environment in `infra/aws/lib/config.ts`; run `cdk diff` (expect exactly three new routes); deploy the API.
3. Deploy the web build from the same commit.
4. Check on demo: clear an alert; cancel a request with no upload; retire a duplicate type; sort each table.
5. Only after the owner confirms on demo: repeat for production.
