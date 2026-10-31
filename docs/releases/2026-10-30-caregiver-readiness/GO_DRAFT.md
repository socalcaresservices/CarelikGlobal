# GO for Phase C: release 2026-10-30-caregiver-readiness (migration 0086), TEST slice only

> **SUPERSEDED WINDOW (2026-10-31).** The first window (09:00-12:00 PDT) lapsed with no step run. **Current window: 2026-10-31 14:00-18:00 PDT (21:00 UTC to 01:00 UTC on 2026-11-01), GO `GO-0086-TEST-20261031-B`, `DECISION_RECORD.md` A19.** Everything below applies with that window and reference; scope unchanged.

**Status: GIVEN AS RELAYED 2026-10-31 (owner's statement in the conversation, `DECISION_RECORD.md` A11): "APPROVED FOR TEST EXECUTION ONLY, subject to all stop conditions in GO_DRAFT.md". Window 2026-10-31 09:00 to 12:00 PDT. Operator Stella Okereke acknowledged. NOT RUN YET.** The signature cells in section 8 are not filled by hand; the statement above is the record. Claude drafted this text; the owner decided it. Production is out of scope. 0086 stays NOT RELEASABLE until the checklist says otherwise (decision D7).

## 1. Blanks only the owner can fill
| Item | Entry |
|---|---|
| Window start (date, time, time zone) | **2026-10-31 09:00 PDT** (16:00 UTC) |
| Window end (hard stop for new activity; rollback to known-good only, per A12) | **2026-10-31 12:00 PDT** (19:00 UTC) |

## 2. Scope this GO covers (and nothing else)
| Item | Value |
|---|---|
| Environment | The existing **TEST/pilot slice** (`DECISION_RECORD.md` A1): CDK `-c env=prod`, stacks `Ogevia-prod-*`; database **`ogevia_sv_test`** on RDS `ogevia-prod-postgres` (account `300094796789`, `us-west-2`). **Never** `Ogevia-prd-*` or `ogevia_prd` (production). |
| Code | Commit **`54894411f0e69ac29bec762006e47f7d943b94f2`** on `claude/practical-tesla-r07odb`. Operator re-runs the diff in `CHECKLIST.md` line 11 first and expects **no output**. Any other commit needs a new GO. |
| Migration | `0086_caregiver_readiness_approve_for_work.sql` sha256 `d9c8cc372011e68221868767e83922da641457535e796b9de23b836881c568ee`; rollback `fe47381cb9c888e8cb541936dbd8402a550aac83b5926a64d736a1463f520e29`; migrations 0001-0085 set `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef` (unchanged). |
| Operator | **Stella Okereke** only. |
| Starting state (VERIFIED by Part 2) | Ledger 85 / `0085`; `0086` absent; 5 of 6 caregivers Ready/Active; enforcement empty in all four organizations. |

## 3. Authorized actions, in this order (the Operator follows `RUNBOOK.md`)
1. **Re-probe, read-only** (runbook B, `current_database()` must be `ogevia_sv_test`). If the ledger is not 85 / `0085`, or `0086` is present, or enforcement is non-null anywhere: **STOP and report.**
2. **Real `cdk diff`** for the TEST slice API stack(s) and web. It must show **only**: 8 new routes plus a Lambda asset per API stack (plus the CDK metadata string). Anything else (IAM, networking, replacement, deletion, another stack): **STOP and report; do not deploy.**
3. **One manual RDS snapshot** of `ogevia-prod-postgres` (a small recurring storage cost, accepted by this GO), record its identifier, wait for `available`. Without a verified snapshot, **do not migrate.**
4. **Apply migration 0086** to `ogevia_sv_test` only, with the runner and the owner-approval variable in the runbook; then `db:verify` (ledger 86 / `0086`); then the probe: `legacy_status` approvals equal the pre-release 5, nobody deactivated.
5. **Deploy the TEST API stack** at the pinned commit, then **build and upload the web bundle** for the TEST site and invalidate CloudFront (runbook E, in the order database, API, web).
6. **Phase C checks** (runbook F) with **synthetic caregivers only**: invitation email and content, temporary-password validity (record the days), the 8 routes (200/401/403/404), CloudFront bundle on a phone, migration on populated data, regression set R and smoke set S.
7. **Phase D UAT** on TEST under `PHASE_D_UAT_SCRIPTS.md`, with the four validators, **enforcement OFF** (O13 and S4 not executed, D10), manual cross-agency steps X1-X3 (D11) with two organizations Stella names.
8. **Rollback**, if a stop condition (section 5) occurs after step 4: runbook G, in the order web, API, database. **Per A12 it may continue after the window end solely to restore TEST to a known-good state; no new deployment activity may begin after the window end.** Restoring the snapshot creates a new RDS instance and is **not** covered: stop and ask the owner. Stella records what she did and why.
9. **If UAT (step 7) does not fit in the window, stop after Phase C** and request a separate UAT window and GO (A12).

## 4. Not authorized
Production in any form (`ogevia_prd`, `Ogevia-prd-*`, Netlify, Supabase, DNS); activating enforcement; any other migration or code; changing Cognito pool settings, users other than synthetic ones, security groups or IAM beyond what the diff shows; starting or stopping the admin host; deleting snapshots or data; running anything after the window end; merging to `main`; any customer or real-person data; the Part 2 window script (it was a one-time D14 item).

## 5. Stop conditions (stop, report to the owner, change nothing further)
`current_database()` not `ogevia_sv_test`; the commit diff is not empty; a ledger or enforcement value different from section 2; any `cdk diff` item outside section 3 step 2; no verified snapshot; a migration or verify error; a caregiver who was Ready/Active before cannot be scheduled; any cross-agency read; an unexpected 5xx on the new routes; the window end is reached.

## 6. What this GO does not change
It does not make 0086 releasable or production-approved. Phase E (production) is a separate request. The owner decides releasability only after UAT execution and sign-off (owner instruction 2026-10-31).

## 7. Preconditions still open when this draft was written (2026-10-31)
| Precondition | State |
|---|---|
| `DECISION_RECORD.md` D1-D17 signed by the owner and acknowledged by Stella | **done 2026-10-31 (typed, relayed)** |
| Six package decisions confirmed | **done 2026-10-31: all six ACCEPTED** |
| B9 accepted by a human | **done 2026-10-31: accepted by Stella Okereke** |
| Security review | outcome APPROVED relayed and accepted as recorded (D17); per-box copy not in the repository |
| Window start and end | **set** (section 1) |
| Two organizations with synthetic sign-in users named for X1-X3 | open |

## 8. Owner's GO (given as relayed)
> I authorize the Operator, Stella Okereke, to carry out section 3 on the TEST/pilot slice only, within the window in section 1, at commit `54894411f0e69ac29bec762006e47f7d943b94f2`, and subject to sections 4 and 5. This GO expires at the window end.

| Field | Entry |
|---|---|
| Owner (full name) | Stella Okereke (as stated; see the role note in `DECISION_RECORD.md` A11) |
| Signature | Typed statement relayed in the conversation, not a system or wet signature |
| Date and time (time zone) | 2026-10-31 (time of statement not given) |

| Operator acknowledgement | Entry |
|---|---|
| Stella Okereke | "Acknowledged." typed, relayed 2026-10-31 |
