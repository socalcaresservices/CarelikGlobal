# Ogevia retention policy (DRAFT for owner and counsel)

Status: **DRAFT, 2026-11-27.** The structure, the technical behavior and the enforcement plan are written. **Every retention period is blank on purpose**: how long a record must be kept is a legal and payer decision (California, federal, the payer or regional-center contract, and the agency's own policy), not something software or this draft may assume. Fill the "Period" column once counsel or the owner decides; until then **nothing is deleted** (see "What the system does today").

## What the system does today (verified in the repository)
| Data | Where | Behavior now |
|---|---|---|
| Visits, confirmations, corrections, authorizations (all versions) | PostgreSQL | Never deleted. A signed visit is locked; a correction creates a new row and keeps the original; authorizations keep every version (`forbid_delete` triggers). |
| Audit log (`audit_events`), override history, visit/exception/label event histories | PostgreSQL | Append-only: no update, no delete through any application path. |
| Signature images | private S3 bucket, versioned, KMS, public access blocked | No expiry rule (CDK lifecycle comment: "record-retention periods are a legal/business decision gate"). Only incomplete uploads are cleaned after 7 days. |
| Caregiver, client, schedule, document, notification records | PostgreSQL / S3 | Soft states (inactive, retired, cancelled); no purge job exists. |
| CloudWatch logs | CloudWatch | Finite retention set in CDK (`logRetention`, one year in production config). |
| RDS backups | RDS | Automated backups per the instance setting (verify live, see Security Readiness Checklist). |
| Email in transit | SES | Ogevia stores delivery history (status, time), not message bodies for alerts; alert text carries no client details by design. |

## Policy table (owner/counsel to complete)
Column "Trigger" = the event that starts the clock. "Period" = **decision needed**. "Disposal" = what happens at the end.

| Record class | Examples | Trigger | Period | Disposal | Notes |
|---|---|---|---|---|---|
| Service delivery and verification | visits, punches, location results, confirmations, corrections | date of service | ____ | ____ | Payer and audit use; signed evidence is part of it. |
| Signature evidence | signature images, late confirmations, paper forms | date of service | ____ | ____ | Same period as the visit it supports, never shorter. |
| Authorizations | every version, amendments, impacts | end of the authorization period | ____ | ____ | Needed to explain billing for the period. |
| Schedules | shifts, call-outs, coverage requests, open-shift offers | shift date | ____ | ____ | |
| Billing approvals and reports | approvals, rounding, exports ledger | approval date | ____ | ____ | |
| Caregiver employment and compliance | profile, CPR/TB, documents, background-check results, holds, overrides | end of employment (or last verification) | ____ | ____ | Override and hold history is audit data (below). |
| Client records | profile, service location, assignments | end of service | ____ | ____ | A deletion request does not override a legal hold. |
| Audit and override history | `audit_events`, exception and signature event logs | event date | ____ | ____ | Shortest period should not be below the longest record it explains. |
| Notifications | in-app and email alerts, delivery history | send date | ____ | ____ | No client details in alert text. |
| Candidate and applicant data | applications, interview notes | decision date | ____ | ____ | |
| Application logs | CloudWatch | log date | set in CDK | expiry by CloudWatch | Already finite. |
| Backups | RDS snapshots, S3 versions | creation | ____ | ____ | Must not outlive the record policy by default; deletion in backups follows their own expiry. |

## Rules that apply to every class
1. **Legal hold wins.** A hold (audit, dispute, investigation, litigation) suspends disposal for the records it names until the owner lifts it in writing.
2. **No silent deletion.** Disposal is an audited, owner-approved batch job (not built; see below), never an ad hoc query.
3. **Minimum necessary** after the active period: keep identifiers needed to prove the service and its billing; remove contact details and free text that are no longer needed, where the period allows.
4. **Agency isolation:** each agency (tenant) has its own policy values; one agency's disposal never touches another's records.
5. **Exports** (CSV, Excel, print) are copies: staff are told to store them only in approved locations and delete them when done (add to the staff handbook).

## Enforcement plan (not built; each step needs the decision above first)
1. Add a per-agency `retention_settings` table (class, period in months, disposal action) and an audited `retention_candidates` read function that lists what *would* be disposed, by class, with counts only. Read-only; safe to build first.
2. An owner-approved disposal batch that writes an audit event per batch (class, date range, count, approver), deletes S3 versions and database rows in one traceable run, and refuses records under a legal hold.
3. S3 lifecycle rules for evidence objects set to the decided period (CDK change; requires a plan and the owner's go because lifecycle expiry is irreversible).
4. Backup expiry aligned to the policy.

**Owner/counsel input needed:** the periods, the disposal actions, who may place and lift a legal hold, and whether the agency's payer contracts set longer minimums.
