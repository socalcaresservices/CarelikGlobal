# Integration record: caregiver readiness onto the TEST line (2026-10-31)

**Status: IN PROGRESS. The first release candidate (`54894411…`) is SUPERSEDED. No new candidate SHA, GO or window exists yet. 0088 (formerly "0086" readiness) is NOT RELEASABLE. Nothing here touches AWS.**

## 1. Why
Phase C stopped at its expected-only gate on 2026-10-31 (`TARGET_VERIFICATION_AND_OPEN_ITEMS.md` section 38): the live TEST stack runs a parallel code line, commit `fb491a5` (branch `claude/magical-lovelace-9y5ras`, deployed to demo.ogevia.com (TEST) on 2026-10-29), that adds staff management (14 routes, migrations "0086" and "0087" kept in `infra/aws/db/pending/` and applied outside the ledger). Deploying the first candidate would have removed those routes and screens and overwritten `ogevia_api.list_accounts`.

## 2. Decision (owner, 2026-10-31)
Integrate readiness onto the TEST line. Base of record: `fb491a5`, the commit deployed to TEST, unless a newer **approved** successor exists. None was found: the branch has 24 later commits (deployment records, TEST walkthrough records, two web fixes recorded as "batched for the next TEST package (not deployed)"), but none is an approved release, so `fb491a5` is the base. Resolve migration and function conflicts, build a new release candidate, schedule a new window. The first Phase C release is abandoned.

## 3. What was done (all in git; see the commits on `claude/practical-tesla-r07odb`)
| Step | Result |
|---|---|
| Merge of `fb491a5` into the release branch | one textual conflict (`apps/web/src/aws/care-team.test.tsx`): both lines added a test at the same place; kept the TEST line's "No. column" test and the readiness page test; dropped the TEST line's old `caregiver-outcome` test, which describes the page the readiness release replaces |
| Staff migrations | `0086_staff_management.sql` and `0087_staff_invitation_acceptance.sql` and their down scripts moved (`git mv`, bytes unchanged) from `db/pending/` into `db/migrations/` and `db/rollback/`. Hashes `8eb7b4a3…` and `f9d75d8c…` equal the values the TEST-line operator procedure pinned for the bytes applied to TEST |
| Readiness migration | renumbered **0086 -> 0088** (the runner requires contiguous numbering, and 0086/0087 are the staff migrations) |
| `list_accounts` conflict | both migrations replace it. The 0088 version keeps 0087's `account_status` order (an invited staff member is "invitation pending" before anything else) and adds the readiness columns. The 0088 down script restores it as 0087 left it |
| Other function overlaps | none (function-name comparison of the two migration sets: `list_accounts` only) |
| Tests | rollback chains now go 0088, 0087, 0086, 0085...; head/count constants 86/0086 -> 88/0088; expected permissions +2 (`staff.read`, `staff.manage`); schema table list +2 (`staff_profiles`, `staff_types`); the rollback-class check accepts `ADDITIVE` (the 0087 down script's class); the staff tests that rolled the pending migrations back and forth use the promoted files and roll 0088 back first |
| Retired tests | tests of the TEST line's **operator packages** that assert the pending layout (`operator-prd-sql`, `operator-0087-sql`, and the package tests listed in `infra/aws/retired-tests/README.md`): kept, not deleted, same treatment as owner decision D2 |
| Verification SQL | `01_schema_version.sql` now expects `0088` and 88 migrations |

## 4. The ledger problem and the `adopt` step
TEST's ledger says 85 / `0085`, but the staff objects exist (applied outside the ledger). The runner would try to apply `0086` and fail, and it refuses a numbering gap. The Phase C database script therefore has a new mode, `adopt`, that (1) re-runs the TEST line's own read-only checks (`verify-0086.sql`: 110 checks, `verify-0087.sql`: 24 checks, all must pass), (2) writes two rows into `ogevia_meta.schema_migrations` (`0086_staff_management.sql`, `0087_staff_invitation_acceptance.sql`) with the repository files' checksums, which equal the bytes applied to TEST, and (3) checks the ledger reads 87 / `0087`. After that `db:migrate` applies only 0088. **`adopt` is a data write that no existing authorization covers; the new GO must name it.**

## 5. Expected live difference (for the CDK gate)
Against the live TEST stack (`fb491a5`): exactly the 8 new readiness routes plus the Handler code asset. VERIFIED by diff: the merged tree differs from `fb491a5` in `infra/aws/lib` by 8 lines (the 8 routes), in `apps/sv-api/src/routes.ts` by the readiness routes and the `withClientNames` fix, and the dependency lockfile and package files are identical. Synthesized route count 250 (228 + 14 + 8).

## 6. Failures that exist on the unmodified TEST line (not caused by the integration)
- `reservation-lifecycle` (5 tests) and `pending-hours-guards` (1 test): month-end sensitive (a shift 24 hours ahead falls in the next month when the suite runs on the last day of the agency month, 2026-10-31 PT). Same 6 failures on `fb491a5` in this container today. To be re-run after the month rolls over.
- `prd-deploy-scripts` (2 tests): password authentication to roles the local PostgreSQL does not have (container environment). Same failures on `fb491a5`.

## 7. Still to do before a new release candidate
Finish the unit, API and web suites on the merged tree; set the final pins in `STELLA_PHASE_C_DB.sh`, `STELLA_PHASE_C_DEPLOY.sh` and `diff_gate_0086.py`; rewrite RUNBOOK, run sheet, commands and GO for the new candidate; new security review of the merge (staff and readiness together, `list_accounts`, the `adopt` write); new SHA; owner's window and GO (naming `adopt`).

## 8. Operator confirmation (2026-10-31)
Stella Okereke (Operator) reports she stopped at the gate: no deployment, migration, snapshot, API deployment or web publish; security groups at baseline; `~/ogevia-before-0086` retained (it holds the live fb491a5 state captured before the run and stays useful as the "before" capture). She asks to be told when a new approved release candidate, hashes, GO and window are ready. Claude has no channel to her: the owner relays. Nothing is to be run in AWS until all four exist.
