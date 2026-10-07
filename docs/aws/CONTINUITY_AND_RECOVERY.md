# Ogevia outage continuity and recovery (pilot readiness, blocker 7)

**Status:** assessment 2026-10-05; continuity pack (0027) and outage visit records (0028) BUILT and verified locally, NOT deployed. **NOT READY** (combined recovery drill outstanding). Requirement recorded in `docs/product/PILOT_SCOPE_RECONCILIATION.md` section 17.
**Scope:** AWS TEST environment (`us-west-2`, account 300094796789) and every agency that uses it.

Evidence classes:
- **VERIFIED**: code, configuration or a test in this repository.
- **OWNER-REPORTED**: a live result the owner ran and reported.
- **AWS-DOCUMENTED**: a stated AWS service behaviour that has not yet been measured here.
- **UNKNOWN**: not established.

## 1. Principle

Backups and continuity are different things.
- AWS backups (RDS automated backups, snapshots, S3 versioning) let Ogevia **restore data after** an incident.
- They give an agency **nothing during** the outage: no schedule, authorization balance, client list or way to record a visit.

**Continuity for an agency** means three things:
- (a) the agency already holds a recent, protected copy of what it needs to operate;
- (b) it has a defined way to record visits while Ogevia is down;
- (c) it has a controlled way to bring those visits back in afterwards, without losing or duplicating hours.

## 2. Recovery: what exists and what is measured

| Part | Current configuration | Recovery path | Measured | Class |
| --- | --- | --- | --- | --- |
| Database (RDS PostgreSQL `ogevia-prod-postgres`, single-AZ, encrypted, private) | Automated backups for 7 days with point-in-time recovery; deletion protection; manual snapshots before each deployment | Restore to a **new** instance (snapshot or a point in time), then point the API at it | **Database restore: 4 min 15.142 s** (2026-10-03, 23:03:12.179 → 23:07:27.321 UTC); data verification and cleanup passed (`~/ogevia-phase7/drill-finish-20261003T234756Z.log`) | OWNER-REPORTED |
| Signatures and staff documents (S3 evidence bucket) | Versioned, KMS-encrypted, private; one region; no cross-region copy | A deleted or overwritten object is recoverable from an earlier version. The database stores keys, not images, so a restored database finds its objects only if they still exist | Never drilled together with a database restore | VERIFIED controls; joint recovery UNKNOWN |
| Account access (Cognito user pool) | Deletion protection on; MFA required; one region; no backup | No AWS backup or restore feature exists for user pools. Users and attributes can be listed and re-created. **Passwords and authenticator (MFA) secrets cannot be exported**: after a pool loss every user must set a new password and enrol MFA again. Ogevia links users by `cognito_sub`, which changes when a user is re-created, so a re-link step would be needed (not built) | Never drilled | AWS-DOCUMENTED (no pool backup); re-link UNKNOWN |
| Application (API Gateway, Lambda, CloudFront, S3 web files) | Defined in CDK; deployed by pinned scripts; rollback material captured per run | Redeploy from the pinned commit; the API reads its database name and host from its configuration | Never drilled against a restored database | UNKNOWN |
| Whole system together | — | Not defined as one procedure | **Full-system recovery time: UNKNOWN** | UNKNOWN |

### Maximum potential data loss (what the configuration allows, not a promise)

| Scenario | Database | Signatures and documents | Accounts | Basis |
| --- | --- | --- | --- | --- |
| Instance failure, corruption or a bad change | Changes after the latest restorable time. AWS documents this as typically within the last 5 minutes. **Not yet measured here**: the drill must record `LatestRestorableTime` against the clock | None for objects (versioning) | None (Cognito is separate) | AWS-DOCUMENTED; to be measured |
| Restore from a pre-deployment snapshot instead of a point in time | Everything after the snapshot | Objects remain; new database rows that referenced them are lost | None | VERIFIED (snapshot procedure) |
| Loss of the AWS region or of its data | No copy outside `us-west-2` exists: potentially **all** data, or no service until the region recovers | Same | Same; plus everyone resets passwords and MFA | VERIFIED (no cross-region copy configured) |
| Ogevia unavailable, data intact | No loss in Ogevia. Visits made during the outage exist only on the agency's outage records until re-entered | — | — | Process (section 4) |

Cross-region protection (snapshot copy to a second region, S3 replication, a user list export) adds recurring cost. It needs an owner decision; it is not assumed here.

## 3. Agency operational export while Ogevia is unavailable ("continuity pack")

**Problem:** every report today runs inside Ogevia, or in CloudShell for the operator. Both are unavailable in the same outage. Nothing gives an agency access to its data during an outage.

**Design (recommended for the pilot):** the agency keeps its own recent copy, downloaded while Ogevia is up.
- **What:** one file per agency with a **"Data as of" timestamp** (server time) and the agency name:
  - the next 14 days of shifts (client code, caregiver, service, times);
  - active clients (code, display label, and name only where the downloader may see names);
  - active authorizations with the month's authorized, reserved and used hours and the remainder;
  - active caregivers and their contact role;
  - a block of pre-numbered outage visit record numbers (section 4).
- **Who:** only staff with a new `continuity.export` permission. Default: Administrator (`organization_owner`) and Manager. Caregivers never.
- **Isolation:** produced by one database function that derives the agency from the signed-in user's membership. The browser cannot request another agency's pack. It is checked by a two-agency isolation test.
- **Minimum necessary:** no dates of birth, UCI, Medicaid or payer IDs, rates or dollar amounts. Legal names only when the downloader holds `clients.names.read`.
- **Audit:** every download is recorded (who, when, which agency, data as of). The home screen shows **"Continuity pack last downloaded: <time> by <person>"**. A NEEDS ATTENTION item appears when the latest pack is more than 24 hours old.
- **Not used:** email delivery, or automatic push to a third-party drive. Either would move PHI into another service, which needs its own approval and BAA.

**What each agency must set up (cannot be done by Ogevia):**
1. Name the staff allowed to hold the pack (at least two people, so one absence does not leave the agency blind).
2. Keep it only on agency-controlled, encrypted storage: a device with full-disk encryption and a screen lock, or the agency's HIPAA-covered drive. Print only if printed copies are locked away and shredded when replaced.
3. Download a new pack at least daily (more often on heavy scheduling days) and delete superseded copies.
4. Keep blank outage visit forms (section 4) with field staff.
5. Confirm this in the agency's own HIPAA policies (Phase 7: operating policies NOT VERIFIED).

## 4. Temporary visit recording and reconciliation

**During the outage (paper or agency-held form):**
- One **outage visit record** per visit. Each carries a **pre-printed number** from the continuity pack's block: agency code, date, sequence.
- Fields:
  - record number, client code, caregiver name, service;
  - date, time in and time out as observed (the reason this is an exception: these are not server times);
  - client or representative confirmation method (signature on the form, verbal, unable to confirm, declined);
  - the caregiver's signature, and notes.
- The caregiver hands the form to the office the same day, or sends a photo through the agency's own approved channel.

**After recovery (to be built in Ogevia):**
- A manager enters each record through **"Record outage visit"**:
  - the record number is **unique per agency**: a second entry of the same number is refused, so a record cannot be counted twice;
  - Ogevia refuses or flags any overlap with an existing visit for the same caregiver or the same client and service. This catches a visit that was also recorded in Ogevia before the outage began;
  - the visit is stored with source "outage record", the reported times, the entering manager and the server entry time;
  - it counts against the authorization, and over-authorization is flagged;
  - the scanned form is attached as evidence;
  - it **never** becomes Billing Ready automatically. It goes to exception review and needs the usual human billing approval.
- A **reconciliation report** compares the numbers issued in the pack with the numbers entered, voided or still missing, so a lost form is visible.

## 5. Status

| Item | Works now | Needs implementation | Agency must set up |
| --- | --- | --- | --- |
| Database restore to a new instance | Yes: measured 4 min 15 s (database only) | Combined drill; measured data-loss window | — |
| S3 version recovery | Yes (controls verified) | Drill together with the database | — |
| Account recovery | Deletion protection only | User list export and re-link procedure; drill | Users re-enrol MFA after a pool loss |
| Application rebuild against a restored database | Pinned scripts exist | Written procedure plus a drill | — |
| Full-system recovery time | — | Combined drill (criteria C1/C2) | — |
| Continuity pack (0027) | **Built, verified locally; not deployed** (DB 7 tests, API, web 6, browser 23/23 at 390 px, including the file opened offline) | Deploy with the next release | Section 3, items 1–5 |
| Outage visit recording and reconciliation (0028) | **Built, verified locally; not deployed**: numbered records entered once; duplicates, unissued numbers and overlaps refused; administrator review with 0 billable; reconciliation lists MISSING numbers (DB 6 tests, db:verify passes with an outage visit, API, web, browser) | Deploy with the next release | Keep the forms in the field; hand them in daily |
| Cross-region protection | No | Owner decision (cost) | — |

**Local evidence (2026-10-05):**
- Database suite: 254/254. API: 48/48. Web: 601/601. Infra: 106/106. Lint and typecheck clean.
- Browser at 390 px: `infra/aws/slice/pilot-e2e/continuity-e2e.ts`, 23/23 PASS.

## 6. Order of work

1. ~~Continuity pack~~ (built: 0027).
2. ~~Outage visit recording and reconciliation~~ (built: 0028).
3. Combined recovery drill script (database + S3 + Cognito list + application), with measured times. Run by the owner in TEST.
4. Owner decision on cross-region protection.
