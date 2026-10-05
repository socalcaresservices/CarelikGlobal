# AWS TEST deployment plan: release 0027–0034

This release adds visit review, the shift-card fix, document reminders and the
single Needs attention count, recurring shifts, billing rounding, the
continuity pack, outage records, hire type and family relationship.

- **Status:** PREPARED and REHEARSED against stubbed AWS. **Not deployed.**
  Deploying needs the owner to type DEPLOY in CloudShell.
- **Pinned code:** `859728fc29832739c371c3b3ab0941e8dd2f87fd` on
  `claude/ogevia-socal-pilot-prep-vfu5tf`.
- **Base:** release 0022–0026 (`0ca5616`), owner-reported live and verified.
  The script checks this itself; see section 0.
- **Environment:** TEST only, synthetic data only. Production, Netlify,
  Supabase, Cognito, DNS and config.json are not touched.

## 0. Preconditions (checked by the script before anything changes)

- The AWS account and region are as expected. The checkout is exactly the
  pin.
- `GET /v1/shifts` and the identity function exist, so the 0022–0026 base
  is live. `GET /v1/shift-series` is not live yet; if it is, the run is a
  resume.
- The API Lambda has exactly one invoke permission, scoped to the API.
- The DB ledger is exactly 0001–0026, and every checksum matches the
  repository. An applied migration that was modified stops the run.
- The full quality gate passes: lint, typecheck, unit tests, build, synth,
  and the web build.
- The strict scope gate (`release_0034_gate.py`) passes, and its self-test
  refuses every tampered variant.

## 1. Exact change set

| Layer | Change | New fixed cost |
|---|---|---|
| RDS | Snapshot `ogevia-prod-postgres-pre-0034-<date>` (kept until you delete it) | Snapshot storage only, a few cents |
| DB `ogevia_sv_test` | Migrations 0027–0034, one transaction each | none |
| API stack | 24 new JWT routes on the existing integration, covered by the existing API-scoped invoke permission (none added). New Handler code package. Identity function: code only, if its bundle changed. No IAM, environment, memory, timeout or VPC change | none |
| Web | New files to the existing site bucket; CloudFront invalidated; `config.json` unchanged | none |
| Not changed | NetworkEgress, EvidenceStorage, Observability and WebHosting stacks; Cognito; RDS security-group rules | — |

The 24 routes:
- `GET /v1/reports/monthly-approval-summary`
- `GET /v1/visits/{id}/review` and `POST /v1/visits/{id}/review-decision`
- `POST /v1/visit-review-decisions/{id}/revoke`
- `POST /v1/document-reminder-days`
- shift series: preview, list, create, change, end and extend
- `POST /v1/shifts/{id}/reschedule`
- the continuity, outage, billing-rounding, employment and
  family-relationship routes from 0027–0030

The exact list is `NEW_ROUTES` in `release_0034_gate.py`.

## 2. Database (what each migration adds)

| Migration | Adds | Down script refuses while |
|---|---|---|
| 0027 continuity pack | Offline agency export records, `continuity.export` permission | continuity exports exist |
| 0028 outage visit records | Records of visits worked during an outage, with reconciliation | outage records exist |
| 0029 billing rounding | Versioned rounding policies per payer and service; separately approved adjustments; `billing.rounding.manage` | policies or adjustments exist |
| 0030 hire type, scheduling, billing review | Caregiver hire type and flexible scheduling, family relationship, the monthly approval summary (minutes only) | any of these are recorded |
| 0031 visit review decisions | Visit review page data, "accept capped billable" and "close not billable" decisions (append-only, revocable until billing approval), approval allowed after an accept decision | review decisions exist |
| 0032 shift card | A cancelled shift no longer shows released time as reserved; "X hr Y min available" wording | — |
| 0033 document reminders, Needs attention | Reminder days per agency and document type (90/60/30/14/7 by default); one attention definition including uncovered shifts and documents | custom reminder days exist |
| 0034 recurring shifts | Weekly series, per-month authorization limits, this-occurrence and this-and-future changes | shift series exist |

**Record safety:** before the window, the script captures every row of all 31
tables that exist at 0026, by value. After the migrations, every row must
match. Permissions must equal the baseline plus exactly 2 permissions and 3
role grants, and earlier audit rows must be unchanged. If anything differs,
the run stops before the API and web are changed.

## 3. How to run (CloudShell, us-west-2)

Paste the contents of `infra/aws/slice/release-0034-bootstrap.sh` and type
DEPLOY at the single prompt. Pasting it again resumes the run. The state is
kept in `~/ogevia-release-0034-run`.

## 4. Live checks (14, read-only, printed as PASS/FAIL)

1. The API stack is UPDATE_COMPLETE after the approval.
2. The other four stacks are unchanged.
3. There are 24 new routes, all JWT, and every earlier route is unchanged.
4. The new routes return 401 without sign-in.
5. The Lambda runs this build and still serves `ogevia_sv_test`.
6. The Lambda configuration is unchanged apart from its code.
7. The Handler IAM policy is unchanged.
8. The identity function configuration is unchanged.
9. The database is at 0034, db:verify passes, and accounts are kept.
10. (9b) Every existing record is unchanged by value, and the permission
    delta is exact.
11. The web URL serves this build, and config.json is unchanged.
12. The DB window is closed.
13. The snapshot is available.
14. The single invoke statement is unchanged.

## 5. Rollback (records created after the deployment are kept)

Run `bash infra/aws/slice/release-0034-rollback.sh <layer>` from the pinned
checkout, one layer at a time:

| Layer | Effect | Data |
|---|---|---|
| `status` | Read-only summary, including the restore-to-new-instance command | — |
| `export` | Read-only copy of records made since DEPLOY | — |
| `web` | Previous web files (config.json untouched) | No data change |
| `api` | Previous API template (the 24 routes removed) and previous Lambda code | No data change; new tables stay unused |
| `db` | Down scripts 0034 to 0027, one transaction each | Each one **refuses** while it would lose records (section 2) |

A full restore goes to a **new** instance from the snapshot, never in place.

## 6. Rehearsal evidence (stubbed AWS, local PostgreSQL 16, 10/05/2026)

| Run | Result |
|---|---|
| Clean | **14/14 PASS**. Mutations exactly: snapshot; SG attach and restore; `cdk deploy --exclusively ServiceVerificationApi`; web sync; invalidation. 90 → 114 routes. Invoke policy 385 bytes, one statement |
| Tampered (a migration side effect at 0030 changes one confirmation's signer name; counts and visit times unchanged) | **STOPPED in the DB window**: "visit_confirmations changed (rows 8 -> 8)". The count-only checks passed, so only the by-value check caught it. No `cdk deploy` and no web sync. The security groups were restored |
| Rollback `status`, `export`, `web`, `api` | All completed. `api` used update-stack with the captured template (peak policy 384 bytes) |
| Rollback `db` with a custom reminder setting present | 0034 rolled back. **0033 REFUSED** ("custom document reminder days are recorded"). The ledger stayed at 0033 with nothing lost |
| Rollback `db` after restoring the default | 0033 → 0027 rolled back; ledger 0026. Visits, confirmations, shifts, reservations, clients, users, memberships and audit rows are byte-identical to the base |

**Limits:**
- The stub cannot prove AWS-side behavior: CloudFormation timing, real
  CloudFront, real IAM evaluation.
- The base database had 0 staff documents and 0 billing approvals, so those
  tables were compared while empty.

## 7. Retest batch on the phone and in the office (synthetic data only)

Run this after the 14/14 live checks.

1. **Visit review.** In Billing review, open "Review visit" on the no-signer
   visit (Client Bravo, 3 min).
   - Expected: the visit page shows client name and code, caregiver,
     service, times, scheduled window (or "unscheduled") and the no-signer
     reason.
   - Only "Close not billable" is offered; a visit without a signature cannot be accepted as billable (late signature recovery is designed, not built). Choose it with a reason. It shows "Reviewed — not
     billable" and the Needs attention count drops by one.
2. **Correction precision.** Open Correct visit on a 4-minute visit and
   change nothing.
   - Expected: the preview shows the same minutes as the list, with
     "unchanged".
3. **Shift card.** Cancel a shift.
   - Expected: no "reserved" time on the cancelled card.
   - Scheduling above what remains shows "Not enough authorized time…
     X hr Y min available".
4. **Recurring.** For a 30 h/month service, create a series Mon/Wed/Fri
   2–4 PM from 11/01/2026.
   - Expected: the preview shows month-by-month hours, and the over-limit
     dates are listed in red.
   - "Create series" is disabled until you choose "Create and skip the N
     listed dates".
   - "Change this date only" moves one occurrence, and "Cancel this date"
     releases its reservation.
5. **Needs attention.** The badge number equals the item count on Home,
   including uncovered shifts and documents to review.
   - Expiring documents appear under "Reminders", not in the badge.
6. **Document reminders.** Set agency reminder days to 60, 30 and 7.
   - Expected: the CPR document shows the stage, the reviewer and the
     review date. A document type without expiry shows no reminder.
7. **Dates.** Every screen touched shows MM/DD/YYYY and h:mm AM/PM.
8. **Printable calendar.** Print one client's month; it fits on one Letter
   landscape page with the caregiver summary.
9. **Manager boundary.** A manager sees the monthly approval summary in
   minutes, with no rates or money.
10. **Reconciliation query.** Run
    `psql … -f infra/aws/slice/reconcile-2026-10-05-no-signer.sql`. It is
    read-only and settles Synthetic Bulk Test vs Client Bravo.

## 8. Cost and security

- **New fixed cost:** none. Variable cost is negligible at pilot volume; see
  `MONTHLY_PLATFORM_COST_2026-10.md`.
- **Security:** no IAM, security-group, Cognito or public-route change. All
  24 routes require a JWT. Permissions are checked server-side in every
  function, and the manager money boundary is preserved: the monthly
  approval summary returns minutes only.
