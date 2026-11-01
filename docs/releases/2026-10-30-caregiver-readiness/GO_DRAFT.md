# GO for Phase C: caregiver readiness (migration 0088) integrated onto the TEST line — TEST slice only

**Status: GIVEN AS RELAYED 2026-11-01 (owner: "GO given, proceed without the merge review"; `DECISION_RECORD.md` A20). Window 2026-11-02 01:00-18:00 PST, GO reference `GO-0088-TEST-20261101`. NOT RUN YET.** The signature cells in section 8 are not filled by hand: the owner's statement is the record, as with the first GO. The security review of the merge is WAIVED by the owner; it was not performed. Claude drafted it; the owner decides it. It replaces the first GO (`GO_SUPERSEDED_first_candidate_54894411.md`, void: Phase C stopped at its gate). Production is out of scope. The release stays NOT RELEASABLE until Phase C, UAT and the release record are complete (D7).

## 1. Blanks only the owner can fill
| Item | Entry |
|---|---|
| Window start (date, time, time zone) | **2026-11-02 01:00 PST** (= 2026-11-02 09:00 UTC), as the owner wrote it |
| Window end (hard stop for new activity; rollback to known-good only afterwards, per A12) | **2026-11-02 18:00 PST** (= 2026-11-03 02:00 UTC) |
| GO reference (6-64 characters of A-Za-z0-9._-; the scripts require this exact value) | **`GO-0088-TEST-20261101`** |

## 2. Scope this GO covers (and nothing else)
| Item | Value |
|---|---|
| Environment | The existing **TEST/pilot slice**: CDK `-c env=prod`, stacks `Ogevia-prod-*`; database **`ogevia_sv_test`** on RDS `ogevia-prod-postgres` (account `300094796789`, `us-west-2`). **Never** `Ogevia-prd-*` or `ogevia_prd`. |
| Code (only approved deployment commit) | **`464dea64cb939c49fbca624b652f34b2863db2f2`** on `claude/practical-tesla-r07odb`: the readiness release merged onto the TEST line `fb491a554c0fdc484102025179c9c993f694b4e0` (what TEST runs today). Later commits may only touch documents and the two Phase C scripts; the Operator re-runs the deployable-paths diff first and expects no output (`PHASE_C_COMMANDS.md` section 0). |
| Migrations | **0088** `0088_caregiver_readiness_approve_for_work.sql` is the only migration applied. The staff migrations **0086** and **0087** are already on TEST (applied outside the ledger on 2026-10-29); they are only **recorded in the ledger** (the `adopt` step, section 3 step 5). |
| Live difference expected | exactly 8 new readiness routes plus the Handler code asset on `Ogevia-prod-ServiceVerificationApi`; 14 staff routes unchanged; the web bundle (readiness screens added, staff screens untouched). |
| Operator | **Stella Okereke** only. |
| Starting state (VERIFIED by Phase C Part 2 and `capture`) | ledger 85 / `0085`; staff objects present; readiness objects absent; 5 of 6 caregivers Ready/Active; enforcement empty in all four organizations; live Lambda `CodeSha256` `VFN/cMO326y63xaTOQERNhyvp+mHC19EM3/xN4IWeE4=`. |

## 3. Authorized actions, in this order (the Operator follows `PHASE_C_COMMANDS.md`)
1. **Rebuild and verify locally** (`/tmp` checkouts, install, selftests, `synth`): no AWS change.
2. **Re-probe, read-only** (`probe`): must match the starting state. Any difference: STOP.
3. **Real `cdk diff`** (`capture`, `check`): must show **only** the 8 routes and the Handler asset. Anything else: STOP.
4. **One manual RDS snapshot**, verified `available` and encrypted. Without it, do not write to the database.
5. **`adopt`: record the staff migrations in the ledger.** After the TEST line's own read-only checks pass (`verify-0086.sql` 110 rows, `verify-0087.sql` 24 rows, all ok), **two rows are inserted into `ogevia_meta.schema_migrations`** (`0086_staff_management.sql`, `0087_staff_invitation_acceptance.sql`) with the checksums of the repository files, which equal the bytes already applied to TEST (pinned in the TEST-line procedure). No object is created or changed. Expected afterwards: ledger 87 / `0087`. **This is a data write that no earlier authorization covered.**
6. **`migrate`: apply 0088 only** (`applied 1, already applied 87`), `db:verify`, then the post-state check: ledger 88 / `0088`, 5 `legacy_status` approvals, 5 of 6 unchanged, enforcement still empty, staff objects present.
7. **Deploy the API stack** (the one gate-checked stack), then **publish the web bundle**, then their post-checks.
8. **Phase C checks** (`RUNBOOK.md` F) with **synthetic data only**, including that the staff screens and routes still work (staff list, staff types, invite, accounts).
9. **Phase D UAT** only if all validators can finish before the window ends; otherwise stop after Phase C and request a separate UAT window and GO.
10. **Rollback**, if a stop condition occurs after step 5: web, API, then the database (`rollback` mode removes 0088 only; the staff objects and their two ledger rows stay), solely to restore known-good, allowed after the window end (A12). Restoring the RDS snapshot creates a new instance and is **not** covered.

**Access for steps 2, 5, 6 and 10:** the temporary attach of AppSG `sg-064ffce3bcbe8eb3b` to `ogevia-db-admin-temp` (restored and re-checked), and the existing TEST database admin credential in memory only, on `ogevia_sv_test` only, within the window (rollback: as step 10 says). Full TLS verification through the tunnel; no fallback.

## 4. Not authorized
Production in any form; enforcement activation; any other migration, ledger row or code; Cognito settings or non-synthetic users; security groups or IAM beyond what the diff shows; starting or stopping the admin host; deleting snapshots or data; anything after the window end except rollback; merging to `main`; real-person data; restoring the snapshot; reusing the Part 2 script.

## 5. Stop conditions
`current_database()` not `ogevia_sv_test`; commit diff not empty; ledger, readiness-table, staff-object or enforcement state different from section 2; `verify-0086.sql`/`verify-0087.sql` not all ok; a `cdk diff` item outside section 3 step 3; no verified snapshot; a migration or verify error; a staff route, screen or sign-in flow that worked before and fails after; a caregiver Ready/Active before who cannot be scheduled; any cross-agency read; unexpected 5xx on the new routes; the window end is reached.

## 6. What this GO does not change
It does not make the release releasable or production-approved. Production (Phase E) is separate, and now includes shipping the staff migrations 0086/0087 together with 0088 as ordinary ledger migrations.

## 7. Preconditions still open when this draft was written
| Precondition | State |
|---|---|
| Unit, API, web and database suites on the integrated tree | passed except 8 DB tests that also fail on the unmodified TEST line (6 month-end, 2 environment); month-end re-run after the month rolls over: see `INTEGRATION_RECORD.md` |
| Security review of the merged result (staff + readiness, `list_accounts`, the `adopt` write) | **WAIVED by the owner 2026-11-01** (not performed; `SECURITY_REVIEW.md` covered the void first candidate only) |
| Owner's window and GO reference | **given 2026-11-01** (section 1) |
| Owner's signature on this GO (naming the `adopt` ledger write) | **given 2026-11-01** (relayed text, name not restated; A20) |
| Script pins filled (`fill_pins.py`) | **done** (`PINS.md`); Stella's re-verification of the hashes: **open** |
| UAT accounts (Managers of both organizations, a Caregiver, the synthetic Owner in `scs-pilot-synthetic`) | decided (D22-D25); confirmed by V7 at `probe` |

## 8. Owner's GO (unsigned)
> I authorize the Operator, Stella Okereke, to carry out section 3 on the TEST/pilot slice only, within the window in section 1, at commit `464dea64cb939c49fbca624b652f34b2863db2f2`, including the `adopt` ledger write, and subject to sections 4 and 5. This GO expires at the window end (rollback to known-good excepted).

| Field | Entry |
|---|---|
| Owner (full name) | not restated in the message (see A20) |
| Signature | "GO given", typed, relayed in the conversation; not a system or wet signature |
| Date and time (time zone) | 2026-11-01 (time of the statement not given) |

| Operator acknowledgement | Entry |
|---|---|
| Stella Okereke | not yet acknowledged: she acknowledges when she receives the owner's message |
