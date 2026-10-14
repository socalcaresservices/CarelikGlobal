# Test evidence matrix: Wave 1 / migrations 0047 to 0052

Date 2026-10-14. **Everything here is LOCAL: an isolated PostgreSQL 16 on this computer, synthetic data, no AWS, no pilot, no production.** Local success is not live success. Raw outputs were captured under `/tmp/final-evidence/` in the session and are not committed; the commands and counts below are what they showed.

**Commits.** Phase A and B ran in a clean worktree at `4bf3a7d29b9aa6c4237bb1a8134ea9daaecc558c` (the behavior under test: `main` `484135d` plus the three test additions of this assignment). The next commit, `e640f8bcf56bc9647ab650974d8961a1c435cccf`, changes only `infra/aws/slice/smoke.py` (route count). `test:all` was **not** re-run on `e640f8b`; `slice-contract.test.ts` (which reads `smoke.py`; 27 passed) and every smoke/regression run in section C **were** run on `e640f8b`/the commit after it (documentation only). The Python script is not covered by lint, typecheck or build. Application code, migrations and API are identical between `63de403` and `484135d` (git diff: documentation and `smoke.py` only), so the Phase A result on `63de403` (`docs/releases/2026-10-13-wave1/CHECKLIST.md`) remains valid evidence for that code.

## A. Development gates (G1 to G3)
| # | Command | Commit | Exit | Passed | Failed | Skipped | Notes |
|---|---|---|---|---|---|---|---|
| A1 | `pnpm install --frozen-lockfile` | `4bf3a7d` | 0 | n/a | n/a | n/a | |
| A2 | `pnpm lint` | `4bf3a7d` | 0 | 6 of 6 tasks | 0 | n/a | |
| A3 | `pnpm typecheck` | `4bf3a7d` | 0 | 7 of 7 tasks | 0 | n/a | |
| A5 | `pnpm build` (web build included) | `4bf3a7d` | 0 | 6 of 6 tasks | 0 | n/a | Turbo warns "no output files" for the infra-aws and sv-api builds: pre-existing warning |
| A4 | `pnpm test:all` step 1, unit and static, every workspace | `4bf3a7d` | 0 | 1,312: shared 118, auth 138, sv-api 67, ui 73, infra-aws 124, web 792 | 0 | 0 | web 95 files; includes the 220-character copy cap, contrast, route-contract and migration static tests |
| A6 | `test:all` step 2, database tests (`@carelik/infra-aws test:db`) | `4bf3a7d` | 0 | 561 (58 files) | 0 | **0** | Includes migration tests, **rollback tests** (`rollback`, `readiness-rollback`, `rollback-keeps-records`, `availability-rollback`) and the new upgrade rehearsal |
| A7 | `test:all` step 3, API tests (`@carelik/sv-api test:db`) | `4bf3a7d` | 0 | 75 (5 files) | 0 | **0** | |
| A8 | `test:all` summary | `4bf3a7d` | 0 | "PASS all suites ran, none skipped, all passed" | 0 | 0 | The script fails on any skipped test |
| A9 | Counts did not drop | | | DB 560→561, API 74→75, unit unchanged, versus `63de403` | | | Yes |
| A10 | `slice-contract.test.ts` | `e640f8b` | 0 | 27 | 0 | 0 | Run separately after the `smoke.py` change |

## B. Local harness (G4)
| # | Command | Commit | Exit | Result |
|---|---|---|---|---|
| B1 | `harness:setup` (fresh database, migrations 0001 to 0052, seed: 7 clients, 17 shifts, 12 visits) | `4bf3a7d` | 0 | database ready |
| B2 | `harness:build` | `4bf3a7d` | 0 | web build ready |
| B3 | `harness:smoke` | `4bf3a7d` | 0 | 45 checks, 45 passed, 0 failed |
| B4 | Persona walkthrough (VIS/SCH rows by person) and screenshots on this SHA | | | **NOT DONE** on this SHA (Blocker B-11). Screenshots exist from the Wave 1 branch (`docs/releases/2026-10-13-wave1/screenshots/`, 16 images) and #89 (`2026-10-14-ui-simplification/screenshots/`). |

## C. Script suites in their LOCAL modes
| # | Command | Commit | Exit | Result |
|---|---|---|---|---|
| C1a | `smoke.py --mode local` (workflow incl. unscheduled, scheduled clean-signed, care workflow with seed 03) | `e640f8b` code | 0 | 79 checks, 79 passed, 0 failed |
| C1b | same, second run on the same database (re-run safety) | same | 0 | 79 of 79 |
| C2 | `pilot_smoke.py` against a database seeded like the pilot | same | 0 | 11 pilot checks, 11 passed |
| C3 | `pilot-regression-local.sh` (`pilot_regression.py --mode local`) | same | **3** | 35 cases passed, 0 failed, **1 could not run: SMK-06 (HTTPS authorizer)**, because no `--api-url` is given locally. Exit 3 is the runner's documented result for a case that could not run; **a gate needs exit 0**, which is only possible in Phase C with `--api-url`. A skipped case is not a pass. |

## D. New coverage added in this assignment (only where a gap was verified)
| ID | Gap found | Test | Where | Result |
|---|---|---|---|---|
| D-03 | No single test of the clean scheduled path through the API with accounting (existing tests covered the status, the reservation release and the accounting in separate pieces) | "clean scheduled visit: signed, Billing Ready, no review reason, reserved becomes used once, authorization left unchanged": caregiver sees only the assigned client and its authorized service; reserve 90, remaining 510; start links the shift; end; draw signature; `signed`, billable = worked, no review reasons, `attest-v1`; reserved 0, used = worked, remaining 600 − worked; billing review "ready"; retry returns the identical result and balance | `apps/sv-api/test/accounting.db.test.ts` | pass (in A7) |
| D-03b | `smoke.py` had no scheduled clean-signed step | `scheduled` workflow, 14 checks, including reserved/used/remaining deltas and billing review "ready" | `infra/aws/slice/smoke.py` | pass (C1) |
| D-05 | No upgrade test with existing visit data across 0050 to 0052 (the 0046-to-0048 rehearsal has no visits) | database at 0049 with a signed visit, a review visit and an old-style unscheduled signed visit upgraded by the real runner | `infra/aws/db/test/upgrade-0049-to-0052.db.test.ts` | pass (in A6) |
| D-04 | `smoke.py` expected exactly 38 routes (handler has 169) | count derived from `routes.ts` | `smoke.py` | verified by import (169) and A10 |

## E. Regression coverage of migrations 0047 to 0052 (existing tests; reviewed for gaps, nothing duplicated)
| Area | Covered by (all pass in A6/A7) | Gap |
|---|---|---|
| Scheduling | `shifts`, `shift-series`, `overnight-availability`, `dst-local-times`, `wave1-pickup` (12) | none found |
| Authorization accounting | `authorization-accounting-risks`, `authorization-single-bucket` (9, 0052), `remaining-hours`, API `accounting` (now 2) | none found |
| Reserved versus used | `authorization-single-bucket`, `visit-shift-link` (reservation released on signing, held in review) | none found |
| Visit confirmation | `signature-recovery`, `signature-correction-idempotency`, `wave1-visit-review`, API `workflow` | none found |
| Unscheduled visits | `wave1-visit-review`, API `wave1`, `smoke.py` | none found |
| Administrator review | `visit-review`, `wave1-visit-review`, `approved-visit-correction` | VIS-26 (grouping/filter by reason) not built; VIS-54 (correction re-evaluation) not built: see Blocker B-12 |
| Open-shift pickup | `wave1-pickup`, API `wave1` | none found |
| Caregiver permissions | `access-roles`, `enforcement-matrix`, `readiness-gate`, API `workflow`, `readiness` | none found |
| Tenant isolation | `tenant-assignment-visit`, `access-roles`, `wave1` (agency-scoped), API `workflow` (cross-tenant, forged claims) | none found |
| Duplicate submissions and retries | `wave1-visit-review` (retried start), `signature-correction-idempotency`, `wave1-pickup` (idempotent claim), API `workflow` (parallel confirmations, same key) | none found |
| 0047 / 0048 / 0049 | `availability-approval`, `visit-start-availability`, `account-status`, API `accounts`, `upgrade-0046-to-0048`, `authorization-accounting-risks` | none found |

## F. Not run (and why)
| Item | Reason |
|---|---|
| Any command against the AWS pilot, AWS production or Netlify | No AWS CLI, credentials or tunnel in this session; Netlify not reachable; the directive forbids deployment and live changes |
| `smoke.py` AWS mode, `pilot_regression.py --mode aws`, SMK-06 live | Need the pilot (Phase C) |
| Real RDS engine version, CloudFront, Cognito/MFA, KMS/S3, IAM | Not provable locally (runbook section 1 and 6) |
| Real phone, slow network, screen reader, airplane-mode retry (VIS-32/33/41) | Phase D |
| `deploy-production.sh check` | Production-only script; not run |
