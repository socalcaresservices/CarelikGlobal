# Production readiness plan (Ogevia-prd-*)

Written 2026-10-19 after TEST acceptance of code commit e80b770. **Planning only. No production change, no deployment, no AWS access from the authoring container (no AWS CLI, no credentials).**
Evidence classes: REPO (read from this repository), OWNER-AWS (pasted by the owner from CloudShell on the date shown), UNKNOWN (not established). Nothing below is a live read of production.

## 1. What the repository says production is
| Item | Value | Class |
|---|---|---|
| CDK context | `-c env=prd`; stacks `Ogevia-prd-DatabaseSecret`, `-EvidenceStorage`, `-WebHosting`, `-ServiceVerificationApi`, `-Observability` | REPO (`PRODUCTION_DEPLOYMENT.md`, `config.ts`) |
| Database | `ogevia_prd` on the SAME RDS instance as TEST (`ogevia-prod-postgres`), login `ogevia_prd_app`, secret `ogevia/prd/database/app` | REPO |
| Shared with TEST | RDS instance, VPC, Cognito user pool and `ogevia-web` client, and `Ogevia-prod-NetworkEgress` (its endpoint policies admit the prd secret, bucket and identity function) | REPO |
| Production candidate URLs | app `https://d3l4psdkokkvnb.cloudfront.net`, API `https://zk527zk4ua.execute-api.us-west-2.amazonaws.com`; `app.ogevia.com` is not repointed | OWNER-AWS 2026-10-10 |
| Deployed on 2026-10-10 | Lambda `Ogevia-prd-ServiceVerificationApi-Handler886CB40B-KQ2l1HsdGkhR`, `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd`, LastModified 2026-10-10T06:11:29Z; `Ogevia-prd-WebHosting` and `-ServiceVerificationApi` UPDATE_COMPLETE | OWNER-AWS 2026-10-10 |
| Production version | **UNKNOWN.** The runbook was written for `7ddda43` (migrations 0001-0038). The deployed commit has not been recorded (`URL_REGISTRY_AND_LAUNCH_CHECKLIST.md` item 7 OPEN). It is 9 days and many releases behind e80b770. | REPO |
| Production migration status | **UNKNOWN.** Expected 38 / 0038 if the `7ddda43` release was applied; the ledger was never read. TEST is now 85 / 0085. | REPO |
| BAA | Owner-confirmed 2026-10-10 (agreement not in the repository, not reviewed). I earlier said the BAA gate was unmet; the repo records it as owner-confirmed. Other gates (MFA, tenant isolation on prd, backup restore) are unverified on prd. | OWNER-STATED |

**Trap avoided:** the Step 16 line "databases present (of the two Ogevia names): ogevia_sv_test" tells nothing about `ogevia_prd`. The TEST copy of `ledger-recheck.sh` only queries `pg_database` for `ogevia_sv_test`. Do not read it as "ogevia_prd does not exist".

## 2. Rollback options (as designed; none exercised)
| Option | What it covers | Limit |
|---|---|---|
| Manual RDS snapshot `ogevia-prod-postgres-pre-prd-<date>` (made by `deploy-production.sh snapshot`) | Whole instance, restorable to a NEW instance only | The instance is SHARED with TEST: a restore rewinds TEST as well, and any production data written since the snapshot is lost unless exported first |
| Snapshot `ogevia-prod-postgres-pre-0085-202610192111` (verified 2026-10-19, encrypted) | State after TEST's 0085 migration | Taken for the TEST rollout; says nothing about `ogevia_prd` content beyond that time |
| Lambda previous code asset | API code | Code only; migrations 0078-0085 are functions-only but a forward ledger cannot be rolled back by code |
| Web: previous `index.html` and assets (never deleted) | Frontend | A production capture comparable to TEST's Step 5 baseline does not exist yet |
| Fix-forward migration | Failed migration | Applied files are checksummed; rollback `.down.sql` files exist for 0085 only as tested on TEST |
| Stack rollback | `Ogevia-prd-*` stacks have termination protection; database, secret and buckets are retained | Deleting any is a RED action |

## 3. Blockers and gaps (ordered)
| # | Blocker | Status |
|---|---|---|
| B1 | Production state unknown: version, migration ledger, whether `ogevia_prd` exists, whether the Lambda can connect (launch checklist items 4-8 OPEN since 2026-10-10) | Needs the live inventory in section 4 |
| B2 | Version gap: production code and schema are many releases behind e80b770 (up to 47 migrations if at 0038). No rehearsal of a PATH A style sequence exists for `ogevia_prd`. | Needs plan after B1 |
| B3 | Shared RDS instance: a migration or restore on `ogevia_prd` shares fate with TEST; one snapshot covers both. Rollback granularity is the instance. | Owner decision: accept, or separate instance |
| B4 | Shared Cognito pool and client with TEST; production authorizes only by database membership. Separate pool/client is an unresolved owner decision (`PRODUCTION_DEPLOYMENT.md` s.8). | Owner decision |
| B5 | Security gates unverified on prd: administrator MFA sign-in, tenant isolation, caregiver restriction, signature stored in the prd bucket, cross-tenant negatives, backup restore test, Multi-AZ (single-AZ today) | Open |
| B6 | Procedure defects (web-verify newline, Step 15 log group) and BUILD_INFO `approval_ref` mismatch; the TEST package scripts also refuse production (`ledger-recheck.sh` is TEST-only) | Fix before reuse |
| B7 | Not tested: Large-text/Compact matrix on new layouts, keyboard and screen reader, real phone | Open |
| B8 | `docs/TESTING_AND_RELEASE_PROCESS.md`: release checklist, pilot validation on a production-like path, owner GO | Not started |
| B9 | `app.ogevia.com` DNS decision; reports page density | Owner decisions, not blockers to a first controlled release |

## 4. Read-only live inventory (run in CloudShell; changes nothing; prints no secret values)
Part A needs only AWS read APIs and public GETs. Part B (database ledger) needs a temporary database-access rule and is a separate YELLOW approval; it is NOT included here.
```
export AWS_PAGER="" R=us-west-2
echo "== identity"; aws sts get-caller-identity --region $R
echo "== prd stacks (status, termination protection, last update)"
aws cloudformation describe-stacks --region $R --query "Stacks[?starts_with(StackName,'Ogevia-prd-')].[StackName,StackStatus,EnableTerminationProtection,LastUpdatedTime||CreationTime]" --output table
echo "== prd stack outputs (names only matter: URLs/ids, no secrets)"
aws cloudformation describe-stacks --region $R --query "Stacks[?starts_with(StackName,'Ogevia-prd-')].[StackName,Outputs[].[OutputKey,OutputValue]]" --output json
echo "== prd stack resources"
for s in $(aws cloudformation describe-stacks --region $R --query "Stacks[?starts_with(StackName,'Ogevia-prd-')].StackName" --output text); do echo "-- $s"; aws cloudformation list-stack-resources --stack-name "$s" --region $R --query "StackResourceSummaries[].[ResourceType,LogicalResourceId,ResourceStatus]" --output text; done
echo "== prd Lambda (names of env vars; values only for DB_NAME and OGEVIA_ENV)"
for f in $(aws lambda list-functions --region $R --query "Functions[?starts_with(FunctionName,'Ogevia-prd-')].FunctionName" --output text); do echo "-- $f"; aws lambda get-function-configuration --function-name "$f" --region $R --query "{State:State,Update:LastUpdateStatus,Modified:LastModified,CodeSha256:CodeSha256,Runtime:Runtime,LogGroup:LoggingConfig.LogGroup,EnvKeys:keys(Environment.Variables),DB_NAME:Environment.Variables.DB_NAME,OGEVIA_ENV:Environment.Variables.OGEVIA_ENV}" --output json; done
echo "== prd web: which API and version does the served bundle carry"
APP=$(aws cloudformation describe-stacks --stack-name Ogevia-prd-WebHosting --region $R --query "Stacks[0].Outputs[?OutputKey=='WebOrigin'].OutputValue" --output text); echo "app: $APP"
A=$(curl -fsS "$APP/index.html" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1); echo "main: $A"
J=$(curl -fsS "$APP/$A"); echo "$J" | grep -o 'VITE_APP_VERSION:"[^"]*"\|VITE_APP_ENV:"[^"]*"' | head -3; echo "$J" | grep -o 'execute-api[.a-z0-9-]*' | sort -u
echo "== RDS"
aws rds describe-db-instances --region $R --db-instance-identifier ogevia-prod-postgres --query "DBInstances[0].{Status:DBInstanceStatus,Class:DBInstanceClass,Engine:EngineVersion,MultiAZ:MultiAZ,Encrypted:StorageEncrypted,Public:PubliclyAccessible,Backup:BackupRetentionPeriod,DeletionProtection:DeletionProtection,LatestRestorable:LatestRestorableTime}" --output table
echo "== snapshots (rollback anchors)"
aws rds describe-db-snapshots --region $R --db-instance-identifier ogevia-prod-postgres --query "reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[0:12].[DBSnapshotIdentifier,SnapshotType,Status,Encrypted,SnapshotCreateTime]" --output table
echo "== prd secret metadata only (no value)"
aws secretsmanager describe-secret --region $R --secret-id ogevia/prd/database/app --query "{Name:Name,LastChanged:LastChangedDate,Rotation:RotationEnabled,Deleted:DeletedDate}" --output table
echo "== prd buckets (name, versioning, encryption, public-access block)"
for b in $(aws s3api list-buckets --query "Buckets[?starts_with(Name,'ogevia-prd')].Name" --output text); do echo "-- $b"; aws s3api get-bucket-versioning --bucket $b --query Status --output text; aws s3api get-bucket-encryption --bucket $b --query "ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm" --output text; aws s3api get-public-access-block --bucket $b --query PublicAccessBlockConfiguration --output text; done
echo "== Cognito pools (MFA setting)"
for p in $(aws cognito-idp list-user-pools --max-results 20 --region $R --query "UserPools[].Id" --output text); do aws cognito-idp describe-user-pool --user-pool-id $p --region $R --query "UserPool.[Id,Name,MfaConfiguration]" --output text; done
echo "== CloudTrail and budgets"
aws cloudtrail describe-trails --region $R --query "trailList[].[Name,IsMultiRegionTrail,LogFileValidationEnabled]" --output table
aws budgets describe-budgets --account-id $(aws sts get-caller-identity --query Account --output text) --query "Budgets[].BudgetName" --output text
```
Stop and report if any command errors; do not run Part B or anything else without a separate approval.

## 5. Plan (phases; each ends at an owner gate; nothing runs without GO)
| Phase | Work | Output | Gate |
|---|---|---|---|
| P0 | Run section 4; record results in this file; map version via CodeSha256 and bundle version | Verified production inventory; B1 closed or narrowed | Owner reviews |
| P1 | YELLOW approval for a read-only ledger and `pg_database` read on `ogevia_prd` (temporary /32 rule like TEST Step 6/16, production copy of the script, not the TEST-only one) | Ledger count and latest for prd | Owner approves the window |
| P2 | Close B6/B7 (script fixes with a trailing-newline test, `approval_ref`, appearance and accessibility tests) | Fixed package, test evidence | Owner reviews |
| P3 | Decide B3 and B4 (shared instance/pool vs separate), with cost per `CLAUDE.md` s.11 | Written decision | Owner decides |
| P4 | Production release package: re-pinned to the chosen commit, PATH selected from the P1 ledger, gates modeled on the TEST package, plus a production baseline capture and a restore test of the snapshot into a NEW instance | Package + rehearsal on a copy | Release checklist complete |
| P5 | Controlled production deploy per `TESTING_AND_RELEASE_PROCESS.md` Phase E: snapshot, migrations, API, web, smoke, owner acceptance with synthetic then first real tenant | Deployed record | Explicit owner GO |

## 6. Recommendation
Start P0 now (read-only). Do not schedule a production deployment until P0 and P1 are in and B2-B5 have owner decisions. The most likely finding is that production is several releases behind with a ledger below 0085, which makes this a multi-migration upgrade, not a repeat of the TEST PATH B.
