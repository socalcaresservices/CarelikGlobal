# Phase 7 fixes and read-only check, prepared for the production deploy

Status: **PREPARED, NOTHING EXECUTED.** Prepared 2026-10-08. Every item that changes AWS is a YELLOW action (CLAUDE.md section 13): it runs only after the owner approves it, from an operator shell with AWS admin access. No AWS access was available when this was written, so every AWS value is from the repo or from the 2026-10-03 live run recorded in `PHASE7_SECURITY_REVIEW.md` (owner-reported).

## Approvals recorded (owner, 2026-10-08)

| # | Item | Decision |
|---|---|---|
| A1 | Run the read-only check (section 2, steps 1 to 4) | **Approved.** Who runs it: to be named by the owner. |
| A2 | Run `phase7-remediate.sh`, part APPLY (alarm email subscription, account-wide S3 public-access block, GuardDuty) | **Approved.** The alarm email address is typed by the operator when the script asks. |
| A3 | Restore test (script part DRILL) | **Not approved now.** Run a production version after `ogevia_prd` exists. |
| D4 | App database secret rotation | **Rotate by hand** every 90 days (draft procedure in section 7; rehearse on the test slice first). |

Still open: the HIPAA-eligible service list (owner step), VPC flow logs, the record-retention period, and approval of the production deploy and of the Cognito client change (see `GO_LIVE_RUNBOOK.md`).

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
| E3 | Restore drill that includes `ogevia_prd` | The existing drill (`phase7-drill-finish.sh`) verifies only `ogevia_sv_test`. Extend it to also verify `ogevia_prd` before running it. **Not prepared yet** (section 4). | about $0.02 to 0.10 one-off |

### Decisions and recommended-only items

| Gap | Item | Recommendation |
|---|---|---|
| D4 | App database secret rotation | **Decided: manual, every 90 days** (section 7). Automate later; that needs a rotation Lambda that can reach RDS and Secrets Manager. |
| C6 | VPC flow logs | A CDK change delivering to S3 with a lifecycle rule, under $1 a month (INFERRED). Recommended, not blocking. **Not prepared yet** (section 4). |
| R12 | Record-retention period | A legal and business decision; it sets S3 lifecycle rules. Nothing is deleted until decided. |
| HIPAA list | Confirm the services in use are on AWS's current HIPAA Eligible Services Reference | Owner step; the page could not be fetched from the environment that prepared this. Services: RDS, S3, KMS, Lambda, API Gateway, Cognito, CloudFront, CloudWatch Logs, Secrets Manager, SNS, CloudTrail, VPC, EC2, Systems Manager. |

## 4. What was prepared, and what was not

**Prepared:** `infra/aws/slice/phase7_evidence.py` now takes `OGEVIA_ENV` (`prod` by default, or `prd`) to choose which stacks it checks. Production shares the pilot's network endpoints, so the egress stack stays `Ogevia-prod-NetworkEgress`. Any other value exits with an error. The mapping was checked for `prod`, `prd` and an invalid value, and the infrastructure tests still pass (124 of 124). The script itself was not run against AWS.

**Not prepared, and why:**
- **C6 flow logs.** It adds a stack for a VPC the pilot also uses, and the tests assert the exact stack set. Doing it safely is a separate change; it is recommended but does not block launch.
- **A production restore drill.** The drill script is written for `ogevia_sv_test`; it should be extended once `ogevia_prd` exists so it can be tested against real data shape.
- **D4 rotation automation.** Waiting on the manual-rotation decision.

## 5. One fact that helps the pre-switch phone test

The production API stack accepts tokens from the web-hosting stack's own Cognito client as well as `ogevia-web` (`extraAppClientIds` in `infra/aws/lib/app.ts`), and allows that stack's CloudFront address as a web origin (`extraAllowedOrigins`). So the production `WebOrigin` address can serve as the non-production address for the real-phone test in `GO_LIVE_RUNBOOK.md` step 6, if the web-hosting stack is deployed.

## 6. Approvals needed

| Item | Approval needed from the owner |
|---|---|
| D2, G3, G1 on the test topic (script part APPLY) | Yes, before the production deploy |
| Production deploy | Yes (approval reference) |
| G1 on the production topic | Yes, after deploy |
| Restore drill (script part DRILL, and the production version) | Yes |
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

