# Removing confirmed TEST records from production (PREPARED; NOTHING DELETED)

Owner statement (2026-10-23): the existing production client records came from testing, and they are to be REMOVED, not just deactivated. Preserve the agency, the administrator
login, settings and unrelated records, and all audit history. Do not wipe the database. Do not bypass protective triggers.

## What is true about removal (inspected, and proven by tests against a real PostgreSQL)
- The database never deletes some records: `forbid_delete` raises `OGC09` unconditionally on `client_authorizations`, `client_documents`, `client_document_versions`, `client_service_holds`,
  `service_visits` and its confirmations/evidence/corrections, `billing_approvals`, `shift_pickup_requests`, `shift_reconciliations`, audit events and others. Every foreign key in the client
  graph is NO ACTION, so **a client with any of those records cannot be deleted without disabling a trigger. This procedure never does that.**
- Removable: a client with none of them, together with its unprotected records (shifts, care requests, assignments, portals, preparation, names, ...).
- `db/maintenance/test_data_purge.sql` removes each client in its own savepoint and lets the database decide. A client that still has a protected child is rolled back untouched and reported
  KEPT (with the protected table named). It refuses to run if any protection is disabled, re-checks that the agency, memberships, caregivers and audit are unchanged, and writes one
  audit event (counts only). Dry run by default. Tests: `db/test/test-data-purge.db.test.ts` (7), including "refuses with a trigger disabled" and "no bypass in the script text".
- **Consequence for the owner:** clients that hold an authorization, document, hold or visit will REMAIN (deactivation via `set_client_status` is the only supported way to take them out of
  use). Removing them for real would need the protections themselves to be changed, which is a separate, explicitly approved decision (not requested, not built).

## Steps (commands are in the session reply; the scripts are `infra/aws/slice/db-window-run.sh` plus the three SQL files)
1. `preview` (read-only, count-only): sections A to E2, including which clients hold protected records and how many have none.
2. Owner confirms scope from the preview (agency, and whether to restrict by date with `scope_created_before`).
3. `snapshot-create` (typed SNAPSHOT-NOW), verified manual, encrypted, of `ogevia-prod-postgres`, under 6 hours old. Covers both databases on the instance.
4. `purge-dry-run <N>`: shows removed versus kept and why. Nothing changes.
5. `purge-apply <N> <snapshot-id>`: re-verifies the snapshot, repeats the dry run, requires the typed phrase `PURGE-<agency>-<N>`, commits only if every post-check holds.
6. `preview` again; compare. The administrator signs in. Keep the saved outputs.
Recovery: restore the snapshot to a NEW instance (`aws rds restore-db-instance-from-db-snapshot`), never over the live one, and copy back only what is needed. A snapshot is billable until deleted.

## New agencies start empty (TEST)
Local (real PostgreSQL, real API functions): `no-demo-data-new-agencies.db.test.ts` (6) and `test-new-agency-isolation-check.db.test.ts` (4; includes a mutation: a trigger that creates a
client per new organization is caught). In TEST: `db-window-run.sh test verify-new-agencies` creates two synthetic agencies, checks 19 tables are empty, checks the API lists as each owner, checks
that agency B sees nothing of agency A, and ROLLS BACK. It stops with NOT RUN if the database master cannot assume the application role. **Not finished until that run is reported.**

## What was found about onboarding
Production onboarding (`12_prd_bootstrap_tenant.sql`) creates only the organization, its audit entry and the standard caregiver-onboarding checklist template. No migration inserts clients or a test
agency, and no screen creates demo data. The synthetic seeds (02, 03, 04) now refuse every database except `ogevia_sv_test` (05 and 06 already did).
