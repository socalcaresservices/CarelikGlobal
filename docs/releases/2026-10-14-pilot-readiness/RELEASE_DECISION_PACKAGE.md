# Release decision package: Wave 1 (migrations 0047 to 0052)

Date 2026-10-14. For the owner. Evidence: `PILOT_READINESS_REPORT.md`, `TEST_EVIDENCE_MATRIX.md`, `BLOCKER_REGISTER.md`, `PILOT_OPERATOR_RUNBOOK.md`, `PILOT_DEPLOYMENT_PROCEDURE.md`, `evidence/PHASE_B_WALKTHROUGH.md`, `OWNER_ACTION_SHEET.md`. Nothing here deploys, merges or changes any environment.

## 1. Recommendation
| Decision | Recommendation | Basis |
|---|---|---|
| **GO to run the read-only pilot preflight** | **GO**, once you name the Operator and I push the branch (Task 1 and 3 of the action sheet). | It changes nothing (a test fails if the script ever gains a write) and it is the only way to close B-01, B-02, B-05, B-09. |
| **GO to deploy 0047 to 0052 to the AWS pilot** | **NO-GO today.** Four P0 items are missing evidence or decisions: B-01 (pilot state unknown), B-02 (pilot ledger unknown), B-03 (no scripted deployment; a manual gated procedure now exists), B-04 (SHA, approval reference, Operator and window undecided). One finding needs a decision first: **B-12 (the correction path, section 3)**. | A deployment cannot be proposed on an unknown starting state. |
| **GO to production** | **NO-GO.** Phase C (pilot), D (acceptance) and E (your written GO naming a SHA and window) have not happened. | Process sections 5 to 8. |

The recommendation for the pilot deployment becomes **GO** when: the preflight shows a pilot state the procedure handles (ledger `46|0046`, or one you approve); the SHA and approval reference exist; the deployment approach (manual gated or scripted) is chosen; B-12 is decided; a snapshot is approved and recorded.

## 2. What the evidence supports (and what it does not)
**Supported (LOCAL, 2026-10-14):** the code passes every local gate with nothing skipped (see `TEST_EVIDENCE_MATRIX.md`); a person using the real screens in the four roles gets the intended results (53 of 53 checks, `evidence/PHASE_B_WALKTHROUGH.md`); the database migrates from 0046 to 0052 without changing any existing row, and rolls back from 0052 to 0046 on a database that has not run Wave 1 (rehearsed); the new database functions are not executable by PUBLIC and have fixed search paths; a clean scheduled visit ends signed, Billing Ready, and counts its hours once.
**Not supported by any evidence yet:** how any AWS environment behaves; the API Gateway authorizer on the new routes (SMK-06); Cognito/MFA, IAM, S3/KMS, CloudFront, the real RDS engine; a real phone; the office's actual review volume; what Netlify's live site is configured to use.

## 3. The three plan items you asked about (scope, impact, risk, recommendation, and why)

### VIS-54: a manager's correction of a visit (found to be a control gap, not only a missing test)
- **What it is.** When a manager uses "Correct visit" the system creates a new corrected record and keeps the original. That function (`correct_service_visit`, migration 0018) was not changed by Wave 1.
- **What actually happens (verified locally).** An unscheduled visit sits in administrator review (Wave 1 rule D-U). If a manager corrects its times, the corrected record comes out **`signed` (Billing Ready)** with **no unscheduled reason and no review reason**. The correction needs a reason and is audited, a human still has to approve the billing separately, and the original is kept. But the review step the owner decided on is skipped, and the corrected record no longer says it started with no shift.
- **Impact.** An unscheduled visit can become Billing Ready by a correction without anyone recording the review decision. No money goes out without a human approval; the control the owner chose (review before billing) is bypassed by a privileged person.
- **Risk of fixing.** One function in the billing-critical correction path changes (new migration 0053 plus tests: the corrected record keeps the reason and stays in review; the clean-visit correction stays signed). It adds a migration to this release, changes the release SHA and means the present evidence is re-run on it. Effort: small to medium.
- **Recommendation: fix it before the first deployment** (nothing is deployed yet, so adding 0053 now is cheaper than a second release). If you decline, the pilot can still run on synthetic data with a written rule for testers ("do not correct an unscheduled visit; use a review decision"), but it must be fixed or formally accepted before production. This is **not** classified as non-blocking for production. For the synthetic pilot it is not a safety issue because no real data or billing exists; that is why it is a decision, not a stop.

### VIS-26: show review reasons as labels and filters in the lists
- **What it is.** The plan wanted the Billing review and Action needed lists to show every reason on each visit and let the office filter by reason. Today reasons appear only on each visit's own page (verified: the list shows "Needs review", the page shows the reasons).
- **Impact.** Triage is slower: the office opens a visit to learn why. Because every shift-less visit now goes to review, volume may rise. No effect on money, authorization or permissions.
- **Risk of building.** It needs the reason data in the list API (a database function or API change), so it too adds backend scope.
- **Recommendation: does not block the pilot; build only if the pilot shows triage is a problem.** Why it is safe to wait: it changes how fast a person finds the reason, not what the system allows; each review is still reachable and shows its reasons; synthetic pilot volume is small; the pilot measures "Visits to Review per 100 visits" to tell us whether it is needed.

### VIS-57: "unverified" labels for payer-related rules, and named statuses
- **What it is.** The plan wanted every payer-related setting (billing rounding, authorization periods) captioned "Unverified. Agency responsible for payer compliance", and the review statuses named as in the product brief. Built: the variance rule says "Product starting value, not verified". Not built: the captions on rounding and authorization-period settings and the named status labels.
- **Impact.** Wording only. The rounding screen does not claim the system verified a payer rule: the Administrator records the payer's rule with its reference. The gap is the missing explicit caption on a screen real agencies will rely on.
- **Risk of building.** Very low (text).
- **Recommendation: does not block the pilot (synthetic data, no payer reliance); do it before production** with the same wording review that the 15-minute default needs (C list). Why: it is a truthfulness-of-wording item for real use, not a behavior.

## 4. Decisions in order (one group at a time)
**A. Required before the read-only preflight** (one decision)
1. Name the Operator (an administrator with CloudShell access) and write: "I authorize the read-only pilot preflight, including `--probe-lambda`." (Also needed: your "approve push" so the script is on GitHub.)

**B. Required before any pilot deployment**
1. Choose the release SHA. Recommended: merge the readiness pull request first, deploy that merge commit.
2. **B-12:** fix the correction path first (recommended) or accept it for the pilot with the tester rule.
3. Deployment approach: the manual gated procedure for the first pilot (recommended; it is complete and human-read), or authorize a scripted deployment first (I recommend writing that for production, after the preflight returns the live templates).
4. Approve using the database password for the ledger read, and (only if the preflight says the admin host lacks the app security group) the temporary security-group change.
5. Name the window and the approval reference; approve the pre-deployment snapshot.

**C. Required before a production release**
1. Who sets the agency's visit variance value and how it is checked against the payer's rule (the 15 minutes is a placeholder).
2. The wording captions of VIS-57.
3. The difference between the caregiver's "Authorization left" and the office's "Hours left" (OBS-1; proposal 01): accept or fix.
4. Netlify automatic publishing policy (B-08) and what `app.ogevia.com` serves (B-17; PRs #71 to #73).
5. The production ledger and backups verified; enforcement activation rule; Phase D acceptance by people on real phones.

**D. Improvements that can safely wait:** VIS-26 labels and filters (reasons above); a build stamp so a deployed SHA can be read from AWS (B-14); the `db:rollback-readiness` tool fix (B-15); closing the older pull requests (`OPEN_PR_REVIEW.md`; none blocks anything).

## 5. Branch `claude/pilot-readiness-closure`: scope to confirm before anything is pushed
Not pushed. Nothing merged.
| Kind | Files |
|---|---|
| Tests | `apps/sv-api/test/accounting.db.test.ts` (one new test), `infra/aws/db/test/upgrade-0049-to-0052.db.test.ts` (new), `infra/aws/test/pilot-preflight.test.ts` (new) |
| Scripts (not application code) | `infra/aws/slice/smoke.py` (scheduled workflow, route count), `infra/aws/slice/pilot-preflight-readonly.sh` (new, read-only), `infra/aws/slice/pilot_preflight_probe.py` (new, GET only) |
| Documents and evidence | `docs/releases/2026-10-14-pilot-readiness/` (this package, procedure, rollback SQL, open-PR review, owner action sheet, `evidence/` with 37 screenshots and text, the walkthrough script), edits to `docs/releases/2026-10-13-wave1/CHECKLIST.md` and `POST_MERGE_VERIFICATION.md` |
No application code, migration, API route, infrastructure, seed or Netlify file is changed. The exact file list, the secret scan and the SHA that each test result applies to are in section 6.
