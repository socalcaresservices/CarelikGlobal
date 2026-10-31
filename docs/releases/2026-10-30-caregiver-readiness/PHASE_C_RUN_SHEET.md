# Phase C run sheet: 0086 on TEST (Operator: Stella Okereke) — DRAFT, NOT RUN

**Authority:** `GO_DRAFT.md` (GO given as relayed, `DECISION_RECORD.md` A11/A12). **TEST/pilot only.** Window **2026-10-31 09:00-12:00 PDT** (16:00-19:00 UTC). **Only approved commit: `54894411f0e69ac29bec762006e47f7d943b94f2`** (reconfirmed A12). Migration **0086 only**. After 12:00 PDT **no new deployment activity**; rollback is allowed only to restore TEST to known-good. Nothing here touches `ogevia_prd`, `Ogevia-prd-*`, enforcement, or any other commit.

## Two gaps to close BEFORE 09:00 PDT (the owner decides; Claude cannot)
| # | Gap | Why it matters | Proposed one-line fix |
|---|---|---|---|
| G1 | **Database access for the migration is not authorized.** D14 covered the read-only Part 2 window only; GO section 4 forbids security-group changes "beyond what the diff shows". Every DB step below (S2, S6, S7, S11) needs the temporary AppSG attach to `ogevia-db-admin-temp`, a restore, and a credential that can write. | Without it Stella cannot migrate inside the GO. | Owner: "Stella may, within the window, temporarily attach AppSG `sg-064ffce3bcbe8eb3b` to `ogevia-db-admin-temp` (restored and re-checked), and use the existing TEST database admin credential in memory only, for steps S2, S6, S7 and S11 on `ogevia_sv_test` only." |
| G2 | **No reviewed 0086 command set exists.** The 2026-10-19 scripts (`deploy-guard.sh`, `snapshot-verify.sh`, `ledger-recheck.sh`, ...) were built and pinned for `e80b770`. Claude has not adapted or reviewed them for 0086. | Improvising on the day is the risk. | Recommended: Claude writes and reviews a 0086 DB-window script (like the Part 2 script) before the window; deploy and web steps follow `RUNBOOK.md` E by hand. Or the owner accepts reuse of the old scripts, reviewed by Stella. Until one is chosen, S3, S5, S8, S9 below have **no approved command** beyond `RUNBOOK.md`. |
**Do not start S2 until G1 is answered. Do not improvise commands: if a step has no command, stop and ask.**

## Order of execution
| Step | Action (source) | PASS | STOP if | Capture |
|---|---|---|---|---|
| S0 | **09:00 PDT.** Record start time. `aws sts get-caller-identity` = `300094796789`, `us-west-2`; admin host `i-0ce8db2d7e5839dd5` running, groups = `sg-00e01e2ca80442c1f` only | all match | any differs | times, account, groups |
| S1 | **Pin check.** Work from a checkout at the SHA: `git rev-parse HEAD` = `54894411…`; `sha256sum` migration = `d9c8cc37…c568ee`, rollback = `fe47381c…520e29`; the diff command in `CHECKLIST.md` line 11 prints nothing. Do the build in `/tmp` (CloudShell home disk was full before; `df -h ~` first) | all equal | any differs, or SHA is not the one above | output of those commands |
| S2 | **Re-probe, read-only** on `ogevia_sv_test` (`RUNBOOK.md` B; first `current_database()`). Expect: ledger 85/`0085`, `0086` absent, 5 of 6 Ready/Active, enforcement empty in all 4 orgs | equals the Part 2 baseline | database is not `ogevia_sv_test`; any value differs | the query output (counts/slugs only) |
| S3 | **Real `cdk diff`**, TEST API stack `Ogevia-prod-ServiceVerificationApi` (`RUNBOOK.md` C4/E2) | only 8 `AWS::ApiGatewayV2::Route` (+ their integration permission) + one Lambda code asset (+ CDK metadata string) | anything else: IAM, network, replacement/deletion, another stack | full diff text |
| S4 | **Rollback material** (`RUNBOOK.md` C3): previous web bundle (S3 object versions), previous API template/commit, Lambda `CodeSha256` and `DB_NAME` | recorded | cannot be captured | the identifiers |
| S5 | **One manual RDS snapshot** `ogevia-prod-postgres-pre-0086-<UTC stamp>`; wait `available`; confirm encrypted | status `available` | not available / fails (do not migrate) | snapshot id, status |
| S6 | **Migrate** (`RUNBOOK.md` E1): `db:migrate` (applies only 0086), then `db:verify` | "applying 0086"; verify all PASS; ledger 86/`0086` | any error; any other file applies | full output |
| S7 | **Post-migration probe:** `caregiver_work_approvals` where `source='legacy_status'` = **5**; Ready/Active still 5 of 6; nobody deactivated; enforcement still empty | equal | any differs | counts |
| S8 | **Deploy API** at the pinned commit (`RUNBOOK.md` E2). CDK must not ask for an IAM approval; if it does, answer `n` and STOP | stack `UPDATE_COMPLETE`; Lambda `DB_NAME=ogevia_sv_test` | IAM prompt; a stack other than the one named | stack status, new `CodeSha256` |
| S9 | **Deploy web** (`RUNBOOK.md` E3): build with `VITE_AUTH_PROVIDER=cognito` + TEST settings; upload; CloudFront invalidation | served bundle is the new build; banner "TEST — synthetic data only" | wrong site/distribution; production hostname | invalidation id, served file hash |
| S10 | **Phase C checks** (`RUNBOOK.md` F1-F8), synthetic caregivers only: invitation email once; email has no client/health data; temporary-password validity (record the days); 8 routes 200/401/403/404; phone view; legacy approvals; Task 8 query (read-only) saved for the owner; regression R and smoke S | each ticked | any failure or cross-agency read | results per check |
| S11 | **Close:** final DB read (ledger 86, counts), restore AppSG and re-check (host groups = `sg-00e01e2ca80442c1f`, RDS SG unchanged), record end time | restored and verified | not restored: fix first | final counts, restore proof |
| S12 | **UAT fit check.** Start `PHASE_D_UAT_SCRIPTS.md` only if all four validators can finish before 12:00 PDT. Otherwise **stop after Phase C** and ask the owner for a separate UAT window and GO | decision recorded | n/a | the decision and time |

## Stop conditions (any one: stop, change nothing further, report; roll back only if a migration/deploy already changed TEST)
Wrong database or account; commit/hash mismatch; ledger, count or enforcement value differs from baseline; a `cdk diff` item outside S3; no verified snapshot; migration or verify error; a caregiver Ready/Active before cannot be scheduled; any cross-agency read; unexpected 5xx on the new routes; a step with no approved command; window end reached.

## Rollback (only after a stop condition, and after 12:00 PDT only to restore known-good)
Order web, API, then database (`RUNBOOK.md` G; down script is BACKUP REQUIRED and the snapshot from S5 must exist). **Restoring the snapshot creates a new RDS instance and is NOT covered by the GO: stop and ask the owner.** Re-check the TEST baseline after (ledger 85, 5 of 6, enforcement empty). Record exactly what was done.

## Pass / fail
**Phase C PASS** = S0-S11 all PASS with their evidence. **FAIL** = any stop condition (state whether TEST was changed and whether rolled back). Passing Phase C does **not** make 0086 releasable: UAT, sign-off and the release record update (D7) follow.

## Outputs to return (text, no secrets, no real-person data)
Window start/end times (UTC and PDT); SHA and hashes (S1); baseline probe (S2); full `cdk diff` (S3); rollback identifiers (S4); snapshot id/status (S5); migration and verify output (S6); legacy-approval counts (S7); stack status and `CodeSha256` (S8); web invalidation and served-file hash (S9); F1-F8 results incl. password validity days and the saved Task 8 output (S10); final counts and security-group restore proof (S11); the S12 decision; any deviation, with times. Claude records them in `CHECKLIST.md` section C and a new `DEPLOYED_RECORD_0086_TEST.md`, and ticks nothing it was not given.
