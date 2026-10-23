# Clearing the linked TEST records of the retained inactive test clients (option 1) in production

Owner decisions (2026-10-23): the production client records came from testing. Hard-deleting the clients is impossible without bypassing protections, so: KEEP the inactive client rows and
their authorizations, KEEP the five caregiver records and their sign-ins, KEEP the agency, owner, settings and audit history, and REMOVE the test shifts, reservations and other linked records and the
clients' names. Protective triggers are never disabled.

## Preview findings (owner-run 2026-10-23, `ogevia_prd`, agency socal-care-services)
4 clients, all inactive, created Oct 8-10, each holding a client authorization (5 in total; delete-protected). No visits, billing approvals, documents, holds or exports. 36 shifts (26 scheduled
through Dec 27, 10 cancelled), 36 authorization reservations, 5 shift series (35 protected skipped-date rows), 4 caregiver assignments, 4 names, 1 care portal, 3 service-area ZIPs. 111 audit events.

## What `db/maintenance/test_data_clear_linked.sql` does (tested on a real PostgreSQL: `db/test/test-data-clear-linked.db.test.ts`, 10 tests)
- Dry run by default. Apply needs `expected_clients` (from the preview), a verified snapshot id and the typed phrase `CLEAR-<agency>-<N>`.
- Refuses unless every in-scope client is inactive, protections are enabled and triggers are not suppressed.
- Removes, per client, in separate savepoints: authorization reservations, shifts, shift coverage and readiness events, care requests with offers/events/notifications, availability overrides,
  caregiver assignments with readiness flags, care portals, preparation, experience requirements, service-area ZIPs, legal NAMES. Recurring series are removed only where the database allows: a series
  with protected skipped-date history stays (no scheduled job regenerates shifts from a series).
- Never touches: client rows, `client_authorizations` or any delete-protected table, caregivers and sign-ins, memberships, services, settings, idempotency records, audit events.
- Before commit it re-counts EVERY organization-scoped table and aborts unless only the listed tables (plus exactly one audit event, counts only) changed; checks authorization ids and caregiver sign-in links
  are identical.

## Screens and dashboard (tested)
- Names removed: every client read the app makes still works (clients list, directory, authorizations, readiness, documents, audit, issue history); the web shows "Name not set (CODE)" and the client page
  shows "Name not set" with its authorizations (`apps/web/src/aws/client-names-removed.test.tsx`).
- Dashboard (`db/preview/dashboard_totals.sql`, read as the owner through the application functions): before, Upcoming staffing, Needs attention now, reserved and committed minutes and the shifts-with-no-visit
  figure are non-zero because of the test shifts and reservations, and remaining hours are lower than authorized; after, all of those are 0 and remaining equals authorized minus worked.

## Known limit: audit history keeps the names
The `client.created` audit events record the legal name in the raw, append-only event row (database level). Audit is preserved by decision and cannot be altered. No application audit screen or report
shows a name: they expose field names only. Removing the names from audit would need a change to audit immutability, which is not requested.

## Steps (commands are in the session reply; runner `infra/aws/slice/db-window-run.sh`)
1. `dashboard` and `preview` (read-only): the "before". 2. `snapshot-create` (typed SNAPSHOT-NOW; manual, encrypted, under 6 hours old; covers both databases on the instance).
3. `clear-dry-run 4`. 4. `clear-apply 4 <snapshot-id>` (dry run again, then typed CLEAR-socal-care-services-4). 5. `dashboard` and `preview` again: the "after".
Recovery: restore the snapshot to a NEW instance, never over the live one, and copy back only what is needed.
