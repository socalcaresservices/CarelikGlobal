# Deployment plan: migrations 0047, 0048 and 0049

**Status: PROPOSED. Nothing in this document has been run against AWS. No deployment is authorized.** Every step that changes AWS or production data is YELLOW (`CLAUDE.md` section 13) and waits for the owner.
**Release id:** `2026-10-13-0047-0048-0049`. Process: `docs/TESTING_AND_RELEASE_PROCESS.md` (adopted 2026-10-13). Checklist: `CHECKLIST.md` in this folder (Phase A filled from today's runs; B to F open).
Supersedes the procedure in `docs/releases/DEPLOYMENT_CHECKPOINT_0047_0048.md` where they differ (section 3 explains why).

## 1. What ships

| Migration | What it does | What users notice |
|---|---|---|
| **0047** availability override: one shift, one use | Adds nullable columns to `availability_overrides`; new override helper; `readiness_checks` / `assert_ready_for_work` replaced; trigger links a used override to its shift; the 5-argument `authorize_availability_override` is **removed** and a 6-argument form (needs a client) added; `list_shifts` gains two columns | Creating an override needs a client and covers one shift once; shifts assigned under an override say "Assigned with Admin override"; matching panel reads Match / Partial Match / No Match |
| **0048** account status, enable/disable | Four account functions, permission `accounts.manage` granted to the owner role only | Setup menu shows **Accounts** to the Administrator: status in plain words, Disable / Enable with a reason |
| **0049** reservation not counted once a late confirmation is accepted (F1) | Function-only: one new helper, three functions replaced. No table, column, index, trigger, grant or row changes | For visits in review whose late confirmation was accepted and that were linked to a shift, **Hours left goes up**: the minutes count once (used), not also as reserved. Example: 10 h authorized, 45 min accepted, 2 h shift reserved: 7 hr 15 min before, 9 hr 15 min after (`docs/product/evidence/f1-before-after/`) |

Also deployed with them (unchanged since the owner's earlier choice of `1639cf6`): the API handler code, identity function code, **IAM: one new statement `SwitchSignInsOnOff` (`AdminDisableUser`, `AdminEnableUser`) on one user pool**, three new JWT routes (`GET /v1/accounts`, `POST /v1/accounts/{userId}/disable`, `POST /v1/accounts/{userId}/enable`), and the matching web bundle.

**Not changed:** readiness enforcement (stays exactly as it is now; see section 7), Cognito users, passwords, memberships, any existing row in any table (`upgrade-0046-to-0048.db.test.ts` proves 0047/0048; 0049 changes no stored row), NetworkEgress / EvidenceStorage / Observability / WebHosting stacks, security groups, secrets, DNS, Netlify, Supabase.

**Verified (read of the git history, 2026-10-13):** between the owner's chosen commit `1639cf6` and this branch, the **only** changes to anything that is deployed are migration 0049, its rollback, and `db/verification/01_schema_version.sql`. `apps/sv-api/src`, non-test `apps/web/src`, `infra/aws/lib`, `infra/aws/bin` and `packages` are unchanged (`git diff 1639cf6..HEAD`). So the API, identity function, IAM change and web bundle of this release are the ones the owner already reviewed; the new element is 0049.

## 2. Decisions needed from the owner (nothing starts without these)

| # | Decision | Recommendation |
|---|---|---|
| P1 | **Merge.** Migration 0049 exists only on branch `claude/determined-goodall-syvv7s` (not merged; no pull request was created). Merge it (it also carries the harness, test:all, CI and process documents, none of which is deployed), or deploy from another commit | Open a pull request from the branch, review, merge with a merge commit; record the resulting `main` SHA |
| P2 | **Deploy SHA** (full 40 characters). The earlier choice `1639cf6` does not contain 0049 | The merge commit from P1 |
| P3 | **Stage order.** On 2026-10-11 the owner chose to deploy straight to production. The testing and release process adopted on 2026-10-13 requires the pilot/test environment first | Pilot first (this plan). If the owner wants production first, record that as a written exception to the process |
| P4 | **Approval reference.** `OGEVIA_DEPLOY_APPROVAL_20261010` was given against commits `6c86b1d`/`9169ad1` | Issue a new reference for the P2 SHA |
| P5 | **Operator, windows.** Operator with admin AWS credentials and `session-manager-plugin`; one low-traffic window for the pilot, one for production | |
| P6 | **Pilot release script.** There is no pilot deployment script for this release (4.1 below) | Approve writing and reviewing one (GREEN to write, YELLOW to run) |
| P7 | **Enforcement activation** is a separate owner decision with its own rule (section 7) | Not on deployment day |

## 3. Problems found while preparing this plan (stated, not hidden)

1. **The rollback command in the earlier checkpoint cannot work.** `db:rollback-readiness 0047` fails: the tool knows data tables only for migrations 0039 to 0043, so for a target of 0044 or later it has nothing to archive and its own check (`slot_count > 0`) rejects the attempt. Reproduced 2026-10-13; the transaction rolled back and the ledger stayed intact. **Corrected, tested procedure: section 10.** Recommended follow-up: fix the tool (and test it) so partial targets work; that is a separate change.
2. **Contiguity.** The migration runner applies everything missing, in order. Deploying 0049 deploys 0047 and 0048 with it, and any earlier migration not yet live. Production's ledger is owner-reported as `46|0046` (not verified by Claude); **the pilot's ledger is unknown**. If either is lower than 0046, the whole intervening release is deployed too and needs its own approval. The pre-flight in Stage 3 stops on any other ledger.
3. **Shared Cognito pool.** The pool `us-west-2_849AYz5J7` is used by both the pilot (`Ogevia-prod-*`) and production (`Ogevia-prd-*`). The new IAM statement cannot limit itself to one environment; the limits are in the database (owner-only permission, same-agency checks, audit). Each environment gets its own copy of the statement when its API stack is deployed.
4. **Engine version.** All local tests ran on PostgreSQL 16; CI uses 18 (matching RDS per the CI comment). Not verified on the real RDS engine.
5. **0048's Cognito lookup** by `sub`: the owner reported `status CONFIRMED, enabled true` for the lookup. That proves the lookup, not Disable/Enable; the first Disable/Enable of a synthetic person after deployment is the proof.

## 4. Stages

### Stage 0: merge and fix the SHA (owner)
P1 and P2. Everything below refers to that SHA. Re-run Phase A on it (Stage 1): the results in `CHECKLIST.md` were obtained on the branch head, not the merge commit.

### Stage 1: Phase A, development (Claude Code; evidence in the checklist)
```bash
git fetch origin && git checkout <SHA>
corepack enable && pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm build
OGEVIA_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres pnpm test:all    # 0 skipped
```
Evidence so far (branch head `52100d2`, local PostgreSQL 16, 2026-10-13): `pnpm test:all` passed (unit shared 118, auth 138, sv-api 67, ui 73, infra-aws 124, web 762; database 521; API 69; 0 skipped). `pnpm lint`, `typecheck`, `build` passed. CI on Node 22 / PostgreSQL 18 not yet observed.

### Stage 2: Phase B, local harness
- **0049: done.** Before/after screenshots of the same client (`docs/product/evidence/f1-before-after/`); harness smoke check passes (41/41, includes the F1 balance).
- **0047 and 0048: NOT DONE for the harness.** The seed has no override or account scenario. Needed before Phase C: extend `infra/aws/local-harness/setup.ts` with (a) a caregiver with no availability and a client, (b) a synthetic caregiver to disable and enable; then verify by hand and record screenshots for catalog IDs SCH-14, SCH-15, USR-04, USR-05, USR-06 (desktop 1280; Accounts also at 390). Without readiness enforcement activated the manager refusal cannot be shown (section 7): use a synthetic second agency or accept that Phase C checks it only after a pilot-only activation.

### Stage 3: Phase C, pilot/test environment (Operator; YELLOW)
Target: stacks `Ogevia-prod-*`, database `ogevia_sv_test`, banner "TEST — synthetic data only". **Never** `Ogevia-prd-*` or `ogevia_prd`.

**4.1 Tooling gap (P6).** The scripts that exist for the pilot are per release (`pilot-*`, `increment-*`, `release-0026-*`, `release-0036-*`); none targets 0047 to 0049. `deploy-production.sh` is production only (it refuses any other database). A pilot script set must be written in the pattern of `release-0036-*` (bootstrap, gate with a self-test that checks the change scope, deploy with a single DEPLOY prompt, read-only live checks, rollback), and reviewed in Phase A. It must: read the pilot ledger first and stop unless it is exactly the expected value; take a snapshot; run migrations `0047` to `0049` only; deploy the API stack with `cdk diff` shown and any change outside the scope of section 1 a STOP; publish the web build keeping `config.json`; run the checks below.

**Steps** (the script performs 1 to 6; the Operator and testers do 7 to 12):
1. Pre-flight, read-only: record the SHA, pilot ledger (`select count(*), max(version) from ogevia_meta.schema_migrations`; expected `46|0046`; **any other value: stop and report**), stack statuses, current web bundle and API template (rollback inputs).
2. Snapshot of the RDS instance; record its identifier and `available` status.
3. Run the read-only count (`read-only-count-affected-by-0049.sql`) and record the result.
4. Migrations: `OGEVIA_DATABASE_URL=<pilot db via the private tunnel> OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner pnpm --filter @carelik/infra-aws db:migrate` (expect `applied 3, already applied 46`), then `db:verify` (every line PASS) and ledger `49|0049`.
5. API and identity function and IAM: `cdk diff -c env=prod` then deploy. Expected for `Ogevia-prod-ServiceVerificationApi` only: three routes, IAM statement `SwitchSignInsOnOff`, code for the API and identity Lambdas, description changes. Anything else is a STOP.
6. Web build for the pilot, published last.
7. Standard suites: `smoke.py`, `pilot_smoke.py`.
8. **Regression runner:** `python3 infra/aws/slice/pilot_regression.py --mode aws --i-am-targeting-the-pilot --commit <SHA> ...` (arguments in `docs/release-process/PILOT_REGRESSION_RUNNER.md`; expected exit 0).
9. Changed workflows by hand (catalog): SCH-14/15 (override; **one shift only**, a second shift refused), USR-04/05/06 (Accounts; disable then enable a clearly synthetic caregiver; two audit events; a Manager sees "only an administrator can manage accounts"), AUT-04 (use the pilot records the read-only count found, if any; otherwise create a late-confirmation case on a synthetic client as in `ACCEPTANCE_TEST_CATALOG.md`).
10. Things the harness cannot prove: Cognito sign-in with MFA as the Administrator, **AdminDisableUser/AdminEnableUser actually reach Cognito** (the disabled person cannot sign in; after enable they can), signature evidence still readable (EVV-02).
11. Every role opens every menu item; read-only search of the API logs for 5xx and error codes during the window.
12. Negative checks: anonymous 401, forged token 401, other agency sees nothing (also run by the runner).

### Stage 4: Phase D, user acceptance (on the pilot)
| Validator | Script (catalog IDs) | Accepted when |
|---|---|---|
| Owner (Administrator) | USR-04/05/06 Accounts; SCH-15 override; DSH-01 Home hours equal client balances | The statuses read in plain words; disable then enable works; the override covers one shift only; numbers agree |
| Scheduler | SCH-01, SCH-09, SCH-10, REC-01/02/09/10 | Scheduling, call-out, replacement, cancel and series behave as before; refusal messages unchanged |
| Caregiver (phone) | SMK-04, SMK-05, VIS-01/02, EVV-05 | Verify visit works start to end; only assigned clients as codes; a disabled caregiver cannot load the app and can again after enable |
| Authorization | AUT-01, AUT-04, AUT-14 | Three balances recalculated by hand (one low use, one near limit, one amended or with an accepted late confirmation) match to the minute |

### Stage 5: Phase E, production approval (owner)
The package (checklist section E): change summary (section 1 of this document), risk assessment (section 9), rollback plan (section 10), **backup confirmation** (production snapshot identifier and status; RDS backup retention at least 7 days with a restorable point; S3 signature bucket versioning confirmed), evidence index, and the **GO / NO-GO record** naming the SHA, approval reference (P4), window and Operator. A GO is valid for that SHA and window only.

### Stage 6: production execution (Operator; YELLOW; after GO)
Same SHA, same sequence as the pilot. From an operator shell with admin credentials and `session-manager-plugin`:
```bash
git fetch origin && git checkout <SHA>
corepack pnpm@9.15.4 install --frozen-lockfile
AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh check          # read-only: RDS, backups, MFA ON, lint/typecheck/test/build, cdk synth
OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh snapshot
#   open the private tunnel and set OGEVIA_DATABASE_URL exactly as in docs/releases/caregiver-readiness/RELEASE_HANDOFF.md section 4
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"   # MUST print 46|0046
psql "$OGEVIA_DATABASE_URL" -Atf docs/releases/2026-10-13-0047-0048-0049/read-only-count-affected-by-0049.sql   # record reservations|minutes
OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner corepack pnpm@9.15.4 --filter @carelik/infra-aws db:migrate   # expect: applied 3, already applied 46
corepack pnpm@9.15.4 --filter @carelik/infra-aws db:verify                                                  # every line PASS
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"          # 49|0049
OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh infra   # interactive: read the cdk diff first
AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh smoke
OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh web
```
`deploy-production.sh check` runs `pnpm test` only: **also run `pnpm test:all`** on the SHA (Stage 1) before this. Do **not** use `deploy-production.sh database` or `all` (they create the database, login, tenant and administrator). **Stop conditions:** the ledger is not `46|0046`; any FAIL; a checksum-drift message; `cdk diff` shows anything beyond section 1 (another stack, a security group, a secret, a deletion or replacement); the snapshot is not `available`.

**Order matters.** Between the migration and the API deploy, creating an availability override fails in the old API/web (nothing else is affected): 0047 removes the old 5-argument function. Do the migration, API and web in one sitting, database first. The reverse (new API on the old database) fails the new routes and the override route.

## 5. After production deployment
1. Ledger `49|0049`, `db:verify` PASS, production smoke OK (the script).
2. The owner signs in (MFA), opens Accounts: statuses in plain words, your own row has no Disable button.
3. Disable then enable a clearly **synthetic** test caregiver: the disabled person cannot load the app; after enable they can; two audit events. (The first real use of AdminDisableUser/AdminEnableUser in production.)
4. Override with a synthetic caregiver: the Manager cannot override; the Administrator grants it for one shift; the shift shows "Assigned with Admin override"; a second shift is refused. (A Manager's refusal appears only after enforcement is active.)
5. Balances: re-run the read-only count; for each affected client the figure on the client page equals authorized minus used minus remaining reservations.
6. Monitoring period (suggest 24 hours): no new 5xx, no support reports; the owner checks the changed workflows again the next business day.

## 6. Rollback (tested 2026-10-13 on a migrated local database)
**Order, newest first: web, then API, then database.** Data is never deleted by hand.
| Layer | Action | Cannot undo |
|---|---|---|
| Web | Redeploy the previous bundle (kept in S3 history) | |
| API / identity / IAM | Check out the previous commit and run the `infra` step: removes the three routes and the IAM statement | |
| Database | **Section 10 procedure** (down scripts 0049, 0048, 0047, each in its own transaction, then ledger rows) | Overrides made under 0047 keep their new columns (override history is kept); accounts disabled while 0048 was live **stay disabled** and nothing can re-enable them afterwards: **re-enable them first** |
| Whole-database | Restore the pre-deployment snapshot to a **NEW** instance only; separate approval; deleting snapshots, databases or tables is RED and not part of this plan | |

## 7. Enforcement activation (not part of this deployment)
Per the owner rule (2026-10-11): do **not** activate on the deployment day unless the Readiness report shows both zero unexpected caregivers and zero problematic upcoming shifts. The owner names the **expected** exceptions beforehand. Activation turns on availability, CPR, TB, client requirements and the visit-start check together (it is not availability-only) and is irreversible through the API. Check whether it is currently active (read-only): `select enforcement_active_from from ogevia.organization_readiness_settings where organization_id = '<SoCal org id>'` (no row or null = report-only).

## 8. Expected user-visible effects
- Administrator: new Accounts page; override form needs a client.
- Everyone with balances: Hours left rises for clients with an accepted late confirmation on a shift-linked visit (the count in `read-only-count-affected-by-0049.sql` says how many).
- Scheduler/Manager: unchanged, except the matching wording and the "Assigned with Admin override" note.
- Caregiver: no change.
- Interruption: a short window between the database and API steps in which creating an override fails.

## 9. Risk assessment
| Risk | Effect | Likelihood | Detected by | Reversal |
|---|---|---|---|---|
| Ledger lower than 0046 (pilot or production), so earlier migrations deploy too | Unapproved behaviour change | Unknown for the pilot; owner-reported 46 for production | Pre-flight ledger stop | Not started if detected |
| 0049 changes balances users have seen | Hours left higher than before for some clients; money relevance (billing capacity) | Certain for affected clients | Read-only count before; client page and catalog AUT-04 after | Down script 0049 restores prior function definitions; no stored row changed |
| Cognito Disable/Enable does not reach the user (sub lookup unproven) | A disabled person could still sign in at Cognito (the database still blocks them in Ogevia) | Low (lookup PASS) | Phase C step 10 | Re-run Disable; fix identity function in a new change |
| IAM statement on the shared pool | The identity function can disable any user of the pool | By design, bounded by database guards and owner-only permission | `cdk diff`; tests assert exactly four Cognito actions on one ARN | Remove the statement (previous commit, `infra` step) |
| Override form against old database / old form against new database | Cannot create an override for minutes | Certain if order is wrong | Order in Stage 6, stop conditions | Finish the sequence |
| Rollback tool defect | `db:rollback-readiness 0047` unusable | Certain (reproduced) | n/a | Use section 10 |
| Engine difference (tested on 16, RDS is 18) | An untested incompatibility | Low (CI runs 18; same SQL) | Pilot migration, `db:verify` | Transaction per file; ledger shows last applied |
| Real data not tested | Edge cases in production data | Possible | Read-only count; `db:verify`; smoke | Rollback plan |

## 10. Database rollback procedure (tested)
File: `rollback-0047-0049.sql` in this folder. From `infra/aws` of the checked-out SHA, with `OGEVIA_DATABASE_URL` for the target database (private tunnel), **after the web and API steps of the rollback**:
```bash
psql "$OGEVIA_DATABASE_URL" -f ../../docs/releases/2026-10-13-0047-0048-0049/rollback-0047-0049.sql
# prints the ledger at the end: expect 46|0046
```
It runs, newest first and each in its own transaction as `ogevia_owner`, the down scripts for 0049, 0048, 0047 and deletes each ledger row, stopping at the first error (`ON_ERROR_STOP`). To roll back only 0049 run just its block. Afterwards `db:verify` **reports FAIL by design** (it expects 0049 and the account functions): the pass condition is the ledger `46|0046`. Re-applying later with `db:migrate` applies exactly 0047, 0048, 0049 (tested). Re-enable any account disabled during 0048 **before** running this.

## 11. Evidence behind this plan
| Statement | How established | Status |
|---|---|---|
| Only 0049 (and its rollback, version check) changed in deployable code since `1639cf6` | `git diff 1639cf6..HEAD` over deployable paths | VERIFIED |
| Fresh migrate to 0049; `db:verify` all PASS (161 checks) | Run 2026-10-13, local PostgreSQL 16 | VERIFIED (local) |
| Manual rollback 0049 to 0047 gives ledger 46, removes the new objects; re-apply applies exactly 3 | Run 2026-10-13, same database | VERIFIED (local) |
| `db:rollback-readiness 0047` fails | Run 2026-10-13; cause read in `rollbacks.ts` | VERIFIED |
| Upgrade from 0046 to 0049 changes no existing row | `upgrade-0046-to-0048.db.test.ts` (updated to include 0049) | VERIFIED (local) |
| The count query is read-only and valid | Run inside `begin read only` on the harness database: 1 reservation, 120 minutes | VERIFIED (local) |
| Pilot ledger, pilot stack state, production ledger `46|0046` | Not accessible from the Claude session | UNKNOWN / owner-reported |
| Cognito Disable/Enable reach the user | Not testable outside AWS | NOT VERIFIED |
| PostgreSQL 18 behaviour | CI job (not yet observed) | NOT VERIFIED |
