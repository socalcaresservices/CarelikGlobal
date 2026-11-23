# Phase C statement (DRAFT, UNSIGNED): UX redesign, TEST slice only

**Status: DRAFT written 2026-11-11 by Claude Code for the owner to edit and sign. It is NOT an authorization. Nothing may run on the strength of this file.** Authorization exists only when the owner states it in writing (their own words in their own message or signature below). Every blank in section 1 is the owner's to fill; no value has been chosen for them. Structure follows the 0088 release's `GO_DRAFT.md`.

## 1. Blanks only the owner can fill
| Item | Entry |
|---|---|
| Operator (the person who runs the commands) | ____________ (Claude Code cannot run AWS commands and is not the operator) |
| Window start (date, time, time zone) | ____________ |
| Window end (hard stop for new activity; rollback to known-good only afterwards) | ____________ |
| GO reference (6 to 64 characters of A-Za-z0-9._-; the deploy script requires it as `OGEVIA_DEPLOY_APPROVAL`) | ____________ |
| Owner's full name and date | ____________ |

## 2. Scope this statement would cover (and nothing else)
| Item | Value |
|---|---|
| Environment | The existing **TEST/pilot slice**: CDK `-c env=prod`, stacks `Ogevia-prod-*`; database **`ogevia_sv_test`** on RDS `ogevia-prod-postgres` (account `300094796789`, `us-west-2`). **Never** `Ogevia-prd-*` or `ogevia_prd`. |
| Code (the only approved deployment commit) | **`7f9483d39690ae94db2710465d6995cd0b82b271`** on `claude/ogevia-ux-audit-redesign-w36cov` (CI run 431: success). Commits after it are documents only and are not deployed. |
| Migrations | **0090, 0091, 0092, 0093, 0094** from `infra/aws/db/pending`, in that order, outside the ledger (as 0086 was). No ledger row is written. No other migration. |
| Expected live difference | `Ogevia-prod-ServiceVerificationApi`: exactly **5 new routes** and the Handler code asset (the machine gate `diff_gate_ux.py` must say EXPECTED-ONLY: YES); the TEST web bundle; nothing else. |
| Scripts and pins | `toolchain/PINS.md`, `OPERATOR_TEST_DB.sh`, `OPERATOR_TEST_DEPLOY.sh`, `diff_gate_ux.py`, `VERIFY_0090_0094.sql` (hashes in `PINS.md`; the operator checks each before use). Web publish uses the 0088 method, `deploy-test-slice.sh web`. |
| Starting state (to be re-verified by `probe` and `capture`) | ledger 88 / 0088; none of the objects of 0090 to 0094 present; the live Lambda and web files as captured. This is **UNVERIFIED** from the repository (last recorded 2026-11-01). |
| Feature switches | `signInOverride`, `bulkImport`, `staffDuplicates` ON for the TEST stack only (they are in the commit); production stays OFF. |

## 3. Actions this statement would authorize, in this order (the Operator follows `toolchain/PHASE_C_COMMANDS.md`)
1. **Local rebuild and selftests** (clean checkout of the commit, install, `synth`, script selftests): no AWS change.
2. **Read-only probe** (`probe`, `capture`): must match section 2's starting state. Any difference: STOP.
3. **`check`**: the real `cdk diff` and the expected-only gate must show only the 5 routes and the Handler asset. Anything else: STOP.
4. **One manual RDS snapshot**, verified `available` and encrypted. Without it, do not write to the database.
5. **`apply`**: migrations 0090 to 0094 in order, each in its own transaction, then `VERIFY_0090_0094.sql` (53 checks, 0 failing) and the ledger still 88/0088.
6. **Deploy the API stack** (the one gate-checked stack), then **publish the web bundle**, then their post-checks (401 without a token and with a forged token on the 5 new routes; served bundle carries the commit and the TEST label).
7. **Seed the demo day** with `07_seed_ux_demo_visits.sql` (synthetic data; refuses any database but `ogevia_sv_test`).
8. **Phase C checks** with **synthetic data only**: the cases in `FEATURE_TEST_PLAN.md` section 7 that need TEST; the regression runner in `aws` mode (must exit 0); every role opens every menu item; smoke suites.
9. **Phase D (UAT)** only as the owner decides afterwards.
10. **Rollback**, only after a stop condition: web, API, then the database down scripts 0094 to 0090, solely to restore known-good. Restoring the RDS snapshot onto the shared instance is NOT covered (it also holds production data) and needs a separate owner decision.

**Access (separate written authorization needed, line 8.2 below):** for steps 2, 5 and 10 the database script temporarily attaches AppSG `sg-064ffce3bcbe8eb3b` to the admin host `ogevia-db-admin-temp` (restored and re-checked afterwards) and uses the TEST database admin credential in memory only, on `ogevia_sv_test` only, within the window. The 0088 approval does not carry over.

## 4. Not authorized
Production in any form; any other migration, ledger row or code; merging the pull request; enforcement activation; Cognito settings, IAM or security groups beyond what the diff and the access paragraph show; starting or stopping the admin host; deleting snapshots or data; non-synthetic data; anything after the window ends except rollback to known-good.

## 5. Stop conditions (stop, change nothing further, report)
`current_database()` is not `ogevia_sv_test`; the checkout is not exactly the commit; any pinned hash differs; the ledger is not 88/0088 or any new object already exists; the Lambda does not serve `ogevia_sv_test` or reports `OGEVIA_ENV=prd`; the gate says anything but EXPECTED-ONLY: YES; the snapshot is not `available` and encrypted; a migration fails (its transaction rolls back; do not continue); `VERIFY_0090_0094.sql` shows any failing check; a post-check or the regression runner does not pass; any prompt for an IAM change; the window has ended.

## 6. What this statement does not change
It does not make the release releasable or production-approved. Production (Phase E) is separate and needs its own statement, its own commit pin and its own window. It does not approve security; see section 7.

## 7. Preconditions still open when this draft was written
| Precondition | State |
|---|---|
| CI on the exact commit | **done**: run 431 success |
| Gates on a clean clone (lint, typecheck, build, unit, database, API; 0 skipped) | **done** at `d7f7147` (code before the overrides and switches); CI run 431 covers the final commit |
| Security review (`SECURITY_AND_COMPATIBILITY_REVIEW.md`) | analysis done by Claude; **owner or reviewer sign-off OPEN**. Not approved. |
| SEC-3 `exceljs` advisories: option A (overrides, already in the commit), B, C or D | **owner decision OPEN** (`SEC-3_EXCELJS_ADVISORIES.md`) |
| SEC-5: caregivers see client first name + last initial, and city on open shifts | **owner confirmation OPEN** |
| U1 to U4 CloudShell read-only results | **OPEN** (confirm instance, admin host, bucket and distribution ids) |
| Operator named, window and GO reference | **OPEN** (section 1) |
| Regression gate | **partly open**: local 35 pass, 0 fail, 1 not run (SMK-06 needs the deployed API); the gate needs exit 0 in `aws` mode during Phase C |
| Owner items needing a person: stray ▲▼ control (UXR-01c), production error capture (UXR-03b), real-phone test (UXR-14c), live version on demo/app (UXR-22) | **OPEN**; none blocks Phase C itself, each is a UAT/Phase D item unless the owner says otherwise |
| Shared database server: TEST and production share one RDS instance (per the 0088 records; U1 confirms) | known risk; the snapshot covers both; no production database is touched |

## 8. Owner's statement (UNSIGNED; edit freely; delete any line you do not agree with)
**8.1** > I authorize the Operator named in section 1 to carry out section 3, steps 1 to 8, on the TEST/pilot slice only, within the window in section 1, at commit `7f9483d39690ae94db2710465d6995cd0b82b271`, subject to sections 4 and 5. The GO reference is the one in section 1. I understand this does not approve production and does not approve security.

**8.2** > I separately authorize the database script `OPERATOR_TEST_DB.sh` to temporarily attach AppSG `sg-064ffce3bcbe8eb3b` to `ogevia-db-admin-temp` and to use the TEST database admin credential in memory only, on `ogevia_sv_test` only, within the window, for steps 2, 5 and 10 of section 3. ☐ I give this ☐ I do not (then the database steps cannot run)

**8.3** > Decisions recorded with this statement: SEC-3 option ☐ A ☐ B ☐ C ☐ D;  SEC-5 ☐ confirmed ☐ not confirmed;  database rollback access (step 10) ☐ authorized now ☐ to be authorized separately if needed.

| Field | Entry |
|---|---|
| Owner (full name) | ____________ |
| Date and time (with time zone) | ____________ |
| Signature or the exact words relayed | ____________ |
