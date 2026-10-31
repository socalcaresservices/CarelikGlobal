# Stella's read-only verification checklist: 0086 TEST target

**Operator:** Stella Okereke. **Status: NOT RUN.** This is a read-only check. It authorizes no deployment, migration, apply, merge, enforcement activation or any change (owner decisions D10, D12). **Stop rule: if any step would change something, or any result is "unexpected" below, stop and report; do not fix anything.** 0086 stays NOT RELEASABLE.

Use the SQL file `STELLA_READONLY_VERIFICATION.sql` (it is wrapped in `begin read only; … rollback;` and runs as `ogevia_readonly`). Reach the database the way earlier TEST rehearsals did (private RDS, via the existing admin host / Session Manager); never type the connection string into chat or a document. Put results in the table at the end. Counts and settings only: no names, emails or secrets.

## Part 1. Confirm you are in TEST (AWS console or CLI, read-only)
| # | Check | Expected | Result |
|---|---|---|---|
| 1 | AWS account and region | account `300094796789`, `us-west-2` (from `DECISION_RECORD.md` A1) | |
| 2 | CloudFormation stacks named `Ogevia-prod-*` exist (TEST slice). Do **not** open `Ogevia-prd-*` (production) | stacks listed, e.g. `Ogevia-prod-ServiceVerificationApi` | |
| 3 | RDS instance `ogevia-prod-postgres` status and **Publicly accessible** | status available; public access **No** | |
| 4 | Web address `d2xumch5w0izfg.cloudfront.net` shows the banner "TEST — synthetic data only" | banner present | |
| 5 | API id `s0epy5rgzb`; Cognito client `ogevia-web-prod-test-slice` | match (these are last-recorded values; record any difference) | |
| 6 | Latest RDS automated backup / snapshot exists (for the later mandatory pre-apply snapshot) | one recorded; **do not create a snapshot now** (separate approval) | |

## Part 2. Database checks (run the SQL file on `ogevia_sv_test` only)
| # | Query | Expected | If different |
|---|---|---|---|
| V1 | `current_database()` | `ogevia_sv_test`, `is_test_db = true` | **STOP, rollback, report.** Never continue on `ogevia_prd` |
| V2 | migration ledger | latest `0085`, count 85 | below 0085: report; earlier gaps need their own approvals (runbook B, contiguity rule) |
| V3 | `already_has_0086` | null | not null: report; 0086 may already be applied |
| V4 | Ready/Active and caregiver counts | record the two numbers | needed to compare after apply (`UAT` section 1; checklist F) |
| V5 | `enforcement_active_from` per organization | null (report-only) | **non-null: tell the owner immediately.** TEST already enforces, so 0086 would block overdue CPR/TB on apply, and UAT step S4 cannot run as designed. Enforcement cannot be undone in the product |
| V6 | organization count | record it | 1: UAT relies on automated tests for cross-agency and the reviewer must accept that in writing (D11). 2+: UAT runs X1 to X3 |

## Part 3. Checks outside the database (read-only)
| # | Check | Expected | Result |
|---|---|---|---|
| 7 | Cognito user pool: is it shared with production? (look only; **do not** edit, disable or invite anyone) | record yes/no and the invitation temporary-password validity (days) | |
| 8 | Is there a mailbox you control that can receive Cognito invitation email for UAT? | yes, address kept out of documents | |
| 9 | Git: on the Operator machine, `git fetch origin claude/practical-tesla-r07odb` then `git rev-parse origin/claude/practical-tesla-r07odb` and the diff command in `CHECKLIST.md` line 11 | the diff against `54894411f0e69ac29bec762006e47f7d943b94f2` over deployable paths is **empty** | |

## Part 2a. Database access path (added 2026-10-31 after Stella's Part 1 report)
Earlier rehearsals (`docs/aws/TEST_PILOT_DEPLOYMENT_PLAN.md`, `docs/aws/CLOUDSHELL_READONLY_INVENTORY.md`) reached the private database with an SSM port-forward through `ogevia-db-admin-temp`. Two parts of that route **conflict with this checklist** and need an owner decision before use:
1. **Security-group change.** The rehearsal route attached the app security group to the admin host (or added one temporary ingress rule) for the window and restored it afterwards. That is an environment change. This checklist authorizes none. **If the route needs it, stop and ask the owner.**
2. **Credential.** `ogevia_readonly` is `NOLOGIN`; it can only be reached with `set local role` from a login role, which in earlier rehearsals meant reading the database master secret (`get-secret-value`) into a shell variable. Reading it is not a change, but it is the most powerful credential. Never print, paste or store it. If a lower-privilege login role that can `set role ogevia_readonly` exists, use that instead and record which.
3. **Admin host state.** On 2026-10-21 the host was recorded as running (`INVENTORY_RECONCILIATION_2026-10-21.md` item 18). **Do not start or stop it without approval.** If it is stopped, report that and wait.
If any of 1 to 3 is needed, the owner must authorize that one specific step in writing first. Do not run Part 2 by another route (no public RDS, no new endpoint, no new host).

**Owner decision D13 (2026-10-31, `DECISION_RECORD.md` A5) settles Part 2a: least-privilege path only.** Use an existing lower-privilege login role that can `SET ROLE ogevia_readonly`. Do **not** use the master secret, start/stop `ogevia-db-admin-temp`, attach or change any security group, or create any network path. If the only way in needs one of those, **STOP and report the exact requirement** (what, why, which resource) before doing anything. Record in the results which login role was used (name only).

## Part 4. Do NOT do
Do not run `cdk deploy`, `cdk bootstrap`, `cdk import`, `db:migrate`, `db:verify` writes, create a snapshot, call any `POST` route, press any activation button, change Cognito or security groups, or touch `ogevia_prd`. The real `cdk diff` (checklist C4a) waits for the owner's window and GO; it is not part of this checklist.

## Results (Stella fills in; then returns this page)
| Field | Entry |
|---|---|
| Date and time run (with timezone) | |
| V1 database / V2 latest and count / V3 | |
| V4 Ready-or-Active / caregivers | |
| V5 enforcement value | |
| V6 organizations | |
| Part 1 and Part 3 differences | |
| Anything unexpected | |
| Login role used (name only; no secret) | |
| Operator signature | ______________________________ |

Claude then records the results in `CHECKLIST.md` (C0) and `TARGET_VERIFICATION_AND_OPEN_ITEMS.md`. Passing this check removes one blocker only; the window, GO, `cdk diff`, B9 acceptance, security review and signed decision record are still required.
