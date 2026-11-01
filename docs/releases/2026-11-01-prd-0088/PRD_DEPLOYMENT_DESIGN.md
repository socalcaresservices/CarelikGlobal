# Production deployment of 0086, 0087 and 0088: script design (DRAFT)

**Status: DESIGN ONLY. NOT APPROVED. NOTHING IN THIS FOLDER RUNS AGAINST AWS.** Written 2026-11-01 14:31 UTC at the owner's instruction ("Start the production deployment script"), read as "start preparing", because a request to prepare a deployment is not permission to execute it. A production release needs the six gates (`docs/TESTING_AND_RELEASE_PROCESS.md` section 1.1), the Phase E package, and the owner's explicit GO for one commit and one window. Labels: VERIFIED (read or run), INFERRED, UNKNOWN.

## 1. What production needs (VERIFIED unless marked)
| Fact | Source |
|---|---|
| Production `ogevia_prd`: ledger **85 / 0085**, no staff objects (0086, 0087 absent), enforcement 0 of 0 agencies | read-only run of `ledger-recheck-prd.sh`, 2026-11-01 13:30:37Z (`docs/aws/PRODUCTION_BASELINE_2026-11-01.md` section 5) |
| Production API 228 routes, Lambda asset `debd1d43...` (last modified 2026-10-21), web version `e80b770`; all unchanged since 2026-10-26 | same document, section 1 |
| The pilot (TEST slice) runs 88 / 0088 with 250 routes | `DEPLOYED_RECORD_0088_TEST.md` |
| So a production release is **`migrate` of 0086, 0087 and 0088 in order (three files, no `adopt`)**, an API stack update (228 to 250 routes, INFERRED from the TEST counts) and a web publish | derived |
| Gates G1 to G3 pass on this tree (`INTEGRATION_RECORD.md` section 25) | local run 2026-11-01 |
| Not yet read: what the production tables hold (real or synthetic), the caregiver counts the 0088 backfill would act on | UNKNOWN |

## 2. Principle: the same script that ran on the pilot
The process (section 8) says the Operator deploys "the same SHA with the same script that ran on the pilot". The pilot scripts `STELLA_PHASE_C_DB.sh` and `STELLA_PHASE_C_DEPLOY.sh` ran on TEST on 2026-11-01 and carry five fixes made during that run (catalog lookup for the staff function, no role switch in `vrun`, 22 rows for `verify-0087.sql`, raw-byte web hash, window handling). The production scripts will therefore be **derived from them, with every difference listed in section 4 and reviewable as a diff**, and not from the 2026-10-19 production chain. That chain (`d1-migrate-prd.sh`, `p2-gate.sh`, `deploy-guard-prd.sh`, ...) is hard-wired to the 46 to 85 release (baseline `0046`, 39 files, its own data files) and must not be reused for 0088. Ideas borrowed from it, because they are good: a marker file written only after the database check passes and required before the API deploy; a before-and-after data fingerprint of existing tables; an expected-only gate against the recorded production baseline.

## 3. Steps in production (every step re-runnable or stop-safe; read-only steps first)
| Step | Mode | Effect | Typed confirmation |
|---|---|---|---|
| P0 | `selftest` | local: pins, window, guards; no AWS | none |
| P1 | `check` (deploy script) | read-only: production still equals the recorded baseline (drift gate); Lambda serves `ogevia_prd` with `OGEVIA_ENV=prd`; previous API asset exists | none |
| P2 | `probe` (db script) | read-only database read: ledger 85 / 0085, staff and readiness objects absent, enforcement 0, **counts recorded** | access phrase |
| P3 | `snapshot` | one manual RDS snapshot named `ogevia-prod-postgres-pre-0088-prd-YYYYMMDDTHHMMZ` (the instance also holds TEST) | none |
| P4 | `migrate` | apply 0086, 0087, 0088 with the repository runner; run `verify-0086.sql` (110), `verify-0087.sql` (22), `db:verify`; fingerprint of existing tables unchanged; writes the marker | access phrase, `MIGRATE PRD 0086-0088` |
| P5 | `deploy-api` | CDK update of `Ogevia-prd-ServiceVerificationApi` only; refuses without the marker; expected-only gate first | `DEPLOY-Ogevia-prd-ServiceVerificationApi` |
| P6 | `web` | build for production, publish to the production bucket, invalidate CloudFront, verify raw bytes and the API host `zk527zk4ua` | `PUBLISH-WEB-PRD` |
| P7 | owner checks, smoke | `deploy-production.sh smoke` (read-only) and the owner's own checks | none |
| P8 | `final` | read-only closing read; ledger 88 / 0088 | access phrase |
| P9 | record | `DEPLOYED_RECORD_PRD.md` from pasted evidence only | none |
| R | `rollback-*` | web, then API, then database (section 7) | separate phrases |

## 4. Differences from the pilot scripts (the review list)
| Item | Pilot (TEST) | Production |
|---|---|---|
| Database / environment guard | `ogevia_sv_test`; Lambda `OGEVIA_ENV` not prd | `ogevia_prd`; the Lambda of `Ogevia-prd-ServiceVerificationApi` must report `DB_NAME=ogevia_prd` and `OGEVIA_ENV=prd` before any database mode (new check, from `ledger-recheck-prd.sh`) |
| Stacks | `Ogevia-prod-*` (five) | `Ogevia-prd-*` (six, plus the shared `Ogevia-prod-NetworkEgress` untouched); only `Ogevia-prd-ServiceVerificationApi` and `Ogevia-prd-WebHosting` content changes |
| Starting state | ledger 85 / 0085 with staff objects present (applied outside the ledger) | ledger 85 / 0085, staff objects **absent**; **no `adopt` mode** |
| `migrate` | applies 0088 only ("applied 1, already applied 87") | applies three files ("applied 3, already applied 85"); each in its own transaction (runner semantics) |
| Count assertions | `5/6` caregivers hard-coded | **none**: production counts are unknown; the probe records them and the final step compares (legacy approvals must equal the ready-or-active count recorded before) |
| Read-only SQL | `STELLA_READONLY_VERIFICATION.sql` (lists organization slugs and account rows) | a production file that prints counts only |
| Database access path | attach the application security group to the admin host (G1) | a temporary inbound rule on the RDS security group from the admin host's own `/32`, removed and proven identical by hash: the pattern the owner approved for production on 2026-11-01 (`ledger-recheck-prd.sh`); the admin host's groups are never modified |
| Snapshot | `...-pre-0088-<ts>` | `...-pre-0088-prd-<ts>`; checked available, encrypted, manual, of `ogevia-prod-postgres`, created inside the window |
| Rollback | `rollback` removes 0088 only | `rollback-db` returns to 85 / 0085 (three down files, pinned set hash `4b53cb19...`); drops the staff and readiness tables **with their rows**; needs the snapshot and two typed phrases |
| Web build | TEST (`VITE_APP_ENV=test`, TEST API) | production (`VITE_APP_ENV=production`, API host `zk527zk4ua`, production sign-in values); `config.json` unchanged |
| Window and approval | one window, reference `GO-0088-TEST-...` | its own window and reference, filled from the owner's GO by a fill script, as on the pilot |
Placeholders (`__SHA__`, `__GO_REF__`, `__WIN_START_UTC__`, ...) stay in the files until the owner's GO exists; **every mutating mode refuses to run while one remains**.

## 5. Production expectations (what each step must show)
Before: ledger `85|0085`; staff tables and functions 0 of 23; readiness table absent; enforcement 0 of N. After migrate: `applied 3, already applied 85`; ledger `88|0088`; `verify-0086.sql` 110 checks and `verify-0087.sql` 22 checks, 0 failing; `db:verify` passes; the fingerprint of every existing table equals the one before; legacy approvals equal the ready-or-active count recorded by the probe; enforcement 0. After the API: stack `UPDATE_COMPLETE`, Lambda environment unchanged, routes 228 to 250 (22 added, none removed), 401 without a token on the new routes. After the web: served `index.html` equals the build byte for byte, bundle names the production API host, `config.json` unchanged.

## 6. Order of building (each a separate commit; none touches AWS)
1. `STELLA_PRD_DB.sh` (derived from the pilot script, with the differences above) and `STELLA_PRD_READONLY.sql`.
2. `STELLA_PRD_DEPLOY.sh` (check, deploy-api, web, rollback-web, rollback-api; the expected-only gate for the production API stack).
3. `fill_pins_prd.py` and the pins file.
4. Tests: selftests; a **local database rehearsal 85 to 88** (the repository runner on a local PostgreSQL with synthetic data, the two verification files, the fingerprint, then rollback to 85); mocked-AWS tests of the production scripts as in the earlier packages.
5. `PRD_RUNBOOK.md` and the Phase E package (change summary, risk assessment, rollback plan, backup confirmation, evidence index, decision record).
6. A **read-only** production dry run of the new `probe` and `check` modes (a new production access approval, like the 2026-11-01 one), to prove the access path before the window.

## 7. Rollback and the forward-fix preference
Order: web, then API, then database. The API rollback restores the previous code asset (`debd1d43...`, present in the CDK asset bucket per the baseline). The **database rollback is destructive**: the staff tables (0086) and the four readiness tables (0088) are dropped with their rows, including every approval recorded after launch, so it is a recovery step for an early, clear defect only. After real use, a forward fix is preferred. Restoring the RDS snapshot creates a new instance and is a separate approval (it would also affect TEST, which shares the instance).

## 8. Risks stated plainly
Real caregivers' records are backfilled as "Approved before this checklist existed" (the count is unknown until P2). Sign-in links email real people; none should be sent at launch except as a planned batch. Enforcement stays OFF at launch. The shared RDS instance means the snapshot, the security-group rule and any rollback touch TEST as well. A hard-killed session leaves the temporary rule open; a second tab with the restore command stays ready (as on 2026-11-01).

## 9. Open items and decisions for the owner
1. **Launch scope** (which agency, which caregivers, sign-in links at launch or not, target date): shapes the risk assessment.
2. **The BAA confirmation** (AWS Artifact) and the security and compliance gate.
3. **TEST gaps accepted on 2026-11-01** (cross-agency isolation, authorization arithmetic, role gating, Task 8): run them or accept them again for production.
4. **Access approvals at the time of the GO** (not now): the temporary rule and the master secret for P2, P4 and P8; the CDK deploy; the web publish. Each named in the Phase E package.
5. **Production data classification** (UNKNOWN): the owner stated synthetic only on 2026-10-20; P2 records counts but cannot tell real from synthetic.

## 10. BUILD STATUS: step 1 (the production database script), recorded 2026-11-01 14:40 UTC
**Still NOT APPROVED and NOT RUN against AWS.** Files in this folder:
| File | What it is |
|---|---|
| `STELLA_PRD_DB.sh` | the production database script (modes `selftest`, `probe`, `snapshot`, `migrate`, `final`, `rollback-db`, `--restore-only`), generated by `build_prd_db.py` from `prd_db_header.sh.part` + lines 99-191 of `ledger-recheck-prd.sh` (the access-window block, verbatim except one message; that script is sha256 `133ab6af...`, the one the owner approved for one production read on 2026-11-01) + `prd_db_main.sh.part` |
| `STELLA_PRD_READONLY.sql` | production closing read: counts only (organizations, memberships by role, caregivers by stored status, staff and readiness object presence, enforcement, active onboarding requirements by category, legacy approvals once 0088 exists) |
| `fill_pins_prd.py` | fills the placeholders from the owner's GO (commit, approval reference, window) and the checkout's hashes; `--check` writes nothing |
| `rehearse_local.sh` | local rehearsal of the database change (below) |
| `mock_aws_test.sh` | mocked-AWS test of the pre-window control flow (below) |
**Differences from the design (decided while building):**
1. **TLS to the database is full verification (`verify-full`, by the RDS host name, through the tunnel)**, as on the pilot. The window block of `ledger-recheck-prd.sh` used `require`; the production script does not.
2. **Migrate window: up to 900 s** (reads: 300 s), both overridable with `OGEVIA_WINDOW_MAX_SECONDS`; the pilot's migrate took about a minute.
3. **The old snapshot-age check was dead code in the pilot script**: `snapshot_check fresh` read `$1` after `set -- $d` had overwritten it, so the four-hour age test never ran on TEST. The production script reads the argument first, and also requires the snapshot to be of type manual and created inside the window. (The TEST snapshot was taken minutes before use, so there was no effect on TEST.)
4. **The `adopt` mode does not exist**; `rollback-db` returns to 85 / 0085 with `db:rollback-to 0086` and the pinned three-file set hash.
5. **Existing-data evidence:** before and after `migrate` the script counts the rows of every existing table (counts only) and requires them unchanged except the ledger (+3) and the permission seed rows (`ogevia.permissions`, `ogevia.role_permissions` may only grow); on a mismatch the marker is NOT written and the API deploy stays blocked.
6. **Caregiver counts are not hard-coded**; the post-state requires the same caregiver counts as before and legacy approvals equal to the ready-or-active count read before the migration.
**Findings from the local rehearsal (VERIFIED by running it):**
- Migration 0088 **retires existing onboarding requirements** of the categories `background_check`, `document` and `clearance` (`is_active = false`; nothing deleted): in the synthetic data 8 of 10 requirement rows. The rollback restores them (10 of 10). In production this changes real onboarding checklists; the count by category is in the probe output and must be read before the GO.
- The pinned rollback set hash for 0086-0088 (`4b53cb19...`) is accepted by the runner; `db:rollback-to 0086` removes exactly 0088, 0087 and 0086 and returns the ledger to 85 / 0085 with the staff and readiness objects absent; a wrong set hash is refused and leaves the ledger at 88 / 0088.
**Tests run (local, no AWS):**
| Test | Result |
|---|---|
| `bash -n` | pass |
| `selftest` (placeholders listed, window math, URI encoding, 5 private addresses accepted and 10 refused, the security-group canonical hash: group minus the temporary rule equals the original, a lingering rule is detectable) | pass |
| every mutating mode with placeholders present | refuses first, before any tool check or AWS call (exit 1) |
| a filled scratch copy: `selftest` with `REPO` set | `pins ok` (commit, 0086, 0087, 0088, the 0001-0085 set, the all-88 set, the 0086-0088 rollback set); a tampered pin stops; a mutating mode outside the window refuses before any AWS call |
| `rehearse_local.sh` (local PostgreSQL 16, throwaway database at ledger 85 / 0085 with synthetic rows, the script's own functions extracted and run) | **REHEARSAL PASSED**: runner "applied 3, already applied 85"; `db:verify` exit 0; post-state matches; `verify-0086.sql` 110 and `verify-0087.sql` 22 checks, 0 failing; existing counts unchanged; rerun applies nothing; wrong-hash rollback refused; rollback to 85 / 0085 |
| `mock_aws_test.sh` (stub `aws`, pseudo-terminal) | **MOCK TEST PASSED**: a non-production Lambda, the TEST database name, a different admin-host security group, an admin host with two addresses and a pre-existing rule each stop the run with zero security-group changes; a wrong confirmation phrase changes nothing; the proposal names the `/32`, the group and the original rules |
**Not tested, and why:** the flow after the typed confirmation (opening the rule, the Session Manager tunnel, reading the master secret, the TLS handshake against a real RDS endpoint, the real runner against `ogevia_prd`) cannot be exercised without AWS. The first real test is the owner-approved **read-only `probe` on production** (step 6 of the build order): it uses the same window mechanism the owner approved on 2026-11-01. Until then those steps rest on the verbatim-copied, once-run window block and the pilot's TLS and tunnel code.
**Next (build order step 2):** `STELLA_PRD_DEPLOY.sh` (check, deploy-api, web, rollback-web, rollback-api, the expected-only gate for the production API stack, the marker requirement).

## 11. BUILD STATUS: step 2 (the production deploy script), recorded 2026-11-01 15:02 UTC
**Still NOT APPROVED and NOT RUN against AWS.** New files: `STELLA_PRD_DEPLOY.sh`, `diff_gate_prd0088.py`, `test_gate_prd0088.py`, `mock_aws_test_deploy.sh`; `fill_pins_prd.py` now also fills the deploy script (`--assembly` supplies the two Lambda asset keys).
**Differences from the pilot deploy script `STELLA_PHASE_C_DEPLOY.sh` (the review list):**
| Item | Pilot (TEST) | Production |
|---|---|---|
| Stacks and assembly | five `Ogevia-prod-*`; `cdk synth -c env=prod` | six `Ogevia-prd-*` and no `Ogevia-prod-*`; `cdk synth -c env=prd -c mode=deploy` with the GO reference in `OGEVIA_DEPLOY_APPROVAL` (the stack tags carry it) |
| Environment guard | the Lambda must serve `ogevia_sv_test` | the Lambda of `Ogevia-prd-ServiceVerificationApi` must serve `ogevia_prd` with `OGEVIA_ENV=prd`, checked in `capture` and in every gate |
| **Drift check** (new) | none | `capture` compares production with the recorded baseline (`docs/aws/PRODUCTION_BASELINE_2026-11-01.md`, files in the operator's `~/ogevia-prd-baseline-20261101`): the seven live templates (normalized JSON), the Lambda `CodeSha256`, the route list (228) and the 83 web files. Any difference stops the release |
| **Database marker** (new) | none | `deploy-api` and `web` refuse unless `~/.prd0088/db-at-0088.ok` exists, is for this commit and is less than 12 hours old (written only by `STELLA_PRD_DB.sh migrate` after every check passed) |
| Gate | `diff_gate_0086.py`: 8 routes added | `diff_gate_prd0088.py`: exactly **22** routes added (14 staff, 8 readiness), the Handler code asset, the approval tag; nothing else (IAM, outputs, other Handler properties, other resources) |
| `post-api` | two 401 checks | route diff against the pre-deploy list (250 now; 22 added; 0 removed) and four 401 checks (`/v1/me`, `/v1/compliance/settings`, `/v1/staff`, `/v1/role-permissions`) |
| Web | `deploy-test-slice.sh web`, TEST bundle | `infra/aws/scripts/deploy-production.sh web` (builds `dist-aws-prd`, uploads without delete, invalidates CloudFront); verification checks raw bytes, the commit in the bundle, `VITE_APP_ENV:"production"`, the production API host `zk527zk4ua`, and that `config.json` is unchanged (the build does not produce a `config.json`, so the publish cannot overwrite it) |
| Typed phrases | `DEPLOY-Ogevia-prod-ServiceVerificationApi`, `PUBLISH-WEB`, `ROLLBACK-WEB`, `ROLLBACK-API` | `DEPLOY-PRD-Ogevia-prd-ServiceVerificationApi`, `PUBLISH-WEB-PRD`, `ROLLBACK-WEB-PRD`, `ROLLBACK-API-PRD` |
| Smoke | none | `smoke` mode wraps the read-only `deploy-production.sh smoke` |
| Placeholders | filled from the GO | the same, plus the two asset keys from the assembly; every mode except `selftest` refuses while one remains |
**Tests run (local, no AWS):**
| Test | Result |
|---|---|
| `bash -n`; every non-selftest mode with placeholders present | pass; all ten modes refuse first, before any tool check or AWS call |
| `selftest` with the synthesized production assembly | production gate self-compare passes; the assembly check is skipped until the asset keys are pinned |
| Production assembly (`cdk synth -c env=prd -c mode=deploy`, local, dummy approval reference) | six `Ogevia-prd-*` stacks; Handler asset `9e5a510e...` (the same as the pilot), Identity `7c5f8eb6...`; `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd`; 250 routes |
| `test_gate_prd0088.py` | **GATE TEST PASSED** (9 checks): accepts exactly the 22 routes plus the Handler asset; refuses a route already live, an unexpected added route, an IAM difference, another Handler property, an output difference; accepts a different approval tag value |
| `mock_aws_test_deploy.sh` (stub `aws` and `npx`, fixtures from the production assembly, pseudo-terminal) | **DEPLOY MOCK TEST PASSED** (18 checks): capture passes with no drift; a changed live template, Lambda code, route list or web file each stop it; `check` reports `added: 22 route(s) (the 22 expected)` and `EXPECTED-ONLY: YES`; `deploy-api` and `web` are refused without the marker, with a marker for another commit and with a stale marker, and `cdk deploy` is never called in those cases; with a valid marker and a passing gate a wrong confirmation changes nothing and `cdk deploy` is not called |
**Not tested, and why:** a real `cdk diff` and `cdk deploy`, the real `deploy-production.sh web` and `smoke`, S3 and CloudFront, and the actual shape of the production live template against the gate (the 22-route allow-list assumes production's API stack differs from the assembly only by those routes, the Handler asset and the tag). That last assumption is the main open point: the **read-only production `capture` and `check` modes are the test**, and the gate allow-list is corrected from their output before the GO if production shows any other difference. Those two modes need a fresh read-only approval (they read CloudFormation, Lambda, API Gateway, S3 and CloudFront; they change nothing).
**Next (build order step 3 and 4):** pins file and runbook; then the Phase E package. Then the read-only production dry runs: `STELLA_PRD_DB.sh probe` and `STELLA_PRD_DEPLOY.sh capture` and `check`.

