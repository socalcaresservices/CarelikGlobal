# Removing confirmed TEST records from production: scoped procedure (PREPARED; NOTHING DELETED)

Owner statement (2026-10-23): the existing production client records came from testing. Authorized: cleanup of the confirmed testing records only. Preserve the agency,
the administrator login, settings and unrelated records, and all audit history. Do not wipe the database.

| Item | Status |
|---|---|
| Which records are test records (scope) | **NOT ESTABLISHED.** The live production database was not readable from the preparing session (no AWS access). Step 1 produces the counts the owner needs to confirm scope. |
| A supported process that deletes clients | **DOES NOT EXIST** (inspected). See section 3. |
| Read-only count preview | Implemented and tested against a real PostgreSQL: `infra/aws/db/preview/test_data_cleanup_preview.sql` |
| Backup before any removal | Procedure below (RDS manual snapshot). NOT taken. |
| Any deletion or deactivation | **NOT DONE.** Stopped before deleting because scope is unconfirmed and the supported removal path is deactivation, not deletion. |

## 0. Decision gate (owner answers before Step 3)
1. Agency: `socal-care-services` only?
2. Scope in one sentence, for example "every client in the agency and everything linked to those clients", or "clients created before <date>". Caregivers, shifts and documents: removed with the clients, or kept?
3. Are any of the records signed, confirmed, billing-approved or exported? (Step 1 section D answers this; those records are protected by design.)
4. Removal method: deactivate (section 3, option 1, recommended) or purge (option 2, needs a reviewed change first).

## 1. Count-only preview (read-only, changes nothing)
Run it through the database access path the owner has approved for production (the same one used for `deploy-production.sh database`; this repository's `TEMP_DB_ACCESS_PROCEDURE.md` is a
proposal that is not applied). It needs a read-only psql connection to `ogevia_prd` only:
```
psql "<ogevia_prd connection>" -X -A -F'|' -v org_slug=socal-care-services -f infra/aws/db/preview/test_data_cleanup_preview.sql > preview-before.txt
```
It prints table names, counts, status words and calendar dates; no names, codes or ids. Sections: A what stays, B1/B2 rows per table, C1-C5 evidence for classifying test data
(creation dates, never-scheduled clients, audit kinds), D1-D2 protected records. Send `preview-before.txt` to the engineer; do not paste it into tickets.

## 2. Recoverable backup (before any change)
The instance `ogevia-prod-postgres` holds both `ogevia_prd` and the TEST database; a snapshot covers both.
```
SNAP=ogevia-prod-postgres-pre-testdata-cleanup-$(date -u +%Y%m%d%H%M)
aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier "$SNAP"
aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP"
aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --query 'DBSnapshots[0].[Status,SnapshotType,Encrypted,DBInstanceIdentifier]' --output text
```
Expected `available manual True ogevia-prod-postgres`. A snapshot is billable until deleted (owner's retention decision). Recovery means restoring it to a NEW instance
(`aws rds restore-db-instance-from-db-snapshot`), never over the live one, and copying back only what is needed.

## 3. Removal: what the application supports
Inspected in this repository: there is no delete, purge or archive function for clients, and nothing sets `clients.deleted_at`. Signed or locked visits, visit evidence and confirmations
(`service_visits_no_delete`, `visit_evidence_no_delete`, append-only triggers) and audit events cannot be deleted by design.
| Option | What it does | Reversible | Needs |
|---|---|---|---|
| 1. Deactivate (**recommended**) | `POST /v1/clients/{id}/status` (`ogevia_api.set_client_status`) sets the client to `inactive` with a reason such as "test data"; it leaves the active lists and the scheduling, audited | Yes | Owner scope confirmation. Done in the application by an administrator, so the supported audit trail is written. |
| 2. Purge | Hard removal of the test clients and linked rows | No (snapshot only) | A NEW reviewed purge function (destructive migration), the Step 2 snapshot, matching counts from Step 1, and the owner's explicit approval. Impossible for signed, locked, billed or exported records without bypassing protections, which is not acceptable. |

## 4. After any removal
Re-run Step 1 into `preview-after.txt`; the agency row, the active members and `audit_events_kept` in section A must be unchanged or only grown by the new audit entries; the administrator signs in.

## 5. New agencies start empty (TEST verification)
Local result (real PostgreSQL, the application's API functions): `db/test/no-demo-data-new-agencies.db.test.ts`: production onboarding creates the organization and no clients,
caregivers, authorizations, shifts, visits or documents; the synthetic seeds refuse every database except `ogevia_sv_test`; two new agencies list empty and cannot read each other.
**The TEST environment itself was NOT verified** (no AWS access). To do it there, create two empty agencies in `ogevia_sv_test` (insert one `ogevia.organizations` row and one
`organization_owner` membership each for two different existing TEST sign-ins), run Step 1's script for each slug (every business table must show no rows; only the audit entry and the standard
onboarding checklist template appear), then sign in as each owner and confirm each sees an empty agency and none of the other's records.
