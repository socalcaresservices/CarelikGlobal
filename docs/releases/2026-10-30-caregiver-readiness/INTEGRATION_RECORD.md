# Integration record: caregiver readiness onto the TEST line (2026-10-31)

**Status: CANDIDATE READY FOR OWNER DECISIONS. The first release candidate (`54894411…`) is SUPERSEDED. New candidate commit: `464dea64cb939c49fbca624b652f34b2863db2f2`. No window, GO or security review of the merge exists yet, so the release is NOT RELEASABLE and nothing may run in AWS. 0088 was numbered 0086 until this integration.**

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

## 7. Results on the integrated tree (candidate `464dea64cb939c49fbca624b652f34b2863db2f2`; local PostgreSQL 16, Node 22.22, nothing in AWS)
| Check | Result |
|---|---|
| `infra/aws` unit suite | 0 failed, 635 passed (31 files) after retiring nine staff operator-package test files (kept in `retired-tests/`) |
| `apps/sv-api` unit / database | 100 of 100 / 156 passed, 2 skipped |
| `apps/web` | 1,266 of 1,266 (130 files) |
| `infra/aws` database suite | 1,049 passed, 61 skipped, **8 failed, the same 8 as on the unmodified TEST line `fb491a5`**: `reservation-lifecycle` (5) and `pending-hours-guards` (1) are month-end sensitive (the suite ran on the last day of the agency month); `prd-deploy-scripts` (2) need database roles this container does not have |
| New integration test `integration-staff-readiness.db.test.ts` | 6 of 6: the ledger holds 88 migrations; staff and readiness objects and permissions coexist; `list_accounts` keeps 0087's invitation-first `account_status` (even for a disabled account) and carries the 0088 readiness columns; access control unchanged |
| Synthesized API stack | 250 routes (228 + 14 staff + 8 readiness); Handler asset `9e5a510e…`; IdentityHandler `7c5f8eb6…` (unchanged) |
| Gate against the TEST line's own synthesized template (242 routes, Handler asset `2871b03d…`, which equals the live asset captured on 2026-10-31) | **`EXPECTED-ONLY: YES`**: 8 routes added, Handler asset changed, nothing else. The other four stacks are identical between the two lines |
| Script trial (pins filled into a scratch copy, not committed) | both scripts' selftests pass, including the pin checks against the candidate checkout |
**Not yet done:** the month-end tests re-run after the agency month rolls over (2026-11-01 07:00 UTC); a security review of the merge; the owner's window, GO reference and signature; the final pins in the committed scripts (`fill_pins.py` after the GO) and `PINS.md`; Stella's rebuild and verification; everything in Phase C and Phase D.

## 8. Operator confirmation (2026-10-31)
Stella Okereke (Operator) reports she stopped at the gate: no deployment, migration, snapshot, API deployment or web publish; security groups at baseline; `~/ogevia-before-0086` retained (it holds the live fb491a5 state captured before the run). She asks to be told when a new approved candidate, hashes, GO and window are ready. Claude has no channel to her: the owner relays. Nothing is to be run in AWS until all four exist.

## 9. Owner message "WINDOW 11/01/2026" (2026-10-31 17:08 PDT / 2026-11-01 00:08 UTC)
The owner indicated a window on **2026-11-01**. No start or end time, no time zone, no GO reference and no signature were given, so this is **not a GO** and no pins are filled. Notes: 2026-11-01 is the day US daylight time ends (02:00 PDT becomes 01:00 PST at 09:00 UTC; the local day has 25 hours), so times must be given with a zone or in UTC. Still open before a window can start: start/end with zone; GO reference; the owner's signed GO (`GO_DRAFT.md` section 8, naming the `adopt` ledger write); a security review of the merged result (`SECURITY_REVIEW_INTEGRATION.md`) or the owner's explicit decision to proceed without it; the month-end test re-run (after 07:00 UTC); final pins (`fill_pins.py`) and Stella's re-verification. 0088 stays NOT RELEASABLE.

## 10. Window and GO reference received (2026-11-01)
Owner: "Window 01:00 to 18:00 PST on 11/02/2026, GO-0088-TEST-20261101". Recorded in `GO_DRAFT.md` section 1 and `PINS.md`; both scripts were filled with `fill_pins.py` (window 2026-11-02 09:00 to 2026-11-03 02:00 UTC); selftests pass on the candidate checkout; both scripts refuse outside the window. **Not recorded because not stated:** the owner's signature on the GO (section 8, which names the `adopt` ledger write) and the decision on the security review of the merge. Phase C may not start until both are given. 0088 stays NOT RELEASABLE.

## 11. GO given; merge review waived (2026-11-01)
Owner: "GO given, proceed without the merge review." Recorded as `DECISION_RECORD.md` A20 (D27), `GO_DRAFT.md` (given as relayed) and `SECURITY_REVIEW_INTEGRATION.md` (waived). Phase C for commit `464dea64…` may start at 2026-11-02 09:00 UTC (01:00 PST) under `GO-0088-TEST-20261101`, by Stella Okereke, after she re-verifies the hashes in `PINS.md` and rebuilds `/tmp`. Still pending, none blocking: the month-end test re-run (after 2026-11-01 07:00 UTC). 0088 stays NOT RELEASABLE.

## 12. Owner clarification: an earlier window was intended (2026-11-01 02:23 UTC)
Owner: the intent was an **earlier** window; asks whether one was considered and, if approved, for an amended GO reference. Facts: the owner's first message was "WINDOW 11/01/2026" (a date, no times); Claude asked for times and a zone because 2026-11-01 is the day US daylight time ends; the owner's next message was "Window 01:00 to 18:00 PST on 11/02/2026, GO-0088-TEST-20261101", recorded as written (A20, `PINS.md`). **No earlier window with times was ever stated or approved.** The GO as recorded (2026-11-02 01:00-18:00 PST) stands until the owner states the amended window and an amended GO supersedes it; nothing has been changed. If the window changes, the pins in both scripts are re-filled (new script hashes in `PINS.md`) and Stella re-verifies them; any relayed message that quotes the Nov 2 window or the hashes `e313673f…`/`29b674bb…` must not be used.
