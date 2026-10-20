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

## 10. P1 prepared: production ledger read script (prepared 2026-10-19; NOT RUN)
`docs/releases/2026-10-19-prd-readiness/scripts/ledger-prd-read.sh`, tested by `infra/aws/test/prd-ledger-read.test.ts` (10 tests, mocks, no AWS). Derived from the TEST rehearsal's `ledger-recheck.sh` with four stated changes (header of the script). Report only: no expected version, exit 0 on a successful read with the rule removed and verified.
YELLOW at run time: it adds ONE temporary inbound rule (tcp 5432 from the admin host's /32) to the RDS security group `sg-00530a1f4f7648e65`, which is SHARED by TEST and production, then removes it and compares the complete rule set with the recorded original. It needs the typed phrase `OPEN-5432-WINDOW` and a second CloudShell session ready for `--restore-only`. It uses the RDS master secret in memory only and runs read-only transactions (`default_transaction_read_only=on`). Not approved to run until the owner says so.
It reports: whether `ogevia_prd` exists, whether the ledger table exists, count and latest version, the five newest ledger rows, and the enforcement count if that table exists.

## 11. Production ledger read (OWNER-REPORTED SUMMARY, 2026-10-20) and reassessment of B1 and B2
Run of `ledger-prd-read.sh prd --host-ip` (package sha256 `50c1b341...af62d`, verified in CloudShell). Reported: `ogevia_prd` exists and is reachable; **46 migrations applied, latest 0046**; enforcement activated for 0 of 0 agencies; newest rows 0046 visit_start_availability, 0045 manual_care_offer, 0044 readiness_review, 0043 explainable_matching, 0042 readiness_gate; security group RESTORED and verified identical to the original. The owner pasted a summary, not the raw output (applied times and the script's RESULT line were not included).

### What this establishes
| Fact | Status |
|---|---|
| `ogevia_prd` exists, is reachable from the admin host, and has a ledger | OWNER-REPORTED |
| Production is at 46 / 0046 | OWNER-REPORTED |
| This is the caregiver-readiness release, not the 38-migration release (`URL_REGISTRY_AND_LAUNCH_CHECKLIST.md` item 6 predicted 46 / 0046 for exactly that release). Consistent with the code: migration 0046 was committed 2026-10-10 00:38Z and the production Lambda was last modified 2026-10-10 06:11Z. | INFERRED (consistent, not proven; no commit recorded) |
| TEST is at 85 / 0085. **Production is 39 migrations behind: 0047 to 0085** (39 migration files in the repository for 0047-0085, contiguous). My earlier "up to 47 behind" estimate is replaced by 39. | Count VERIFIED against the repository; production side owner-reported |
| 0 of 0 agencies means the readiness-settings table has no rows. INFERRED: no organization is configured in production yet (no real tenant data). NOT VERIFIED: needs row counts. | INFERRED |

### The 39 pending migrations (repository analysis, heuristic grep, not a review)
Statement classes across 0047-0085: CREATE TABLE in 16 files, ALTER TABLE in 18, DROP in 18, UPDATE in 25, DELETE FROM in 3, INSERT in 29, CREATE OR REPLACE FUNCTION in 30, CREATE INDEX in 14, CREATE POLICY in 15. Files matching drop-table/drop-column, delete-from, UPDATE, alter-column or drop-constraint patterns (need manual review before any production run): 0047, 0053, 0054, 0055, 0071, 0072, 0074, 0076. A broad "UPDATE" match can be a false positive (for example `ON UPDATE` or a function body), so this list is a review queue, not a finding of data loss. These migrations have been applied to TEST in sequence (52, 77, 85) with synthetic data; none has been applied to a production-like data set.

### B1 (state unknown): NARROWED, not closed
Now known (owner-reported): database exists, ledger 46 / 0046, Lambda wired to `ogevia_prd`, stacks healthy and protected, buckets protected, MFA on the pool, CloudTrail and a budget exist.
Still unknown: the commit the production Lambda was built from (no record); the web bundle's API host (my first command was defective; corrected command issued, no output received); whether the production web carries a version string; applied-at times of ledger rows; row counts (organizations, users, clients, visits) to say whether production holds real data.

### B2 (version gap): QUANTIFIED, open
Gap: 39 migrations (0047-0085) and every API/web release since 2026-10-10 (handler builds f6dd9b7 and e80b770 on TEST). The upgrade is a forward migration of an existing installation, not a bootstrap, so `deploy-production.sh database` and `all` must NOT be used (`RELEASE_HANDOFF.md` says the same). Mitigations required before a production run: (1) fresh named manual snapshot of the shared instance (B10); (2) rehearsal of 0047-0085 on a copy of `ogevia_prd` restored from that snapshot to a NEW instance; (3) manual review of the eight queued files; (4) production copy of the TEST gate set (pin check, diff gate against the live `Ogevia-prd-*` templates, baseline capture) because the TEST package scripts are TEST-only; (5) fix of the two procedure defects and the `approval_ref` item.

### Updated blocker table
| # | Status |
|---|---|
| B1 | Narrowed (ledger and database known); open items listed above |
| B2 | Quantified: 39 migrations; open until the rehearsal, review and package exist |
| B3-B10 | Unchanged from section 9; B10 (no `pre-prd` snapshot) is now the first action in any production sequence |

### Next reads that need no production change
1. Raw ledger rows with applied times (rerun the same report; read-only, same temporary rule: a separate approval).
2. Non-PHI row counts to decide whether production holds real data (needs a new read script; not prepared).
3. The corrected API-host check against the production web (CloudShell `curl`, no rule needed).

## 12. Review of the eight flagged migrations (2026-10-20; static, repository only)
Full review: `docs/releases/2026-10-19-prd-readiness/MIGRATION_REVIEW_EIGHT_FILES.md`.
- The earlier scan over-flagged: most UPDATE and DELETE matches are inside function bodies. At migration time, the eight files contain no UPDATE, DELETE, DROP TABLE or DROP COLUMN on existing data; the only data statements are two permission inserts in 0055.
- Every check-constraint replacement only widens the allowed values (static parse), and every new check on an existing table passes for existing rows (new nullable columns; `valid_series_pattern(NULL)` is true).
- **Main risk: dropped and recreated functions** (0047, 0053, 0054, 0071, 0072). The production API (2026-10-10 build) calls the old signatures, so API calls fail between the migration run and the API deploy. The upgrade must run migrations then deploy API and web back to back, in a quiet window.
- Rollback files exist for all eight in `infra/aws/db/rollback/` (names checked, content not reviewed).
- Not reviewed: the other 31 files of 0047-0085. Not executed: nothing was run against a production-like copy.
B2 therefore stays open, with its risk restated as ordering and compatibility plus 31 unreviewed files, not unknown data loss.

## 13. Review of the other 31 migrations (2026-10-20; static, repository only)
Full review: `docs/releases/2026-10-19-prd-readiness/MIGRATION_REVIEW_OTHER_31_FILES.md`. With section 12, all 39 pending migrations (0047-0085) have been read.
- No UPDATE, DELETE, TRUNCATE, DROP TABLE, DROP COLUMN or constraint change on existing data at migration time. Data written: permission rows (0048, 0069) and the SoCal Care Services work-hour policy row (0060).
- Only 0061 can refuse to run on existing data (unique index on live recurring shifts), and it checks first and rolls back cleanly.
- 35 function drops, all recreated except the intentional removal of `record_report_export` (0072). The caregiver visit start and confirmation functions are among them (0050), so the old production API cannot start an unscheduled visit or confirm a visit between the migration and the API deploy.
- Correction to section 12: 0072 removes `record_report_export`; it does not recreate it.
- B2: the unreviewed-files part is closed (static). B2 stays open for the rehearsal, snapshot, production gate scripts and a quiet window.

## 14. Rehearsal plan designed (2026-10-20; design only)
`docs/releases/2026-10-19-prd-readiness/REHEARSAL_PLAN.md`: restore a fresh snapshot of the shared instance to a new, dedicated-security-group instance, apply 0047-0085 with the pinned runner, verify ledger, checksums, the repository verification set, schema parity with TEST and unchanged existing data, record timings, optionally rehearse rollback, then delete the copy. Does not touch the shared security group, production or TEST. Nothing approved or run. API compatibility during the migration-to-deploy gap remains untested (stated residual risk). Next: owner decisions in section 5 of that file, then the R0 read-only questions.

## 15. Down scripts reviewed (2026-10-20; static)
`docs/releases/2026-10-19-prd-readiness/ROLLBACK_SCRIPTS_REVIEW_0047_0085.md`. All 39 down scripts exist: 26 SAFE AUTOMATED (refuse when records would be lost) and 13 BACKUP REQUIRED (drop tables with data, no archive). Down scripts do not remove ledger rows; the runner does, and no runner covers 0085 down to 0047 (the TEST wrapper covers 0085 to 0078 only). The repository proves an empty-database round trip; populated-data behavior of the 0047-0085 down scripts is NOT verified. Before production uses the new features a rollback should be lossless; after real use the path is fix-forward or a snapshot restore to a new instance. R6 of the rehearsal needs a new rollback runner and a recommended synthetic-data test.

## 16. Rollback runner and populated-data tests built (2026-10-20; local only)
See "Update 2026-10-20" in `ROLLBACK_SCRIPTS_REVIEW_0047_0085.md`. New: `rollback-range.ts`, `rollback-to.ts`, `fingerprint.ts`, `rollback-range.db.test.ts` (9 tests passed on local PostgreSQL 16; existing rollback test 3 of 3; tsc clean). Verified locally: 0085 down to 0047 restores the 0046 schema except 11 availability-override objects the 0047 down script keeps by design; re-migrating reproduces the 0085 schema; the guards in 0050, 0053 and 0054 refuse with synthetic data and the run is repeatable; 0069 (BACKUP REQUIRED) deletes its table and rows without refusing. NOT verified: the other 22 guarded scripts and 12 BACKUP REQUIRED scripts with data; lint of the new files (`eslint` in `infra/aws` printed a configuration-migration message instead of running); any AWS run.

## 17. Rehearsal package built (2026-10-20; local only)
`docs/releases/2026-10-19-prd-readiness/package/ogevia-prd-rehearsal.tar.gz`; details in section 7 of `REHEARSAL_PLAN.md`. 14 mock-AWS tests with real local PostgreSQL passed. Nothing has run against AWS. Approvals still needed to use it: the R1 snapshot, the R2 restore (cost), the rollback rehearsal, and the R8 deletion (RED), each at the time; also the non-PHI row-count read from R0 is not part of the package.

## 18. R0 run (2026-10-20): passed; blocker B10 corrected
See section 8 of `REHEARSAL_PLAN.md`. R0 passed in CloudShell with the verified package (read-only, nothing changed). The production instance facts are now owner-pasted raw output (db.t4g.micro, PostgreSQL 18.3, 20 GB gp3, single-AZ, default.postgres18). R0 counts 11 manual snapshots, not the 4 reported on 2026-10-19, so the statement that no `pre-prd` snapshot exists is withdrawn until the names are listed. Next gates: owner decisions (release window, rollback rehearsal, row-count read, snapshot retention) and approval of R1.

## 19. Blocker B10 corrected (2026-10-20)
A `pre-prd` snapshot exists: `ogevia-prod-postgres-pre-prd-20261010` (2026-10-10 05:44Z, available, encrypted), taken before the original production deployment. B10 is re-stated: no snapshot of the CURRENT production state exists; a fresh named snapshot is still the first action of any production sequence. Six of eleven snapshot names remain unseen (pager cut the paste off).

## 20. Snapshot inventory completed (2026-10-20)
Eleven manual snapshots listed in full (section 10 of `REHEARSAL_PLAN.md`). Two `pre-prd` snapshots exist (2026-10-08, 2026-10-10), both pre-deployment. B10 (no snapshot of the current production state) stands. Open owner decision: a retention rule for the eleven snapshots.
