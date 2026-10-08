# Phase 7 fixes and read-only check, prepared for the production deploy

Status: **A1 and A2 EXECUTED on the test slice on 2026-10-08 (owner-run in CloudShell, results in section 8). Nothing has been deployed to production.** Prepared 2026-10-08. Every item that changes AWS is a YELLOW action (CLAUDE.md section 13): it runs only after the owner approves it, from an operator shell with AWS admin access. No AWS access was available when this was written, so every AWS value is from the repo or from the 2026-10-03 live run recorded in `PHASE7_SECURITY_REVIEW.md` (owner-reported).

## Approvals recorded (owner, 2026-10-08)

| # | Item | Decision |
|---|---|---|
| A1 | Run the read-only check (section 2, steps 1 to 4) | **Approved.** Who runs it: to be named by the owner. |
| A2 | Run `phase7-remediate.sh`, part APPLY (alarm email subscription, account-wide S3 public-access block, GuardDuty) | **Approved.** The alarm email address is typed by the operator when the script asks. |
| A3 | Restore test (script part DRILL) | **Not run now. REQUIRED before any real client data is stored in `ogevia_prd`** (owner, 2026-10-08). Run a production version, covering `ogevia_prd`, after the database exists; record the time to restore and the result. |
| D4 | App database secret rotation | **Rotate by hand** (draft procedure in section 7). **Owner: SoCal Care Services. First rotation due 30 days after production go-live** (then the 90-day cycle already decided). **Rehearse the procedure in the test environment before production** (owner, 2026-10-08). A named person still has to be assigned. |
| C6 | VPC flow logs | **Go-live approved without them. Flow logs are REQUIRED within 30 days after production go-live** (owner, 2026-10-08). Not prepared yet; it is a separate reviewed change to the shared network stack. |

**Gate: no real client data goes into `ogevia_prd` until a production restore test has passed and its record is saved.**

Still open: the HIPAA-eligible service list (owner step), the record-retention period, and approval of the production deploy and of the Cognito client change (see `GO_LIVE_RUNBOOK.md`).

Sources: `PHASE7_SECURITY_REVIEW.md` (sections 3, 5, 6), `infra/aws/slice/phase7-remediate.sh`, `infra/aws/slice/phase7_evidence.py`, `infra/aws/scripts/deploy-production.sh`, `PRODUCTION_DEPLOYMENT.md`.

## 1. Where it stands

The last live run (2026-10-03 21:03 UTC, test slice) gave `PASS 36, GAP 5, MANUAL 1, ERROR 0`. Gaps: C6 VPC flow logs, D2 account-wide S3 public access block, D4 app database secret rotation, G1 alarm topic has no subscriber, G3 GuardDuty. Manual: E3 restore drill.

That run covered the **test slice** (`Ogevia-prod-*`). The production stacks (`Ogevia-prd-*`) do not exist yet, so none of the production-specific controls have been checked.

## 2. Read-only check (changes nothing)

Run in this order and send back the output (never credentials).

| # | Command | What it proves |
|---|---|---|
| 1 | `aws sts get-caller-identity --region us-west-2` | The shell is the right account (300094796789). |
| 2 | `cd infra/aws && AWS_PROFILE=<admin> ./scripts/deploy-production.sh check` | Inputs and production config are valid; RDS is available, backups at least 7 days, encrypted, private, deletion-protected; Cognito multi-factor is ON; the repo's lint, typecheck, test and build pass; `cdk synth -c env=prd` succeeds. It takes several minutes and mutates nothing. |
| 3 | `aws rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --region us-west-2 --query 'DBInstances[0].[BackupRetentionPeriod,LatestRestorableTime,StorageEncrypted,PubliclyAccessible,DeletionProtection,MultiAZ]'` | The backup and protection settings today (the 2026-10-03 values may have changed). |
| 4 | In CloudShell: `OGEVIA_ENV=prod python3 phase7_evidence.py` | A fresh baseline of the account-wide and test-slice controls. Send the `SUMMARY` line and every line that is not PASS. |

After the production deploy, repeat step 4 with `OGEVIA_ENV=prd` (see section 5).

## 3. Fixes, by when they can run

All costs below are the estimates in `PHASE7_SECURITY_REVIEW.md` section 5 (INFERRED); check AWS pricing before approving anything recurring.

### Before the production deploy (account-wide, reversible)

| Gap | Action | How | Cost | Rollback |
|---|---|---|---|---|
| D2 | Account-wide S3 public access block | `infra/aws/slice/phase7-remediate.sh`, part **APPLY** (R8). It checks every bucket's policy status and ACL first and refuses if any is public or unreadable, saves the current account setting, writes a rollback script and rolls back by itself if verification fails. | $0 | The saved rollback script. |
| G3 | GuardDuty in us-west-2 | Same script, part **APPLY** (R9). | 30-day free trial, then usage-based | Disable the detector. |
| G1 (test topic) | Subscribe an inbox to the test slice's alarm topic | Same script, part **APPLY** (R1). Confirm the email. | $0 | Unsubscribe. |

The script asks for the word **APPLY** once for these three and separately for **DRILL**. Run `phase7-remediate.sh` only after reading its header; it targets the test slice by name.

### After the production deploy (production-specific)

| Gap | Action | How | Cost |
|---|---|---|---|
| G1 | Subscribe a person to the **production** alarm topic | Find it: `aws cloudformation describe-stack-resources --stack-name Ogevia-prd-Observability --region us-west-2 --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId"`. Then `aws sns subscribe --topic-arn <that ARN> --protocol email --notification-endpoint <owner inbox> --region us-west-2` and confirm the email. A subscription does not drift the CDK stack. | $0 |
| (all) | Re-run the evidence | `OGEVIA_ENV=prd python3 phase7_evidence.py` | $0 |
| E3 | **REQUIRED before real client data:** restore drill that includes `ogevia_prd` | The existing drill (`phase7-drill-finish.sh`) verifies only `ogevia_sv_test`. **Prepared for review, not run: `infra/aws/slice/prd-restore-test.sh`, explained in `PRD_RESTORE_TEST.md`.** | about $0.02 to 0.10 one-off |

### Decisions and recommended-only items

| Gap | Item | Recommendation |
|---|---|---|
| D4 | App database secret rotation | **Decided: manual, every 90 days; first rotation 30 days after go-live; rehearse on the test slice first** (section 7). Automate later; that needs a rotation Lambda that can reach RDS and Secrets Manager. |
| C6 | VPC flow logs | A CDK change delivering to S3 with a lifecycle rule, under $1 a month (INFERRED). Not blocking go-live; **REQUIRED within 30 days after go-live** (owner, 2026-10-08). **Not prepared yet** (section 4). |
| R12 | Record-retention period | A legal and business decision; it sets S3 lifecycle rules. Nothing is deleted until decided. |
| HIPAA list | Confirm the services in use are on AWS's current HIPAA Eligible Services Reference | Owner step; the page could not be fetched from the environment that prepared this. Services: RDS, S3, KMS, Lambda, API Gateway, Cognito, CloudFront, CloudWatch Logs, Secrets Manager, SNS, CloudTrail, VPC, EC2, Systems Manager. |

## 4. What was prepared, and what was not

**Prepared:** `infra/aws/slice/phase7_evidence.py` now takes `OGEVIA_ENV` (`prod` by default, or `prd`) to choose which stacks it checks. Production shares the pilot's network endpoints, so the egress stack stays `Ogevia-prod-NetworkEgress`. Any other value exits with an error. The mapping was checked for `prod`, `prd` and an invalid value, and the infrastructure tests still pass (124 of 124). The script itself was not run against AWS.

**Not prepared, and why:**
- **C6 flow logs.** It adds a stack for a VPC the pilot also uses, and the tests assert the exact stack set. Doing it safely is a separate change; it is recommended but does not block launch.
- **A production restore drill.** Prepared for review on 2026-10-08 as `infra/aws/slice/prd-restore-test.sh` (see `PRD_RESTORE_TEST.md`). Rehearsed only against a simulated AWS; it has not run against real AWS.
- **D4 rotation automation.** Waiting on the manual-rotation decision.

## 5. One fact that helps the pre-switch phone test

The production API stack accepts tokens from the web-hosting stack's own Cognito client as well as `ogevia-web` (`extraAppClientIds` in `infra/aws/lib/app.ts`), and allows that stack's CloudFront address as a web origin (`extraAllowedOrigins`). So the production `WebOrigin` address can serve as the non-production address for the real-phone test in `GO_LIVE_RUNBOOK.md` step 6, if the web-hosting stack is deployed.

## 6. Approvals needed

| Item | Approval needed from the owner |
|---|---|
| D2, G3, G1 on the test topic (script part APPLY) | Yes, before the production deploy |
| Production deploy | Yes (approval reference) |
| G1 on the production topic | Yes, after deploy |
| Restore drill (script part DRILL, and the production version). **Required before real client data.** | Yes |
| D4, C6, retention period | Decisions |

## 7. Manual rotation of the application database login (draft, not run)

Why it is a draft: no written rotation procedure exists in the repo, and this one has not been rehearsed. Rehearse it once on the test slice before using it on production. Production's login is `ogevia_prd_app` and its secret is `ogevia/prd/database/app` (`PRODUCTION_DEPLOYMENT.md` section 1); the login's password is set from the secret by `infra/aws/db/deploy/11_prd_app_login.sql`.

1. Put a recurring reminder in the owner's calendar for every 90 days.
2. Take a manual snapshot of the RDS instance first (the rollback anchor).
3. Save the current secret version label (`AWSCURRENT`) so it can be restored.
4. Generate a new password with `aws secretsmanager get-random-password` and write it into the secret as a new version, keeping every other key (`username`, `dbname`, `host`, `port`) unchanged. Never print the value or put it in a command history or log.
5. Set the database login's password to the new value by re-running `11_prd_app_login.sql` through the admin host, with the value read from the secret.
6. Make the API pick up the new value. The API reads the secret when it opens a database connection (`apps/sv-api/src/db.ts`); whether it caches it is **not confirmed**. Check this before the first rotation; if it caches, force new Lambda execution environments.
7. Run the smoke step (`deploy-production.sh smoke`): the API must connect to `ogevia_prd` as `ogevia_prd_app`.
8. If anything fails: restore the previous secret version and set the login's password back to it, then smoke again.


## 8. Results recorded 2026-10-08 (owner-run in AWS CloudShell; reported by the owner, not independently observed)

### 8.1 What was run

| Step | What | Result as reported |
|---|---|---|
| A1 | Read-only check | Run; led to the evidence-script fix in 8.3 |
| A2 | `phase7-remediate.sh`, APPLY | R1 alarm email subscribed and confirmed; R8 account-wide S3 public access block applied and read back (all four settings on), web origin still HTTP 200; R9 GuardDuty enabled in us-west-2. Rollback script saved for R8. |
| (not planned) | Restore drill typed `DRILL` at the prompt | The first script lost its CloudShell credentials while waiting. The restored copy `ogevia-restore-drill-202610080522` was then checked by hand with a read-only script, then deleted (only that instance, after a tag check). |

### 8.2 Restore drill: what it shows and what it does not

- The copy was created from `ogevia-prod-postgres` (request created 2026-10-08 05:26 UTC), `db.t4g.micro`, private, encrypted with the same KMS key as the source, single-AZ.
- Databases on the copy: `ogevia_sv_test`, `postgres`, `rdsadmin`. `ogevia_sv_test`: 36 migrations (0001-0036), 32 visits, 9 corrections. The copy's counts were not compared with the live database in this run.
- **`ogevia_prd` does not exist yet**, so no production restore test has been done.
- **Time to restore was not measured** (the script died before it timed the restore).
- Admin host security groups were verified restored to the original `sg-00e01e2ca80442c1f`.

### 8.3 Evidence script

- First run after A2: `PASS 35 GAP 2 MANUAL 1 ERROR 3`. C4, D4 and F3 errored (`list index out of range`); F4 reported 10 public routes against an approved 8.
- Cause: the script listed stack resources with `describe-stack-resources`, which appears to cap at 100; the API stack returned exactly 100 and the Lambda function was cut off (INFERRED; the API stack returned a count of exactly 100 and its Lambda function exists, `Ogevia-prod-ServiceVerificationApi-Handler886CB40B-...`). F4's approved count was stale: the 10 live public routes equal the 10 in `infra/aws/lib/public-routes.ts` (8 original + 2 visit-confirmation links approved 2026-10-05).
- Fix: commit `09af160` (`phase7_evidence.py` now uses `list-stack-resources` and compares public routes to the exact approved list). The file with SHA-256 `de6e058c40d2fa1f4366930847097f2f74363a80bb23c5a43e21340f6afe255f` was installed in CloudShell and verified by checksum.
- Final run: **`PASS 41 GAP 2 MANUAL 1 ERROR 0 INFO 8`.** GAP: C6, D4. MANUAL: E3.
- Not fixed: older test-deploy scripts (`increment-deploy.sh`, `increment-preflight.sh`, `pilot-deploy.sh`, `release-0026-deploy.sh`, `pilot-recover-scope.sh`, `smoke.py`) still use `describe-stack-resources` and may miss resources in stacks over 100 resources. `deploy-production.sh` already uses `list-stack-resources`.
- E3 in the script is a fixed MANUAL line (it does not read AWS) and its text "no restore has ever been tested" is out of date. It will stay MANUAL until the script is changed.

### 8.4 Budget and cost

Budget `ogevia phase 1 Budget`: limit 50.0 USD, actual this month 14.33 USD, 3 alerts with 3 subscribers. GuardDuty is in its 30-day free trial; check its cost estimate before day 30.

### 8.5 Owner decisions (2026-10-08)

| Item | Decision |
|---|---|
| C6 VPC flow logs | Go-live approved; flow logs REQUIRED within 30 days after production go-live. |
| D4 password rotation | Owner: SoCal Care Services. First rotation due 30 days after production go-live. Rehearse the procedure in the test environment before production. |
| E3 / A3 restore test | Unchanged: a successful `ogevia_prd` restore test is REQUIRED before any real client data is entered into production. |

### 8.6 What remains before go-live (nothing below has started)

1. Approval reference for `OGEVIA_DEPLOY_APPROVAL`, and written approval of the Cognito client change (`GO_LIVE_RUNBOOK.md` section 5).
2. Who runs the AWS steps (operator shell with AWS admin access, `session-manager-plugin`, `psql`), and the first administrator's own email address.
3. Run `deploy-production.sh check`; it has never been run (NO-GO items 6 to 17 in the runbook are NOT RUN).
4. Deploy production (database `ogevia_prd`, stacks `Ogevia-prd-*`), then the Cognito client change and the first administrator sign-in.
5. **Production restore test of `ogevia_prd` (step 4a): script prepared (`prd-restore-test.sh`); it needs your review and an approval reference, then runs after step 4 and before any real data.**
6. Rehearse the manual password rotation on the test slice (D4); name the person who will do it.
7. Owner steps still open: confirm the HIPAA-eligible service list; record-retention period; security headers for the AWS build on Netlify; decision on the `Ogevia-prd-WebHosting` stack; confirm that Netlify keeps serving `app.ogevia.com`.
8. After go-live: flow logs within 30 days (C6); first password rotation within 30 days (D4); alarm subscription on the production alarm topic (G1, after deploy); GuardDuty cost check before day 30.
