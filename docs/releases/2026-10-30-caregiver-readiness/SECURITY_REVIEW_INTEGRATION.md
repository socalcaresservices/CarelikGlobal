# Security review addendum: the integration of readiness (0088) onto the TEST line — FILED FOR THE REVIEWER, NOT REVIEWED

**Status: WAIVED BY THE OWNER on 2026-11-01 ("proceed without the merge review", `DECISION_RECORD.md` A20). NOT REVIEWED. Every verdict box stays empty on purpose; nothing here was checked by a reviewer.** The first review (`SECURITY_REVIEW.md`, outcome APPROVED, no findings, relayed 2026-10-31) covered the first candidate (`54894411…`, migration then numbered 0086). That candidate is void. This addendum is the **delta** the reviewer must look at for the new candidate **`464dea64cb939c49fbca624b652f34b2863db2f2`**. Author statements are evidence to check, not conclusions. Reviewer needs no AWS access; everything runs on a scratch local PostgreSQL.

| Field | Value |
|---|---|
| Reviewer (full name, role) | ______________________________ (the owner names the reviewer; the earlier reviewer was also the Operator) |
| Review started / finished | ______ / ______ (with time zone) |

## 1. What did NOT change since the approved review (verify with the commands in section 6)
- Every readiness function, table, grant and policy is byte-identical except the lines in section 2. `git diff` of the readiness migration between the reviewed file and the integrated file is exactly the five hunks below (comment numbering and one `CASE`).
- The 8 new routes and `routes.ts` readiness code: identical to the reviewed code.
- The staff migrations (0086, 0087) and their down scripts are **unchanged bytes**: `git mv` from `db/pending/` to `db/migrations/` and `db/rollback/` (hashes `8eb7b4a3…` and `f9d75d8c…`, equal to what TEST holds). They were reviewed on the TEST line (`SECURITY_REVIEW_0086.md`, `SECURITY_REVIEW_0086_AI_SECOND_READ.md`); they are **not** re-reviewed here beyond how they interact with 0088.

## 2. The delta in the readiness migration (verbatim)
| Where | Before (reviewed, "0086") | After (integrated, "0088") | Why |
|---|---|---|---|
| Header and two comments | `-- 0086 ...` | `-- 0088 ...` | renumbering (0086/0087 are the staff migrations; the runner requires contiguous numbers) |
| `ogevia_api.list_accounts`, column `account_status` | `case when suspended or disabled then 'disabled' when invited or (invitation unsigned) then 'invitation_pending' else 'active'` | `case when m.status = 'invited' then 'invitation_pending' when suspended or disabled then 'disabled' when invitation unsigned then 'invitation_pending' else 'active'` | keeps 0087's order: **a pending staff invitation reads "invitation pending" before anything else**, so the staff screens still work; the readiness columns (`work_status`, `readiness_met`, `readiness_total`, `has_contact`) are the 0088 addition |
| Down script | restored `list_accounts` as 0048 had it | restores it **as 0087 left it** (same `CASE`) | so a 0088 rollback does not undo 0087 |
Function signature, `SECURITY DEFINER`, `search_path = ogevia, pg_temp`, `accounts_manage_guard` and the grants of `list_accounts` are unchanged.

## 3. New write path to review: the `adopt` ledger step (`STELLA_PHASE_C_DB.sh adopt`)
TEST's ledger reads 85 / `0085` while the staff objects exist (applied outside the ledger on 2026-10-29). Before `db:migrate` can apply 0088, the ledger must also record 0086 and 0087.
- **What it writes:** two rows into `ogevia_meta.schema_migrations` (`0086_staff_management.sql`, `0087_staff_invitation_acceptance.sql`) with the repository files' sha256 (constants pinned in the script, equal to the TEST-line procedure's pins). It creates and changes no other object.
- **Preconditions the script enforces (all read-only first):** database is `ogevia_sv_test`; ledger exactly 85 / `0085`; readiness table absent; staff objects present; the TEST line's own checks `verify-0086.sql` (110 rows) and `verify-0087.sql` (22 rows; A25) all `ok`; the working tree is clean at the pinned commit; a verified encrypted snapshot under four hours old; two typed confirmations; inside the authorized window only.
- **Failure behaviour:** one transaction; on error nothing is written. The runner then refuses nothing wrongly: it compares each applied file's checksum with the repository file's (drift detection), so a wrong checksum would stop the next `db:migrate`.
- **Question for the reviewer:** is writing ledger rows for objects that were applied by a different procedure acceptable, given the pinned-bytes check? What residual risk remains if the bytes applied on 2026-10-29 differed (the TEST-line procedure pinned them, and `verify-0086/0087.sql` check the resulting objects)?

## 4. Interactions to review (author evidence below)
| # | Interaction | Author evidence |
|---|---|---|
| 1 | Two migrations replace `ogevia_api.list_accounts` | function-name comparison of the staff files and 0088: `list_accounts` is the **only** overlap; merged version tested by `integration-staff-readiness.db.test.ts` (6 tests: ledger 88; objects and permissions coexist; invited staff reads `invitation_pending` even if disabled; readiness columns present; a manager and another organization are refused) |
| 2 | Permissions | the organization owner holds `staff.read`, `staff.manage`, `readiness.read`, `caregivers.compliance.manage`, `accounts.manage` (same test); the schema and upgrade tests' expected permission sets were updated by +2 (`staff.read`, `staff.manage`) |
| 3 | Catalog on a fresh integrated database (88 migrations) | all **276** `SECURITY DEFINER` functions in `ogevia_api` have a pinned `search_path = ogevia, pg_temp`, no PUBLIC execute, execute for `ogevia_app`, none for `ogevia_readonly` (a query for any exception returned zero rows); the six tables `staff_types`, `staff_profiles`, `caregiver_contacts`, `caregiver_work_approvals`, `caregiver_cpr_tb_extensions`, `organization_compliance_settings` have RLS on and no direct privilege for `ogevia_app`; `ogevia_readonly` can select the three readiness tables (the schema's `readonly_select` pattern) and **not** `caregiver_contacts` or the two staff tables |
| 4 | Rollback | the down scripts run top-down 0088, 0087, 0086 in the upgrade and range-rollback tests; the Phase C `rollback` mode removes 0088 only and leaves the staff objects and their ledger rows |
| 5 | Retired tests | nine staff operator-package unit tests and two DB tests assert the old "pending" layout (and fail by design after the promotion): moved to `infra/aws/retired-tests/` with the reasons and the failure counts before and after (`retired-tests/README.md`); nothing deleted |
| 6 | Pre-existing failures | 8 database tests (month-end and container roles) fail identically on the unmodified TEST line |

## 5. Points the author asks the reviewer to look at hardest
1. The `adopt` write (section 3).
2. The `CASE` order in `list_accounts` (section 2): does putting `m.status = 'invited'` first ever hide a **suspended or disabled** person from an administrator who needs to see them as disabled? (That is 0087's own design; 0088 keeps it, and the test pins it.)
3. Any path in the staff migrations that sets a membership role or permission, in combination with the readiness approvals (can a staff role change approve a caregiver without `caregivers.manage`?).
4. The retired tests: is any retired assertion a security control that is now unchecked?

## 6. Reproduce (scratch local PostgreSQL only; never TEST or production)
```bash
git diff 54894411f0e69ac29bec762006e47f7d943b94f2:infra/aws/db/migrations/0086_caregiver_readiness_approve_for_work.sql 464dea64cb939c49fbca624b652f34b2863db2f2:infra/aws/db/migrations/0088_caregiver_readiness_approve_for_work.sql
sha256sum infra/aws/db/migrations/0086_staff_management.sql infra/aws/db/migrations/0087_staff_invitation_acceptance.sql     # 8eb7b4a3... and f9d75d8c...
export OGEVIA_TEST_DATABASE_URL='postgres://<local admin>:<password>@127.0.0.1:<port>/postgres'
cd infra/aws && npx vitest run --config vitest.db.config.ts db/test/integration-staff-readiness.db.test.ts db/test/caregiver-readiness.db.test.ts db/test/staff-management.db.test.ts
```
Then migrate a scratch database (`OGEVIA_DATABASE_URL=<scratch> pnpm --filter @carelik/infra-aws db:migrate`) and run the catalog queries listed in `SECURITY_REVIEW.md` ("How the facts below were obtained").

## 7. Reviewer findings and sign-off
| # | Section / item | Finding | Severity (Blocker / Major / Minor) | Status |
|---|---|---|---|---|
| | | | | |

| Field | Entry |
|---|---|
| Outcome | ☐ **APPROVED** (every box ticked, or a written justification) ☐ **CHANGES REQUESTED** ☐ **REJECTED** |
| Answers to the questions in sections 3 and 5 | |
| Reviewer signature / date (with time zone) | ______________________________ |
