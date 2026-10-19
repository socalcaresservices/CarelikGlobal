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
| Production version | **Code build not mapped to a commit.** Lambda `CodeSha256 ffiawXVEQlhnBniTJouSjqgvvux5QrjsNSSyDIIuEpc=` last modified 2026-10-10T06:11:29Z (OWNER-AWS summary 2026-10-19, section 7). It equals neither TEST's pre-e80b770 hash (`oOxpTnBs...`) nor the e80b770 hash (`eVI1Zdrl...`), so production has not received any release since 2026-10-10. The commit it was built from remains UNKNOWN. | OWNER-AWS (summary) |
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

## 7. Inventory results, Part 1 (OWNER-REPORTED SUMMARY, 2026-10-19)
The owner pasted a summary, not the raw CloudShell output (the saved file `~/prd-inventory-part1.txt` was not attached). Values below are as reported and are NOT independently verified by the engineer. Part 2 (outputs, resources, served web bundle, secret metadata, buckets, Cognito MFA, CloudTrail, budgets) has NOT been run or pasted.

| Item | Reported value | Meaning |
|---|---|---|
| Account / role | 300094796789, `AWSReservedSSO_AdministratorAccess.../ogevia-admin` | Correct account |
| Stacks | Observability, ServiceVerificationApi, WebHosting, EvidenceStorage, DatabaseSecret: all `UPDATE_COMPLETE`, all with termination protection | All five prd stacks exist and are healthy; stack update times not reported |
| Handler Lambda | `Ogevia-prd-ServiceVerificationApi-Handler886CB40B-KQ2l1HsdGkhR`, nodejs24.x, `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd`, LastModified 2026-10-10T06:11:29Z, CodeSha256 `ffiawXVEQlhnBniTJouSjqgvvux5QrjsNSSyDIIuEpc=` | Production code is unchanged for 9 days while TEST received many releases; it is older than every TEST package |
| Identity Lambda | CodeSha256 `aA/+A8uXtCZ1E4zwJm/XUiBENc3CPSKEzFu9m7mY4xA=` | TEST's IdentityHandler hash is `7c5f8eb676c9...` (asset prefix, not comparable directly); mapping not done |
| RDS `ogevia-prod-postgres` | available, PostgreSQL 18.3, db.t4g.micro, MultiAZ false, not public, encrypted, deletion protection on, backup retention 7 days | Shared with TEST; single-AZ confirmed; latest restorable time not reported |
| Manual snapshots | `...pre-0085-202610192111`, `...pre-0085-202610190330`, `...pre-0077-202610180858`, `...pre-0052-20261015` | **No `...pre-prd-<date>` snapshot is listed**, so the rollback anchor that `deploy-production.sh snapshot` would create for the production deployment is not recorded as existing (the report lists four snapshots; whether automated snapshots were omitted is not stated) |

### Effect on the blockers
- **B1 (state unknown): narrowed, not closed.** Confirmed (reported): stacks healthy and protected; Lambda wired to `ogevia_prd`/`prd`; code not updated since 2026-10-10. Still UNKNOWN: the commit, the `ogevia_prd` migration ledger, whether the database exists and the Lambda connects, what the production frontend serves and calls.
- **B2 (version gap): strengthened.** Production has not moved since 2026-10-10; TEST has been migrated through 0085 and redeployed several times since. The production upgrade is therefore a multi-release catch-up, not a repeat of TEST PATH B.
- **B3 (shared instance): confirmed.** One RDS instance, single-AZ, db.t4g.micro; rollback granularity is the instance and it is shared with TEST.
- **New B10: no `pre-prd` snapshot recorded.** Before any production change a fresh named, verified manual snapshot is required; existing snapshots are TEST-rollout anchors.
- B4-B9: unchanged. Cognito MFA setting, bucket protections, CloudTrail and budgets stay UNKNOWN until Part 2.

### Next
Run Part 2 and attach both saved files (`~/prd-inventory-part1.txt`, `~/prd-inventory-part2.txt`) or paste raw output, so this section can be replaced with verified values. Then P1 (a separate, owner-approved read of the `ogevia_prd` ledger).

## 8. Inventory results, Part 2 (OWNER-REPORTED SUMMARY, 2026-10-19)
Again a summary, not raw output; `~/prd-inventory-part2.txt` was not attached. NOT independently verified.

| Item | Reported | Not reported (still UNKNOWN) |
|---|---|---|
| Production web | `https://d3l4psdkokkvnb.cloudfront.net`, `VITE_APP_ENV="production"` | **`VITE_APP_VERSION`; the `execute-api` host the bundle calls** (the two lines that decide "which commit" and "which API") |
| Lambda | `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd` | |
| Stacks | all `UPDATE_COMPLETE`, termination protection on | stack outputs and resources |
| RDS | available, encrypted, deletion protection, not public | |
| Cognito | MFA `ON` (pool setting) | which pool/client the production app uses; whether prd shares the TEST pool |
| CloudTrail | `ogevia-audit-trail`, multi-region true, log validation true | |
| Budgets | `ogevia phase 1 Budget` | its limit and alert recipients |
| Secret `ogevia/prd/database/app` metadata | | not reported |
| Buckets `ogevia-prd-*` (versioning, encryption, public-access block) | | not reported |

### Answers
1. **Behind TEST.** Code: production Lambda unchanged since 2026-10-10; TEST has since received migrations through 0085 and several handler builds (f6dd9b7, e80b770). Exact distance NOT VERIFIED: the commit and the `ogevia_prd` ledger are unknown. If prd is at the runbook's 38 / 0038 it is 47 migrations behind; if at 46 / 0046, 39 behind. The web build version is not reported.
2. **Web to production API.** NOT DETERMINED. The bundle's API host was not reported. Pass condition: it contains `zk527zk4ua`; fail: `s0epy5rgzb` (the TEST API).
3. **Blockers**
   - B1 state unknown: narrowed. Still open: commit, ledger, DB existence/connectivity, web version and API host, bucket and secret protections.
   - B2 version gap: open (confirmed direction, size unknown).
   - B3 shared RDS instance: open (confirmed shared, single-AZ).
   - B4 shared Cognito pool/client: open (pool unreported).
   - B5 security gates: partly narrowed. Pool MFA `ON`, CloudTrail multi-region with validation, budget exists (all reported). Still open: administrator MFA sign-in test, tenant isolation and caregiver restriction on prd, signature in prd bucket, restore test, Multi-AZ, bucket protections, budget limit and alerts.
   - B6 script/approval_ref defects, B7 untested accessibility and phone items, B8 release checklist and owner GO, B9 DNS and reports density: open.
   - B10 no recorded `pre-prd` snapshot: open.
4. **Readiness status: NOT READY. NO-GO.** Infrastructure exists and is protected, but production's version, schema, frontend wiring and security gates are unverified and it is far behind the accepted TEST release.

## 9. Inventory results, raw lines pasted by the owner (2026-10-19)
| Item | Pasted value | Status |
|---|---|---|
| Web origin / main script | `https://d3l4psdkokkvnb.cloudfront.net`, `assets/index-DewFCiEF.js` | OWNER-AWS |
| `VITE_APP_ENV` | `"production"` | OWNER-AWS |
| `VITE_APP_VERSION` | **No line was returned** by the grep (only `VITE_APP_ENV` printed). INFERRED: the production bundle carries no version string (older build); NOT VERIFIED (the owner did not state it was absent). The production web build cannot be mapped to a commit from the bundle. | INFERRED |
| API host in the bundle | The grep returned only `execute-api.us-west-2.amazonaws.com`. **The inventory command was defective:** its pattern starts at `execute-api` and drops the API id that precedes it. The pasted `https://zk527zk4ua...` is the stack output, not a bundle read. **The question "does the production web call the production API" is therefore still NOT VERIFIED.** | NOT VERIFIED |
| Secret `ogevia/prd/database/app` | LastChanged 2026-10-10T06:00:17Z, rotation none, not deleted | OWNER-AWS (known follow-up: no rotation) |
| Buckets (4) | access-log, signature-evidence, web-log, website: versioning Enabled, public-access block all four True; encryption AES256 except signature-evidence `aws:kms` | OWNER-AWS (closes the bucket part of B5) |
| Cognito | one pool listed: `us-west-2_849AYz5J7`, MFA `ON` | OWNER-AWS. A single pool in the account means production and TEST share it (INFERRED; confirm from configuration) |
| CloudTrail | `ogevia-audit-trail`, multi-region true, validation true | OWNER-AWS |
| Budget | `ogevia phase 1 Budget` (limit and alert recipients not reported) | OWNER-AWS |

### Corrected read-only check for the API host (run in CloudShell)
```
APP=https://d3l4psdkokkvnb.cloudfront.net
curl -fsS "$APP/assets/index-DewFCiEF.js" | grep -o '[a-z0-9]*\.execute-api\.[a-z0-9.-]*' | sort -u
curl -fsS "$APP/assets/index-DewFCiEF.js" | grep -c 'VITE_APP_VERSION'
curl -sS -o /dev/null -w 'config.json HTTP %{http_code}\n' "$APP/config.json"
```
Pass: the first command prints `zk527zk4ua.execute-api.us-west-2.amazonaws.com` and not `s0epy5rgzb...`.

### Blocker changes
- B5: bucket protections VERIFIED (owner-pasted), pool MFA ON, CloudTrail, budget exist. Still open: administrator MFA sign-in, tenant isolation and caregiver restriction on prd, signature stored in the prd bucket, restore test, Multi-AZ, budget limit and alerts, secret rotation.
- B4: a single Cognito pool exists, so production shares TEST's pool (INFERRED).
- B1: web wiring (API host) and the web/Lambda commit remain open.
