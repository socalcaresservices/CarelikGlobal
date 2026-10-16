# Pilot deployment procedure and rollback: Wave 1 (migrations 0047 to 0052)

**Status update 2026-10-16 (correction).** This procedure was written as a draft and was then executed on TEST in the 2026-10-14/15 window (owner statement `owner-go-pilot-0052-2026-10-15`, recorded in PR #98): the database and API steps are evidenced as done (ledger `52|0052`, 169 live routes, both owner-reported); the web step (13) was excluded by the owner, and the smoke, regression and seed steps (14 onward) were not part of that approval. The web release is covered by `docs/releases/2026-10-16-test-web-release/`. **The starting ledger the draft assumed (`46|0046`) was wrong for TEST:** the operator read `36|0036` (contiguous) before the window, so the runner applied **0037 to 0052 (16 files)**, not only 0047 to 0052. Evidence that TEST is now at 0052 (operator release folder `ogevia-release-0052-run`, owner-reported): `RELEASE_0052_SUMMARY.txt`, `step7.log` ("STEP 7 COMPLETE", ledger `52|0052`), `db-verify.txt` (PASS `latest_migration_is_0052`). The `46|0046` figures below remain only as the **owner-reported, unverified** ledger of PRODUCTION, which this procedure does not touch.

**Original draft status (kept for the record): DRAFT PROCEDURE. NOT EXECUTED. NOT AUTHORIZED. No script is provided for the deployment steps** (reason in section 9). It replaces the read-only first half of `PILOT_OPERATOR_RUNBOOK.md` section 4 with a complete, gated sequence. Target: the AWS **pilot/test** environment only (stacks `Ogevia-prod-*`, database `ogevia_sv_test`). Production is a separate decision and a separate execution (Phase E).

Labels used below: **READ** (changes nothing), **WRITES** (changes AWS or data; needs the owner's written approval first), **IRREVERSIBLE** (cannot be undone by this procedure; flagged separately in section 8).

## 1. Release candidate and starting state
| Item | Value | Status |
|---|---|---|
| Release candidate SHA | **Set by the owner (O1).** The deployable code (application, migrations, API, infrastructure, web) is identical from `63de403` to `main` `484135df007bd10e76fdd37e8ddcb6db015a7dc7` and to the work branch (it adds tests, `smoke.py` and documents only). The recommended SHA is the `main` commit that results from merging the readiness branch, so the evidence, the smoke scripts and the deployed code carry one SHA. If the owner prefers not to merge first, `484135df…` is a valid candidate. The operator pins the full 40 characters and refuses to continue if `git rev-parse HEAD` differs. | OPEN |
| Starting migration state (TEST) | **Corrected 2026-10-16:** ledger `36|0036`, contiguous (`0001|0036|36|true`), read by the operator before the 2026-10-14 window. The draft's earlier assumption of `46|0046` was never verified and was wrong for TEST. Because the runner applies every missing migration, 0037 to 0052 were applied together. Any other starting ledger stops the procedure until the owner decides. | OPERATOR-READ (PR #98); now superseded by `52|0052` |
| Migration sequence | 0047, 0048, 0049, 0050, 0051, 0052, in that order, by the checksummed runner: one transaction per file, refuses a changed applied file. Expected on TEST (derived: 52 minus 36): `applied 16, already applied 36`; afterwards `52|0052` and `db:verify` every line PASS (including `latest_migration_is_0052`). Rehearsed locally from a database at 0046: `applied 6, already applied 46`, 0 FAIL. | local only |
| What each migration does | 0047 override: one shift, one use (removes the 5-argument override function, adds a 6-argument one); 0048 account enable/disable (4 functions, permission `accounts.manage` for the owner role); 0049 reservation not counted once a late confirmation is accepted (functions only); 0050 visit review and variance rule (2 new tables, 2 new nullable columns, replaces the start and confirm functions with versions that have one trailing optional argument); 0051 open-shift pick-up (2 functions); 0052 reservation not counted for a review visit that is counted as used (one function). No existing row changes (`upgrade-0046-to-0048` and `upgrade-0049-to-0052` tests). | VERIFIED (local) |
| API compatibility | Between the database step and the API step the OLD API keeps working for visits on a scheduled shift; a start with no scheduled shift is refused (reason required) and creating an availability override fails. The NEW API on the OLD database fails the new routes. Hence database first, API second, web last, in one sitting. | VERIFIED (design, tests) |

## 2. Approvals required (each is an explicit written message from the owner naming the SHA and the window)
| # | Approval | Covers | Class |
|---|---|---|---|
| A1 | Read-only preflight | `pilot-preflight-readonly.sh [--probe-lambda]` | READ |
| A2 | Use of the RDS master secret for the ledger read | `get-secret-value`, SSM tunnel, `select` only | READ, uses a secret |
| A3 | Release candidate SHA, window, Operator, approval reference | Everything below | decision |
| A4 | Create the pre-deployment snapshot | `create-db-snapshot` | WRITES (adds a snapshot) |
| A5 | DB window | Attaches the app security group to the admin host, then restores it | WRITES (security group) |
| A6 | Apply migrations 0047 to 0052 | `db:migrate` | WRITES (schema) |
| A7 | Deploy the API stack | `cdk deploy` of `Ogevia-prod-ServiceVerificationApi` only | WRITES (Lambda, routes, IAM) |
| A8 | Publish the web build | S3 files, CloudFront invalidation | WRITES |
| A9 | Run `smoke.py` and `pilot_regression.py` | create synthetic records | WRITES (synthetic data) |
| A10 | Roll back, and how far | section 7 | decision |
A single message may grant several, but each must be named. Silence or an earlier approval never extends to a later step.

## 3. Preconditions (all true before A4; otherwise stop)
1. The read-only preflight (A1) ran and every STOP item is resolved; its folder is saved under `docs/releases/2026-10-13-wave1/evidence/`.
2. The ledger was read (A2) and equals the approved starting state (TEST: `36|0036`; any other value: stop and ask the owner).
3. `git rev-parse HEAD` equals the pinned SHA; the checkout is clean; `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build` pass; `pnpm test:all` passes with **0 skipped** against a LOCAL throwaway database (never the pilot).
4. The pilot's account is `300094796789`, region `us-west-2`; `DB_NAME` is `ogevia_sv_test` and `OGEVIA_ENV` is not `prd` (preflight section 3).
5. Phase B is signed for this SHA (`evidence/PHASE_B_WALKTHROUGH.md` covers the application code; re-run if the SHA's application code differs).

## 4. Backups and rollback material (capture before any change)
1. **Snapshot (A4, WRITES):** `aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier ogevia-prod-postgres-pre-wave1-<YYYYMMDD> --tags Key=purpose,Value=pre-wave1-rollback`, then `aws rds wait db-snapshot-available --db-snapshot-identifier <same>` (about 5 to 15 minutes). Record the identifier and `available`. **Never delete it as part of this release.**
2. **Automated backups:** retention at least 1 day and a recent `LatestRestorableTime` (preflight section 6). If retention is 0 STOP.
3. **API rollback template and code:** `aws cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original` (the preflight saves it as `api-template-live.json`); record the Lambda `CodeSha256` and, for the identity function, its configuration.
4. **Web rollback files:** `aws s3 sync s3://<site bucket> <local folder>` (READ from S3, writes locally) and `aws s3api head-object` for `index.html` (version id).
5. **Row fingerprints before the migration** (same query after, equal counts and hashes for tables that must not change): visits, confirmations, shifts, reservations, authorizations, audit rows. The query is the one in `infra/aws/db/test/upgrade-0049-to-0052.db.test.ts` (`fingerprints`), run through `psql`.

## 5. Deployment sequence (A3 to A8). Stop at the first failed check.
| Step | Action | Class | Expected result | Stop when |
|---|---|---|---|---|
| 1 | Pin and verify the SHA, gates (section 3) | READ | all pass | any fail |
| 2 | Snapshot and rollback material (section 4) | WRITES | snapshot `available` | not available |
| 3 | Ledger read again, immediately before | READ | `36|0036` (TEST) | anything else |
| 4 | **DB window (A5):** attach the app security group to the admin host, open the SSM tunnel, hold the credentials in shell memory only. The existing helpers are `db_window_open` and `db_window_close` in `infra/aws/slice/pilot-lib.sh`; the close restores the admin host's original groups and must run on every exit | WRITES | tunnel up | cannot reach RDS; original groups not restored (fix first) |
| 5 | Fingerprints before (section 4.5) | READ | recorded | |
| 6 | `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner pnpm --filter @carelik/infra-aws db:migrate` from the pinned checkout | WRITES | `applied 16, already applied 36` (TEST) | a migration error (that file rolled back; earlier ones stay) or checksum drift |
| 7 | `db:verify` | READ | every line PASS; ledger `52|0052` | any FAIL |
| 8 | Fingerprints after; compare | READ | tables that must not change are identical | any difference |
| 9 | Close the DB window; confirm the admin host's groups equal the originals | WRITES | restored | still attached |
| 10 | **API (A7):** set `OGEVIA_DEPLOY_APPROVAL` to the reference inside the LIVE `ogevia:deployment-status` tag (`approved-<reference>`; read it from the saved live templates, as `release-0036-deploy.sh` does; a different value would show a tag change on every resource and is a STOP), then `cd infra/aws && npx cdk diff -c env=prod -c mode=deploy`; read the diff to the owner | READ | only `Ogevia-prod-ServiceVerificationApi`: the 7 routes `GET /v1/accounts`, `POST /v1/accounts/{userId}/disable`, `POST /v1/accounts/{userId}/enable`, `GET /v1/visit-rules`, `POST /v1/visit-rules`, `GET /v1/open-shifts`, `POST /v1/shifts/{shiftId}/pickup` (all JWT); the IAM statement `SwitchSignInsOnOff` (`AdminDisableUser`, `AdminEnableUser`); new code for the API and identity Lambdas; description changes | **anything else**: another stack, a security group, a secret, a deletion or replacement |
| 11 | `npx cdk deploy -c env=prod -c mode=deploy --exclusively Ogevia-prod-ServiceVerificationApi` (same `OGEVIA_DEPLOY_APPROVAL`) and **answer the interactive IAM confirmation yourself** | WRITES | stack `UPDATE_COMPLETE`; Lambda still has `DB_NAME=ogevia_sv_test` | a failed update (CloudFormation rolls the stack back by itself) |
| 12 | Anonymous probes (runbook section 5): `/v1/me`, `/v1/visit-rules`, `/v1/open-shifts` all 401 | READ | 401 | 404 (route missing) or 5xx |
| 13 | **Web (A8):** build with `VITE_APP_ENV=test VITE_AUTH_PROVIDER=cognito` for the pilot, **never `production`**. The pilot's `config.json` is kept (not overwritten) and has no `VITE_APP_ENV` key, so the build value decides the label: a production-labelled build shows no banner and looks like production (reproduced in Chromium 2026-10-16). Before any upload confirm the built files contain `VITE_APP_ENV:"test"` and not `VITE_APP_ENV:"production"` (`assert_test_web_label` in `pilot-lib.sh`); the banner text itself is in every build, so searching for it proves nothing; `aws s3 sync` assets with `--cache-control public,max-age=31536000,immutable`; `index.html` with `no-cache`; `aws cloudfront create-invalidation --paths "/*"` and wait | WRITES | invalidation completed; **SMK-07: the "TEST — synthetic data only" banner is visible on every page after sign-in (stop if not)** | |
| 14 | **Smoke and regression (A9):** `smoke.py` then `pilot_smoke.py` then `pilot_regression.py --api-url <pilot API>` (exact commands in runbook section 6) | WRITES (synthetic) | `smoke.py` all PASS; `pilot_smoke.py` 11 of 11; regression exit 0 | any FAIL or exit not 0 |
| 15 | By-hand checks and Authorization hand-calculation (runbook section 7) | WRITES (synthetic) | as listed | any FAIL |
| 16 | Log review: no 5xx, no `function ... does not exist`, `column ... does not exist`, enum errors | READ | none | any |
Record everything under `docs/releases/2026-10-13-wave1/evidence/` and in `CHECKLIST.md` Phase C. A FAIL means: stop, fix forward with a new commit, restart at Phase A.

## 6. Failure and rollback conditions (the owner decides; the Operator calls "stop" at any time)
| Condition | Action |
|---|---|
| Any precondition or stop item in sections 3 to 5 | Stop. Nothing later runs. If steps 6 or later ran, go to the layer table below. |
| A migration fails | That migration rolled back by itself; the ledger shows what applied. Do not edit the migration. Report; decide with the owner. |
| `db:verify` FAIL or fingerprints differ after the migration | **Do not deploy the API or web.** Roll back the database (section 7) or restore the snapshot to a new instance. |
| `cdk diff` shows anything outside the expected list | Do not deploy. Report. |
| API deployed, a smoke check fails | Roll back web then API. The database may stay at 0052 if no Wave 1 records exist yet (the old API tolerates it; see section 7). |
| The issue appears only after real use | Prefer fix forward; the down script for 0050 will refuse (section 7). |

## 7. Rollback procedure (newest layer first)
| Layer | Action | What it cannot undo |
|---|---|---|
| Web | `aws s3 sync` the captured files back (assets immutable, `index.html` no-cache), `cloudfront create-invalidation`, wait. `config.json` is never touched. | |
| API, identity function, IAM | `aws cloudformation update-stack --stack-name Ogevia-prod-ServiceVerificationApi` with the captured template (the pattern in `infra/aws/slice/release-0036-rollback.sh`, `api` branch: copy the template to the CDK asset bucket, update with `UsePreviousValue` parameters and the IAM capabilities, wait, verify the Lambda `CodeSha256` equals the captured one). Removes the 7 routes and the `SwitchSignInsOnOff` statement. | Nothing in the data. |
| Database | `psql "$OGEVIA_DATABASE_URL" -f ../../docs/releases/2026-10-14-pilot-readiness/rollback-0047-0052.sql` from `infra/aws`, inside a DB window. Newest first, each its own transaction. **Rehearsed locally: from 0052 it ends at `46|0046`; it reverts 0047 to 0052 only. Returning TEST to its pre-window `36|0036` would also need the 0037 to 0046 rollbacks and is a separate owner decision; the pre-window snapshot `ogevia-prod-postgres-pre-0052-20261015` is the data anchor.** | See the three limits below. |
| Whole database | Restore the pre-deployment snapshot to a **NEW** instance (`aws rds restore-db-instance-from-db-snapshot ... --no-publicly-accessible`). Separate approval. **Deleting snapshots, databases or tables is not part of this procedure.** | Records created after the snapshot stay on the old instance. |

**Limits of the database rollback (IRREVERSIBLE or blocking):**
1. **After real use of Wave 1 the script stops at 0050 by design.** 0050's down script refuses while any rule version, rule evaluation, unscheduled reason or attestation version exists, and every confirmed visit writes a rule evaluation. Rehearsed on a database that had run the smoke: `ROLLBACK REFUSED: visit rule evaluations exist`, ledger `50|0050` (0052 and 0051 rolled back, 0050 and earlier kept). The old API on a database at 0050 works for visits on a scheduled shift; a start with no shift is refused. The way back from there is a forward fix or the snapshot restore, never deleting those rows.
2. **Accounts disabled while 0048 is live stay disabled** after its rollback and nothing can re-enable them: re-enable them first.
3. Overrides made under 0047 keep their new columns (override history is kept).

## 8. Destructive, irreversible or shared-system actions (flagged)
| Action | Why it is flagged |
|---|---|
| Down 0050 refusing after use; snapshot restore only to a new instance | section 7 limit 1 |
| **The Cognito user pool `us-west-2_849AYz5J7` is shared by the pilot and production** (`SwitchSignInsOnOff` is an IAM statement on that one pool) | Disabling a sign-in in the pilot's Accounts page disables that person in Cognito for production too if the same person exists there. Use **only clearly synthetic test people** for the disable and enable test. |
| The IAM statement `SwitchSignInsOnOff` (a broadening) | CDK asks to confirm it. The Operator reads and confirms it, never `--require-approval never` without a scope gate. |
| The DB window (security group change on the admin host) | Must be restored in every exit path, including errors. Verify the host's groups afterwards. |
| Using the RDS master secret | Held in shell memory only, never printed or saved. |
| Never in this release | deleting snapshots, databases, tables, users or S3 objects; changing `config.json`, Cognito, DNS, Netlify, Supabase, RDS security-group rules or the other four stacks; activating readiness enforcement (a separate owner decision). |

## 9. Why there is no deployment script yet (and what would make one safe)
The earlier pilot releases (`release-0036-*`) were built around a **strict scope gate**: a program that compares the live CloudFormation templates with the new build and refuses to deploy anything outside the approved scope, with a self-test that proves it catches tampering, plus record-level before and after checks. That gate is the script's real safety control, and it can only be written and self-tested against the real live templates, which this session cannot read (no AWS access). A script without the gate would only automate steps 4 to 14 with less protection than the typed, human-read steps above. **Recommendation:** after the preflight returns the live API template (`api-template-live.json`), authorize a separate change that writes `release-0052-*` in the `release-0036-*` pattern (gate and self-test for the scope in section 5 step 10, the section 4.5 fingerprints, the rollback of section 7). The helpers `db_window_open`/`db_window_close` already exist.

## 10. Operator and owner responsibilities
| Who | Responsible for |
|---|---|
| Owner | A1 to A10; the SHA; the window; being reachable; reading the `cdk diff` summary the Operator reports; deciding every rollback; choosing synthetic test people; never sharing credentials or secret values in messages |
| Operator | Running only the approved steps in order; STOP rules; pasting outputs (never secrets or tokens) into the evidence folder; restoring the admin host's security groups; the typed IAM confirmation; reporting every deviation |
| Claude Code | No AWS access. Prepares and statically tests scripts, reads the evidence the Operator returns, records it in the checklist, and proposes fixes. Does not run any step above. |
