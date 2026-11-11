# TEST-only deployment plan: UX redesign (PREPARED, NOT AUTHORIZED, NOT RUN)

**Nothing in this plan has been run. Phase C does not start until the owner gives the written statement in section 1.** Production (`Ogevia-prd-*`, `ogevia_prd`) is out of scope for every step. "prod" in `Ogevia-prod-*` names means the TEST stacks.

## 1. What the owner must state in writing (the Phase C statement)
| Field | Value |
|---|---|
| Release commit (full 40 characters) | **Proposed: `7f9483d39690ae94db2710465d6995cd0b82b271`** (branch `claude/ogevia-ux-audit-redesign-w36cov`). It contains: the redesign, pending migrations 0090 to 0094 (files only), the TEST switches ON, the dependency overrides (`a709eb1`) and the route-parity test fix. CI run 431: success (validate, harness, postgres). Commits made after it are documents only and are NOT deployed (check out this SHA exactly). If the owner drops any piece, the SHA changes and CI must be read again. |
| Target | TEST only: stacks `Ogevia-prod-*`, database `ogevia_sv_test` (banner "TEST — synthetic data only") |
| Operator (who runs the commands) | **To be named by the owner.** Claude Code cannot run AWS commands. (The 0088 release used a named operator; do not assume the same person.) |
| Window | To be stated by the owner (start and end, Pacific). Avoid the daily demo hours; the seed script refuses to run after 21:00 Pacific |
| Security | Owner decision on SEC-3 (`SEC-3_EXCELJS_ADVISORIES.md`) and SEC-5; sign-off line in `SECURITY_AND_COMPATIBILITY_REVIEW.md` |

## 2. Before anything is run (read-only; Claude can prepare, the operator runs)
CloudShell in **us-west-2**, signed in to account 300094796789. Commands and what they prove: `docs/aws/DEMO_AUTODEPLOY_READONLY_CHECKS.md` (U1 database instances, U2 admin-host role, U3 hosting stacks, bucket and distribution ids, U4 GitHub minutes). Results must show: account matches; **U1**: the instance that holds `ogevia_sv_test` (expected `ogevia-prod-postgres`, shared with `ogevia_prd`), private, backups on; **U3**: the TEST web bucket and distribution are **not** the production ones; **U2**: the admin host is running with only the expected security group. Any surprise: stop and report.

## 3. Pins and toolchain (not yet generated)
The previous release used a pinned toolchain (`PINS.md`, `PHASE_C_COMMANDS.md`, `infra/aws/slice/candidate-pin-check.sh` with `OGEVIA_EXPECT_COMMIT`, migrations hash and lockfile hash). Those files belong to the older candidate and **must be regenerated for the commit above**. I will generate them after authorization; running without them is not allowed by this plan.

## 4. Order of execution (each step has a stop condition; stop means change nothing further and report)
| Step | Action (operator) | Expected | Stop if |
|---|---|---|---|
| S0 | Record start time; account 300094796789; admin host `i-0ce8db2d7e5839dd5` running with only `sg-00e01e2ca80442c1f`; clean checkout of the exact commit; pin check passes | all match | anything differs |
| S1 | Rebuild and run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`; `cdk synth` for the TEST stacks | exit 0 each; route count = previous + 5 | any failure |
| S2 | Read-only probe of `ogevia_sv_test`: `select current_database()` equals `ogevia_sv_test`; `select count(*), max(version) from ogevia_meta.schema_migrations` | `88 / 0088`; objects of 0090 to 0094 absent | database name differs, or any pending object already exists |
| S3 | `cdk diff` for `Ogevia-prod-ServiceVerificationApi` | **only** 5 new routes (2 override, 1 import, 2 duplicates) and the Handler code asset | IAM, networking, a removed route, another stack |
| S4 | **Backup:** `aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier ogevia-prod-postgres-pre-ux-<yyyymmddThhmmZ>` then `aws rds wait db-snapshot-available` (instance name to be confirmed by U1). Rollback inputs: current API `CodeSha256` (`aws lambda get-function --function-name <TEST handler> --query Configuration.CodeSha256`), and a copy of the live TEST web files (`aws s3 sync s3://<TEST web bucket> ~/ogevia-before-ux`) | snapshot `available` and encrypted; hash and web copy saved | snapshot not available (do not continue) |
| S5 | **Migrations, in this order, one at a time, as `ogevia_owner`, to `ogevia_sv_test` only**, each as `psql -v ON_ERROR_STOP=1 -1 -d ogevia_sv_test -c "set role ogevia_owner" -f infra/aws/db/pending/migrations/<file>`: **0090_caregiver_signin_override, 0091_caregiver_client_labels, 0092_bulk_import, 0093_staff_duplicates, 0094_standard_document_types** (they are outside the ledger, like 0086 was; no ledger row is written) | each returns without error; then verification queries (section 6) all pass | first error: stop; run the matching rollback of everything already applied, newest first |
| S6 | Deploy API: the same `deploy-api` procedure as `docs/releases/2026-10-30-caregiver-readiness/PHASE_C_RUN_SHEET.md` S8 | stack `UPDATE_COMPLETE`; new Handler `CodeSha256`; `POST-API OK` | IAM prompt, other stack |
| S7 | Deploy web: `OGEVIA_RELEASE_COMMIT=<commit> bash infra/aws/slice/test-web-release.sh` (read its header for the exact arguments; it stamps `VITE_APP_VERSION` and refuses production) | `WEB VERIFIED`; served `VITE_APP_VERSION` equals the commit | wrong site, production hostname |
| S8 | Seed the demo day: `psql ... -f infra/aws/db/deploy/07_seed_ux_demo_visits.sql -v org_slug=<slug> -v caregiver_code=<code>` | refuses any database other than `ogevia_sv_test`; creates 2 synthetic visits for today | refuses, or touches another agency |
| S9 | Validation (section 6) | all PASS | any FAIL |
| S10 | Final read-only probe and the record of results | ledger still 88/0088; new objects present | any difference |

## 5. Rollback (any layer; newest first; nothing is deleted by hand)
1. **Web:** `aws s3 sync ~/ogevia-before-ux s3://<TEST web bucket> --delete` then invalidate the TEST distribution (same procedure as `test-web-release.sh` rollback).
2. **API:** redeploy the previous template/commit (`CodeSha256` from S4); the five routes disappear.
3. **Database (only after the snapshot exists):** `psql ... -f infra/aws/db/pending/rollback/<file>` in this order: **0094, 0093, 0092, 0091, 0090**. Classes: 0094 SAFE (removes only the CPR/TB types it created and no document uses), 0093 BACKUP REQUIRED (drops the link table; merged profiles stay inactive, set them active in Staff), 0092 BACKUP REQUIRED (drops the batches table; imported records stay), 0091 SAFE, 0090 BACKUP REQUIRED (drops the override table; caregivers approved by override then read "invited, has not signed in" again until they sign in).
4. **Never** restore the shared instance from the snapshot without a separate owner decision: it also holds production data.
Records created during testing (imports, merges, overrides) are corrected through the product, not deleted.

## 6. Validation steps (S9)
Database (read-only SQL): functions `approve_signin_override`, `list_signin_overrides`, `list_assigned_visit_clients` (has `display_label`), `list_open_shifts` (has `city`), `import_rows`, `list_possible_duplicate_staff`, `merge_staff_profiles`, `ensure_standard_document_types` exist; tables `caregiver_signin_overrides`, `import_batches`, `staff_merge_links` exist with row-level security on; no `PUBLIC` execute on any of them; ledger still 88/0088.
API: `infra/aws/slice/smoke.py` and `pilot_smoke.py`; `pilot_regression.py --mode aws --i-am-targeting-the-pilot --commit <sha> ...` must exit **0** (this also runs SMK-06, the unauthenticated 401 check that could not run locally); 401 without a token and with a forged token on each of the five new routes.
Feature cases that need the deployed TEST environment: **UXR-08c, UXR-09b, UXR-19 (cold start), UXR-21, UXR-23**, plus the TEST parts of UXR-01 to UXR-16 (each role opens every menu item with no error screen) and the owner items UXR-14c, UXR-22.

## 7. After the run
Return text results (no secrets) to the owner: ledger before and after, snapshot id, `CodeSha256` before and after, route count, regression exit code, case results. The owner decides UAT (Phase D) and any later production step. **This plan never authorizes production.**
