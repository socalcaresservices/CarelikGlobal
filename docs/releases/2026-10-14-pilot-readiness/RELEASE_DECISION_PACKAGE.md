# Release decision package: Wave 1 (migrations 0047 to 0052)

Date 2026-10-14. For the owner. Evidence: `PILOT_READINESS_REPORT.md`, `TEST_EVIDENCE_MATRIX.md`, `BLOCKER_REGISTER.md`, `PILOT_OPERATOR_RUNBOOK.md`, `docs/releases/2026-10-13-wave1/CHECKLIST.md`. Nothing in this package deploys, merges or changes any environment.

## 1. Recommendation
| Decision | Recommendation | Basis |
|---|---|---|
| **GO to start controlled pilot testing (Phase C): deployment of 0047 to 0052 to the AWS pilot** | **NO-GO today.** Not because anything failed, but because four P0 items are missing evidence or decisions: B-01 (pilot state unknown), B-02 (pilot migration ledger unknown), B-03 (no reviewed deployment procedure for this release), B-04 (SHA, approval reference, Operator and window not decided). | A deployment cannot be proposed on an unknown starting state. Local evidence is strong but is not live evidence. |
| **GO to run the read-only pilot preflight** (runbook sections 1 and 5; changes nothing) | **GO**, on the Operator's access, once you name the Operator. | It is the only way to close B-01, B-02, B-05 and B-09, and it carries no change risk. |
| **GO to production** | **NO-GO.** Phase C (pilot), Phase D (acceptance) and Phase E (your written GO naming a SHA and window) have not happened. Production is a separate runbook execution. | Process sections 5 to 8. |

The recommendation changes to **GO for pilot deployment** when all of the following are true: the read-only preflight shows the pilot ledger is `46|0046` (or a state the plan handles, with your approval); the pilot SHA and seed 03 state are recorded; you have chosen the SHA and issued the approval reference; the deployment tooling decision (B-03) is made; a snapshot id is recorded; and the Phase B persona walkthrough on the chosen SHA is signed.

## 2. What the evidence supports (and what it does not)
**Supported (LOCAL, 2026-10-14):** the Wave 1 code merged to `main` passes every local gate with nothing skipped (lint, typecheck, build; 1,312 unit; 561 database including rollback and upgrade tests; 75 API); the harness smoke (45), `smoke.py` (79, twice), `pilot_smoke.py` (11) and the local pilot regression (35 passed, 0 failed, 1 not run) pass; the new database functions are not executable by PUBLIC and have fixed search paths; a clean scheduled visit ends signed, Billing Ready and counts its hours once; a database upgraded from 0049 to 0052 keeps every existing row unchanged and reads old visits correctly.

**Not supported by any evidence yet:** how any AWS environment behaves with these migrations; the API Gateway authorizer on the new routes (SMK-06); Cognito/MFA, IAM, S3/KMS, CloudFront, the real RDS engine; the experience on a real phone; the office's actual review workload; whether Netlify's live site is on the Supabase build (very likely, not recorded).

## 3. Unresolved risks (each with an owner decision where one is needed)
| Risk | Effect if it happens | Mitigation | Decision needed |
|---|---|---|---|
| Pilot ledger lower than 0046 | Deploying would also deploy caregiver readiness (0039 to 0046) | Preflight stops on any ledger other than `46|0046` | Approve that release separately if so |
| Short window between the database and API steps | Starts with no shift and override creation fail until the API is deployed | One sitting, database first; synthetic pilot only | None |
| Down 0050 refuses after real use | After the pilot has used the new features the database can only go back by forward fix or snapshot restore | Snapshot first; say so before deploying | Acceptance of this limit |
| Shift-less visits now need review for every caregiver | More office work; unmeasured | Measure "Visits to Review per 100 visits" in the pilot | None |
| The 15-minute variance default is a placeholder | Wrong agency rule if used unchanged for real | Agency sets and verifies its own value before real use | Who sets it (B-13) |
| VIS-54: a manager's correction of an unscheduled visit is not re-evaluated by the new rules | A corrected visit may not be re-sent to review | Known limit; document | Block the pilot? (B-12; I recommend no) |
| Netlify publishes every merge to `main` (if the owner's report generalizes) | A later merge touching the Supabase path reaches www.ogevia.com without a release step | Wave 1 files are gated; keep PRs to `main` reviewed | Keep or change publishing (B-08) |
| `smoke.py` AWS-mode infrastructure checks never run since routes grew | A false failure in Phase C | Dry run; report, do not edit the pilot | None |

## 4. Decisions requested from the owner (one list)
1. Name the Operator and authorize the **read-only** preflight (runbook sections 1 and 5).
2. Send the three Netlify screens (report section 6).
3. Choose the release SHA (my suggestion: the merge commit of the final approved `main`; the application code is identical from `63de403` to `484135d`) and issue a new `OGEVIA_DEPLOY_APPROVAL` reference when you are ready.
4. Approve or decline writing a reviewed pilot deployment script set for 0047 to 0052 (B-03).
5. B-08, B-12, B-13, B-17, B-18 as listed in the report (section 8, row 3).
6. Authorize, or push back on, publishing the local branch `claude/pilot-readiness-closure` (3 code/test commits plus these documents; scope below).

## 5. Scope of the local branch (to confirm before anything is pushed)
| Commit | Files | Change |
|---|---|---|
| `4bf3a7d` | `apps/sv-api/test/accounting.db.test.ts`, `infra/aws/db/test/upgrade-0049-to-0052.db.test.ts`, `infra/aws/slice/smoke.py` | New tests; `smoke.py` scheduled workflow |
| `e640f8b` | `infra/aws/slice/smoke.py` | Expected route count read from the handler |
| documentation | `docs/releases/2026-10-14-pilot-readiness/*` | This package |
No application code, migration, API route, infrastructure, seed or Netlify file changes. It follows the existing approval rules: test and documentation changes on a branch, a pull request for review, nothing merged or deployed without you. **Nothing has been pushed; waiting for your confirmation.**
