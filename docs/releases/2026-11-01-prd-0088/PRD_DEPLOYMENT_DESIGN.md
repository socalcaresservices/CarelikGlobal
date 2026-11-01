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
