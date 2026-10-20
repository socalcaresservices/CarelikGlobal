# Review of the down scripts for 0047-0085

Read-only static review of `infra/aws/db/rollback/` and the repository tests, 2026-10-20. Nothing was executed, no AWS or database access. Purpose: decide whether the rollback rehearsal (R6 of `REHEARSAL_PLAN.md`) is viable and what a production rollback can and cannot restore.

## Findings
| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | All 39 down scripts (0047-0085) exist; none is missing | `rollback.db.test.ts` also asserts "a classified rollback for every migration" | VERIFIED (file list) |
| 2 | Each script is classified in its header: **26 SAFE AUTOMATED, 13 BACKUP REQUIRED** | Header scan. BACKUP REQUIRED: 0055, 0056, 0060, 0063, 0064, 0067, 0068, 0069, 0071, 0072, 0073, 0074, 0077 | VERIFIED |
| 3 | SAFE AUTOMATED means **refuses when records would be lost**, then restores the earlier function definitions. Read in full for 0050, 0053, 0054: each starts with explicit `if exists (...)` checks (visit rules, hour limits, make-up shifts, new caregiver stages, onboarding items, unscheduled reasons, attestation versions) and raises an error if any such row exists | Headers and guards of 0050, 0053, 0054 | VERIFIED for those three; the other 23 not read line by line (INFERRED from the shared header convention) |
| 4 | BACKUP REQUIRED scripts **drop tables or columns with data in them and keep no copy**. No down script in 0047-0085 references an `archived_` table. Examples: 0055 drops the tables holding hire dates, background-check results and hold history; 0073 drops agency deadline settings and issue state; 0074 drops client documents, versions, requirements, holds and preparation stages (evidence files stay in the bucket). 0060 drops the work-hour policy table and says "roll back after 0061 and later". | Headers of 0055, 0060, 0063, 0073, 0074 | VERIFIED for the five read; the rest INFERRED from classification |
| 5 | Whether the BACKUP REQUIRED scripts refuse when data exists was **not established**. The repository's "refuses while data exists" test covers only the 0006-0026 range | `rollback.db.test.ts` lines 89-125 | NOT VERIFIED for 0047-0085 |
| 6 | The down scripts do **not** remove their row from `ogevia_meta.schema_migrations`. The runner does that per file | Ledger removal appears in `rollbacks.ts` (0046 down to 0039), the TEST wrapper's rollback mode (deletes the ledger row per file inside the file's transaction) and the test helper. Running a down script by hand would leave the ledger at 85 while the schema is lower, and a later migration run would skip those files. | VERIFIED |
| 7 | **No in-repo runner covers 0085 down to 0047.** `rollbacks.ts` handles only the readiness release (0046 down to 0039, with archives and a restorable manifest). The TEST wrapper's rollback mode is pinned to 0085 down to 0078 on a 77/0077 baseline. The test helper `runDown` loops over all scripts but is test code | `rollbacks.ts`, `rehearsal-migrate-test.sh` | VERIFIED |
| 8 | The suite proves an **empty-database round trip**: all down scripts, newest first, to zero, then migrate up again | `rollback.db.test.ts` "round-trips an EMPTY database" | VERIFIED (by reading the test; not re-run here) |
| 9 | Which other suites apply or exercise 0047-0085 down scripts on populated data was **not established**. My filename search matched aggregate tests too loosely to say | | NOT VERIFIED |
| 10 | Order is strict: newest first, no skipping (for example 0060 must come after 0061 and later are rolled back) | 0060 header | VERIFIED |

## What a production rollback can and cannot do
- **Before production uses the new features** (the first window, with no tenant data written to the new tables), rolling back 0085 to 0046 should be clean and lossless, and the SAFE AUTOMATED guards would not trigger. This is the case the rehearsal can prove.
- **After real use**, rolling back the 13 BACKUP REQUIRED migrations deletes whatever users entered in the dropped tables (compliance holds, client documents, pick-up requests, export ledger, reconciliations, notifications, and so on) with no archive. The only recovery is a snapshot restore to a **new** instance (shared with TEST), which loses everything written after the snapshot. After real use the correct path is fix-forward.
- A rollback does not restore the **old API/web code**; that is a separate step (Lambda previous asset, web files).
- Restoring the earlier function definitions is exact only if the down scripts embed the right earlier text; the empty-database round trip checks that the sequence runs, not that each earlier definition matches what production had.

## Consequences for the rehearsal plan
1. R6 is viable but needs a **rollback runner for 0085 down to 0047**, modeled on the TEST wrapper: one transaction per file, `set local role ogevia_owner`, per-file timeout, ledger row deleted in the same transaction, pinned rollback-set hash, refusal if the ledger is not contiguous, temporary-rule handling replaced by the rehearsal instance's own security group.
2. On the rehearsal copy the new tables will be empty, so R6 proves syntax, order, ledger handling and (via row counts and hashes) that the schema returns to the R3 baseline. It does **not** prove the SAFE AUTOMATED guards or the data-loss behavior of the BACKUP REQUIRED scripts on populated tables.
3. Recommended addition (local, GREEN, no AWS): a database test that seeds synthetic rows into the guarded tables after 0085 and checks that each SAFE AUTOMATED script refuses and each BACKUP REQUIRED script behaves as its header says. This closes findings 5 and 9 for synthetic data. Not built.
4. Add to the production runbook: "rollback = restore from the snapshot taken at the window start, after any user data has been written; before that, the runner".
