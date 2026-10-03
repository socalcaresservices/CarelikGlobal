# AWS TEST deployment plan: SCS pilot build

**Status:** PROPOSED. Not approved and not executed. Every step is YELLOW under CLAUDE.md §13.
**Code:** branch `claude/ogevia-socal-pilot-prep-vfu5tf` at `e8b351e`. The plan doc and harness commit after it carries no deployable change.
**Environment:** AWS TEST only. Account `300094796789`, `us-west-2`, database `ogevia_sv_test`. **Synthetic data only.**
**Not touched:**
- Netlify, Supabase, DNS and `main`; no merge.
- The `ogevia-web` Cognito app client.
- RDS security-group rules and the other RDS instance (`ogevia-postgres`).
- Any production user or real client.

**Who runs it:** you, in AWS CloudShell or with your admin profile. This agent's AWS credentials are rejected (`InvalidClientTokenId`), so it cannot run or observe any step. Paste each step's output back and it will review it before you continue.

## 1. Target resources and changes

| Resource | Current (per the deployment log) | Change | Fixed cost |
| --- | --- | --- | --- |
| RDS `ogevia-prod-postgres`, database `ogevia_sv_test` only | Migrations 0001–0011 | Apply **0012–0017**. Each runs in its own transaction under an advisory lock. Only 0015 changes a table: it adds 2 nullable columns to `service_visits`. The rest are functions. | None |
| RDS manual snapshot `ogevia-prod-postgres-pre-pilot-20261004` | — | **New** (backup before migrating) | Snapshot storage, per GB-month (delete after acceptance) |
| Admin host `ogevia-db-admin-temp` | Running state not verified | Temporarily attach AppSG `sg-064ffce3bcbe8eb3b`, then remove it. This is the same trap-restored pattern as DB window §8.1. | Instance hours while it runs |
| Lambda (stack `Ogevia-prod-ServiceVerificationApi`) | Code from `998e871` | New code from `e8b351e` | None |
| API Gateway (same stack) | 36 routes (29 JWT, 7 public) | **+2 routes:** `POST /v1/visits/{visitId}/close` (JWT) and `GET /v1/public/care-portals/{token}/requests` (**public, token-secured**; makes 8 public). Plus 2 route-scoped `lambda:InvokeFunction` permissions. | None |
| S3 site bucket + CloudFront (stack `WebHosting`) | Web from `d775647` | Upload the new web build; invalidate `/index.html` and `/` | None |
| Cognito pool `us-west-2_849AYz5J7` | 2 test users | **+3 individual users** (pilot manager, caregiver A, caregiver B). Invitation email, then password change and TOTP at first sign-in. | Per-MAU pricing not verified here; check the Cognito pricing page |
| Stacks `EvidenceStorage`, `NetworkEgress`, `Observability` | — | **Expected: no change.** If `cdk diff` shows any, STOP. | — |

## 2. Pre-checks (stop on any failure)

1. Run `./scripts/deploy-test-slice.sh preflight`. It checks the account and region, the full lint/type/test/build gate, and the plan-mode synth.
2. Run `cdk diff`, read-only. The **only** acceptable differences are:
   - `ServiceVerificationApi`: 2 routes, 2 permissions, Lambda code.
   - `WebHosting`: none.
   - Anything else (IAM widening, SG rules, any replacement or deletion): STOP and send the output.
3. RDS: confirm status `available`, `PubliclyAccessible=false`, `StorageEncrypted=true`, and `BackupRetentionPeriod>=7`.
   ```bash
   aws rds describe-db-instances --db-instance-identifier ogevia-prod-postgres \
     --query 'DBInstances[0].[DBInstanceStatus,PubliclyAccessible,StorageEncrypted,BackupRetentionPeriod,LatestRestorableTime]'
   ```
4. Confirm the schema ledger is at 0011 before migrating. In the DB window, the read-only `db:verify` should report `latest=0011`.
5. Confirm nobody is testing in TEST during the window.

## 3. Backup

```bash
aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres \
  --db-snapshot-identifier ogevia-prod-postgres-pre-pilot-20261004
aws rds wait db-snapshot-available --db-snapshot-identifier ogevia-prod-postgres-pre-pilot-20261004
```

- Point-in-time recovery (7-day automated backups) remains a second layer.
- The snapshot is of the whole instance. Restoring creates a **new** instance; it never overwrites the existing one.

## 4. Execution order (each step re-runnable)

Run from `infra/aws` with `OGEVIA_DEPLOY_APPROVAL=<your new approval reference>`.

| # | Step | Command | Expected | Stop if |
| --- | --- | --- | --- | --- |
| 1 | DB window: attach AppSG | §8.1 trap-restored script | Admin host has `sg-00e01e2ca80442c1f` + AppSG | Attach fails |
| 2 | Migrate | `./scripts/deploy-test-slice.sh database` | `applied 6, already applied 11`; verify 0 FAIL, `latest=0017`, count 17 | Any migration error. That migration rolls back; the earlier ones stay applied. |
| 3 | Pilot users | `pilot-users` (3 emails you control) | 3 usernames printed | — |
| 4 | Pilot seed | `pilot-seed` (names via env vars) | `3 \| 2 \| 4 \| 4` | Any error |
| 5 | DB window: detach AppSG | trap-restore | Admin host = `sg-00e01e2ca80442c1f` only; RDS SG unchanged | AppSG still attached |
| 6 | API + Lambda | `./scripts/deploy-test-slice.sh infra` | `ServiceVerificationApi UPDATE_COMPLETE`; other stacks "no changes". Answer **y** only for the reviewed broadening. | Any unexpected change |
| 7 | Web | `./scripts/deploy-test-slice.sh web` | Upload plus invalidation | — |
| 8 | Smoke | `./scripts/deploy-test-slice.sh smoke` then `slice/smoke.py` | Anonymous API calls get 401; 8 public routes; workflow checks PASS | Any FAIL |

**Order rationale:** database first. The new migrations only add columns and functions, and change the return columns of two report functions. The deployed Lambda selects `*` and maps by name, so it keeps working against the new schema until step 6 replaces it.

## 5. Expected interruption

- **Production:** none. No production resource is in scope.
- **TEST API:**
  - Each migration holds locks only for its own transaction (milliseconds to seconds).
  - The Lambda swap is atomic. The first calls after it are cold starts of about 1–3 s.
  - CloudFront serves the old `index.html` until the invalidation completes (minutes).
- **Window:** 45–60 min, including pre-checks and the snapshot. Testers should stay out of TEST during it.

## 6. Rollback (per layer, newest first)

| Layer | Rollback | Data effect |
| --- | --- | --- |
| Web | Re-upload the `d775647` bundle's `web/` (`ogevia-slice-d7756477626e.tgz`, S3 bootstrap bucket), then invalidate | None |
| Lambda + routes | Re-run `finish.sh` from the `d775647` bundle; this removes the 2 routes | None |
| Cognito users | `aws cognito-idp admin-disable-user` for each of the 3 users; delete only on request | None |
| DB functions | Run the down files in reverse: 0017, 0016, 0014, 0013, 0012 (**SAFE AUTOMATED**) | None |
| DB 0015 | Down file is **BACKUP REQUIRED**: it drops `time_out_entered_by` / `time_out_reason` | Loses who closed a missed clock-out and why. Synthetic only, and the snapshot holds them. |
| Whole DB | Restore `ogevia-prod-postgres-pre-pilot-20261004` to a **new** instance and repoint | Loses everything after the snapshot (synthetic) |

The pilot seed is a separate organization (`scs-pilot-synthetic`) and can be left in place. Removing it is a RED data deletion and needs its own instruction.

## 7. Post-deployment acceptance on a real phone

These can only be run by a person, because of the Cognito password + TOTP. Record PASS/FAIL with a screenshot for each.

| # | Check | Pass when |
| --- | --- | --- |
| P1 | Caregiver A signs in on their own phone: invitation → new password → TOTP enrolment → app | Lands on "Today's visits" |
| P2 | Manager (desktop or phone) creates a Care Request for P-QAUF7 (RSP) starting within 60 min and assigns caregiver A | Assignment succeeds |
| P3 | Caregiver A's phone shows P-QAUF7 under Scheduled today, with the AM/PM window, service and date | As stated |
| P4 | Start visit → refresh the phone browser → still in progress; End visit → client signs on the phone screen → Submitted | Billing ready, "does not mean billed" |
| P5 | Manager schedules P-AHXN7 with **PCS** for caregiver B; B's phone shows P-AHXN7 with **PCS preselected**; switching to RSP shows the warning; start on PCS | Visit record shows PCS, linked to the shift |
| P6 | Manager corrects A's visit Time Out by +15 min (Pacific AM/PM) | Summary is right; the record shows Original vs Corrected; History has the reason |
| P7 | Caregiver B starts a visit and does not end it; once it is past the shift end, the manager uses Close visit with Time Out | Wrong AM/PM is refused; correct entry is saved; B's phone asks for confirmation "entered by your agency" |
| P8 | Authorized-hour limit: schedule beyond P-AAXRX's 3 h/month | Assignment refused with the authorized-time message |
| P9 | Over-limit visit on P-AAXRX | Worked time kept, billable capped, Needs manager review |
| P10 | Unconfirmed visit (Unable to obtain confirmation) | Manager review, 0 billable |
| P11 | Test-slice accounts see no `P-` clients; pilot accounts see no `TEST-` clients | As stated |
| P12 | Sign out, then sign in again on the phone | TOTP is required again |

## 8. Not in this plan

- Real client data. It requires a separately confirmed AWS BAA and the Phase 7 security sign-off.
- Merging any PR.
- Production Netlify or Supabase.
- Lambda concurrency increase.
- Multi-AZ.
