# Phase C run sheet: caregiver readiness (0088) integrated onto the TEST line (Operator: Stella Okereke) — DRAFT, NOT RUN

**Authority:** `GO_DRAFT.md` (GIVEN, A20; window and reference amended by A22). **TEST/pilot only.** Window **2026-11-01 07:30 UTC to 2026-11-02 02:00 UTC (00:30 PDT to 18:00 PST)**, GO reference **`GO-0088-TEST-20261101-C`** (the owner's; `PINS.md`). **Only approved commit: `464dea64cb939c49fbca624b652f34b2863db2f2`.** Migration **0088 only**, preceded by the ledger step `adopt` for the staff migrations 0086/0087 already on TEST. Exact commands: `PHASE_C_COMMANDS.md`. After the window end **no new deployment activity**; rollback is allowed only to restore known-good.

## What changed since the first attempt (and why this sheet differs)
The first Phase C stopped at its expected-only gate (open items section 38): TEST runs the staff-management line (`fb491a5`), so the first candidate would have removed 14 routes and overwritten `list_accounts`. The release was **integrated onto that line** (`INTEGRATION_RECORD.md`): staff 0086/0087 promoted into the ledger set, readiness renumbered 0088, `list_accounts` merged, new pins, new scripts. TEST's ledger still reads 85 because the staff migrations were applied outside it, hence `adopt`.

## Order of execution
| Step | Action | PASS | STOP if | Capture |
|---|---|---|---|---|
| S0 | Start time; account `300094796789`; admin host `i-0ce8db2d7e5839dd5` running with only `sg-00e01e2ca80442c1f` | all match | any differs | times, groups |
| S1 | Rebuild `/tmp`, hashes against `PINS.md`, selftests, `synth` (`PHASE_C_COMMANDS.md` section 0) | `PASS all checks`; 250 routes; Handler asset as pinned | any hash/commit mismatch | outputs |
| S2 | `probe`: ledger 85/0085, readiness absent, **staff objects present**, 5 of 6, enforcement 0; V7 shows the synthetic Owner | `BASELINE MATCHES`, restore verified | any difference | the output |
| S3 | `capture`, then `check`: the real `cdk diff` and the expected-only gate | exactly 8 routes + Handler asset | anything else (IAM, networking, a removed route, another stack) | full diff text |
| S5 | `snapshot` | `available`, encrypted | not available (do not write) | snapshot id |
| S6a | `adopt`: the TEST line's `verify-0086.sql` (110) and `verify-0087.sql` (24) all ok, then two ledger rows | ledger 87/0087, readiness still absent | any check failing | counts, output |
| S6b | `migrate`: 0088 only | `applied 1, already applied 87`; verify PASS; 88/0088; 5 legacy approvals; staff present | any error or difference | output |
| S8 | `deploy-api` | `POST-API OK`; environment unchanged; 401 on `/v1/me`, `/v1/compliance/settings` | IAM prompt; other stack | stack status, `CodeSha256` |
| S9 | `web` | `WEB VERIFIED` | wrong site; production hostname | served hash |
| S10 | Phase C checks (`RUNBOOK.md` F1-F8) **plus the staff regression check** | each passes | any failure, or any staff page/route that worked before and fails | results |
| S11 | `final` | ledger 88/0088; restore verified | any difference | final counts |
| S12 | UAT fit check | decision recorded | n/a | the decision |

## Stop conditions (stop, change nothing further, report; roll back only if TEST was already changed)
Wrong database or account; commit/hash mismatch; any baseline difference (ledger, readiness table, staff objects, enforcement); the TEST line's staff checks not all ok; a `cdk diff` item outside S3; no verified snapshot; a migration or verify error; a staff route, screen or invitation flow that regresses; a Ready/Active caregiver who cannot be scheduled; any cross-agency read; unexpected 5xx on the new routes; a step with no approved command; the window end reached.

## Rollback
Order web, API, then database (`PHASE_C_COMMANDS.md` section 2); the DB rollback removes 0088 only and leaves the staff objects and their ledger rows. Restoring the snapshot (a new instance) is not authorized.

## Pass / fail
**Phase C PASS** = S0-S11 pass with evidence. **FAIL** = any stop condition. Passing Phase C does **not** make the release releasable: UAT, sign-off and the release record (D7) follow.

## Outputs to return (text, no secrets)
Window times; commit and hashes; the S2 output (with V7); the full `cdk diff`; rollback identifiers; snapshot id; the `adopt` and `migrate` outputs; stack status and `CodeSha256`; web invalidation and served hash; F1-F8 and the staff regression results; final counts and security-group restore proof; deviations with times. Claude records them in `CHECKLIST.md` and a new `DEPLOYED_RECORD_0088_TEST.md` and ticks nothing it was not given.
