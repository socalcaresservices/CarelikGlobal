# Test evidence matrix: Wave 1 / migrations 0047 to 0052

Date 2026-10-14. **Everything here is LOCAL: an isolated PostgreSQL 16 on this computer, synthetic data, no AWS, no pilot, no production.** Local success is not live success. Raw outputs were captured under `/tmp/final2/` in the session (not committed); the commands and counts below are what they showed.

## 0. Which commit each result applies to
| Commit | What it is | Results that apply |
|---|---|---|
| `63de403` | Merge of PR #87: the Wave 1 application code, migrations 0047 to 0052, API, infrastructure | Phase A of `docs/releases/2026-10-13-wave1/CHECKLIST.md` (earlier run) |
| `484135d` (`main`) | `63de403` plus documents and `smoke.py` only (git diff: 4 files) | Application code identical to `63de403` |
| `4bf3a7d` | `main` plus three new tests and the `smoke.py` scheduled workflow | The first run of this assignment (`test:all` 1,312 unit, 561 database, 75 API) |
| **`3f057a3f93e3412dd5bbca8683881375a7c05fce`** | **Final code candidate.** `4bf3a7d` plus the `smoke.py` route-count change, the read-only preflight script and probe, and their guard test. | **Every result in sections A to C below** (clean worktree, fresh `pnpm install --frozen-lockfile`) |
| branch HEAD (documents) | `3f057a3` plus documents, evidence and the rollback SQL only. Proven by `git diff --stat 3f057a3 HEAD`: only `docs/` paths. | Equivalent to `3f057a3` for code; the documents describe the results |
An earlier run at `4bf3a7d` is **not** reported as a test of `3f057a3`: the whole suite was re-run on `3f057a3` itself (it also caught a strict type error in the new guard test that the earlier run could not have caught, fixed in `3f057a3`).

## A. Development gates (G1 to G3), commit `3f057a3`
| # | Command | Exit | Passed | Failed | Skipped | Notes |
|---|---|---|---|---|---|---|
| A1 | `pnpm install --frozen-lockfile` | 0 | n/a | n/a | n/a | |
| A2 | `pnpm lint` | 0 | 6 of 6 tasks | 0 | n/a | |
| A3 | `pnpm typecheck` | 0 | 7 of 7 tasks | 0 | n/a | |
| A5 | `pnpm build` (web build included) | 0 | 6 of 6 tasks | 0 | n/a | turbo "no output files" warnings for infra-aws and sv-api: pre-existing |
| A4 | `pnpm test:all` step 1, unit and static, every workspace | 0 | **1,319**: shared 118, auth 138, sv-api 67, ui 73, infra-aws **131** (+7: the preflight guard), web 792 | 0 | **0** | |
| A6 | `test:all` step 2, database tests | 0 | **561** (58 files) | 0 | **0** | includes migration, rollback and upgrade tests |
| A7 | `test:all` step 3, API tests | 0 | **75** (5 files) | 0 | **0** | |
| A8 | `test:all` summary | 0 | "PASS all suites ran, none skipped, all passed" | | | |
| A9 | Counts did not drop versus `63de403` | | | | | unit 1,312→1,319, database 560→561, API 74→75: yes |

## B. Local harness (G4) and the persona walkthrough
| # | Command | Commit | Exit | Result |
|---|---|---|---|---|
| B1 | `harness:setup` (migrations 0001 to 0052; 7 clients, 17 shifts, 12 visits) | `3f057a3` | 0 | ready |
| B2 | `harness:build` | `3f057a3` | 0 | built |
| B3 | `harness:smoke` | `3f057a3` | 0 | 45 checks, 45 passed, 0 failed |
| B4 | **Phase B persona walkthrough**: Chromium drives the real screens as Administrator, Scheduler, Manager (1280 px) and two Caregivers (390 px touch) against the real handler and a local database; results confirmed in the database | application code of `3f057a3` (identical to `484135d`) | 0 | **53 checks, 53 passed, 0 failed**; 37 files of evidence; details, persona mapping and limits in `evidence/PHASE_B_WALKTHROUGH.md` |

## C. Script suites in their LOCAL modes, commit `3f057a3`
| # | Command | Exit | Result |
|---|---|---|---|
| C1a | `smoke.py --mode local` (workflow incl. unscheduled, scheduled clean-signed, care workflow with seed 03) | 0 | 79 checks, 79 passed, 0 failed |
| C1b | same, second run on the same database (re-run safety) | 0 | 79 of 79 |
| C2 | `pilot_smoke.py` on a database seeded like the pilot | 0 | 11 of 11 |
| C3 | `pilot-regression-local.sh` (`pilot_regression.py --mode local`) | **3** | 35 cases passed, 0 failed, **1 could not run: SMK-06** (HTTPS authorizer needs `--api-url`, which only exists in Phase C). Exit 3 is the runner's documented result; **a gate needs exit 0**. A case that could not run is not a pass. |
| C4 | `pilot_preflight_probe.py` rehearsed against a local database through the local invoker | 0 | generation 0051 detected; seed 03: TEST-CG-02 found, 7 windows. Also rehearsed on a database rolled back to 0049: 0050 and 0051 reported missing (not part of the final run) |
| C5 | Database rollback rehearsal `rollback-0047-0052.sql` on a local database | n/a | 0052 to `46|0046`; re-applied `applied 6, already applied 46`, `db:verify` 0 FAIL. After Wave 1 use (a database that had run the smoke): stops with `ROLLBACK REFUSED: visit rule evaluations exist` and ledger `50|0050`, as designed |

## D. New coverage added across this work (only where a gap was verified)
| ID | Gap | Test | Where | Status |
|---|---|---|---|---|
| D-03 | No single test of the clean scheduled path through the API with accounting | clean scheduled visit: signed, Billing Ready, no review reason, reserved becomes used once, authorization left unchanged, retry-safe | `apps/sv-api/test/accounting.db.test.ts` | pass (A7) |
| D-03b | `smoke.py` had no scheduled clean-signed step | `scheduled` workflow, 14 checks | `infra/aws/slice/smoke.py` | pass (C1) |
| D-05 | No upgrade test with existing visit data across 0050 to 0052 | populated 0049 database upgraded by the real runner; no row changes; old visits readable | `infra/aws/db/test/upgrade-0049-to-0052.db.test.ts` | pass (A6) |
| D-04 | `smoke.py` expected 38 routes; the handler has 169 | count read from `routes.ts` | `smoke.py` | pass (import, `slice-contract` 27) |
| D-11 | The read-only preflight could gain a write unnoticed | static guard: only describe/list/get/head `aws` verbs; no write, secret, invoke, database, deploy or out-of-folder write; GET-only probe | `infra/aws/test/pilot-preflight.test.ts` (7 tests) | pass (A4); shown to fail when a snapshot call and an out-of-folder write are injected |

## E. Regression coverage of migrations 0047 to 0052 (existing tests reviewed; nothing duplicated)
| Area | Covered by (all pass in A6/A7) | Gap |
|---|---|---|
| Scheduling | `shifts`, `shift-series`, `overnight-availability`, `dst-local-times`, `wave1-pickup` (12) | none found |
| Authorization accounting | `authorization-accounting-risks`, `authorization-single-bucket` (9), `remaining-hours`, API `accounting` (2) | none found |
| Reserved versus used | `authorization-single-bucket`, `visit-shift-link` | none found |
| Visit confirmation | `signature-recovery`, `signature-correction-idempotency`, `wave1-visit-review`, API `workflow` | none found |
| Unscheduled visits | `wave1-visit-review`, API `wave1`, `smoke.py` | none found |
| Administrator review | `visit-review`, `wave1-visit-review`, `approved-visit-correction` | **VIS-54: a manager's correction of an unscheduled visit comes out `signed` with no reason (no test covers it; behavior verified in the smoke database). Blocker B-12.** VIS-26 not built |
| Open-shift pickup | `wave1-pickup`, API `wave1` | none found |
| Caregiver permissions | `access-roles`, `enforcement-matrix`, `readiness-gate`, API `workflow`, `readiness`; walkthrough negative checks | none found |
| Tenant isolation | `tenant-assignment-visit`, `access-roles`, `wave1`, API `workflow`; not repeated in the walkthrough (one agency) | none found |
| Duplicate submissions and retries | `wave1-visit-review`, `signature-correction-idempotency`, `wave1-pickup`, API `workflow`; not driven through the browser | none found |
| 0047 / 0048 / 0049 | `availability-approval`, `visit-start-availability`, `account-status`, API `accounts`, `upgrade-0046-to-0048`, `authorization-accounting-risks` | none found |

## F. Not run (and why)
| Item | Reason |
|---|---|
| Any command against the AWS pilot, AWS production or Netlify | No AWS CLI, credentials or tunnel; Netlify not reachable; deployment and live changes are forbidden |
| `pilot-preflight-readonly.sh` itself against AWS | It needs CloudShell. Its static guard and the probe rehearsal passed locally; the first AWS run is the first proof |
| `smoke.py` AWS mode, `pilot_regression.py --mode aws`, SMK-06 live | Phase C |
| Real RDS engine version, CloudFront, Cognito/MFA, KMS/S3, IAM | Not provable locally |
| Real phone, slow network, airplane-mode retry (VIS-32/33/41) | Phase D |
| Duplicate-tap and two-simultaneous-claims in the browser | Covered by the database and API suites (two connections) |
