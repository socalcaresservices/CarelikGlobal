# Caregiver readiness simplification (owner brief 2026-10-30)

**Status: IMPLEMENTED AND TESTED LOCALLY. NOT DEPLOYED. NOT APPLIED TO ANY SHARED DATABASE. TEST/PILOT package only; operator Stella Okereke; target NOT designated; 0086 NOT RELEASABLE (G3 resolved; B9, target, Phases C-E open: see `CHECKLIST.md`).** Owner-defined rules, not verified legal requirements.
Discovery: `DISCOVERY.md`. Which environment is "demo" is **UNKNOWN**; everything here was built and run on a disposable local PostgreSQL only.

## Release package
Start at `DECISION_RECORD.md` (owner decisions D1-D8, filed unsigned, for the owner's signature), `CHECKLIST.md` (gate status), `FEATURE_TEST_PLAN.md` (RDY-01 to RDY-17), `SECURITY_REVIEW.md` (security review filed for the reviewer, unreviewed), `B9_REGRESSION_WORKSHEET.md` (regression spot-check: RUN, FAIL on one pre-existing defect), `RUNBOOK.md` (target probe, apply, checks, rollback; target UNKNOWN, nothing run) and `evidence/` (16 screenshots of the real local stack). Catalog rows: `docs/release-process/ACCEPTANCE_TEST_CATALOG.md`, area RDY.

## What changed
| Area | Change |
|---|---|
| Migration `0086_caregiver_readiness_approve_for_work.sql` (+ `rollback/…down.sql`, BACKUP REQUIRED) | One readiness function (`ogevia.caregiver_readiness`, summary + status), `caregiver_work_approvals`, `caregiver_cpr_tb_extensions` (append-only), `organization_compliance_settings` (default 30), restricted `caregiver_contacts`, calculated `caregiver_work_status`, new API functions, rate limit on resend (60 s, 5 a day), `list_caregivers` / `list_accounts` return the calculated status. `readiness_checks` again treats a missing/uploaded CPR/TB as pending inside its due date. |
| Canonical background check | `caregiver_background_checks`. The onboarding `background_check`, document and `clearance` requirements are set **inactive, not deleted**. |
| Existing Ready/Active caregivers | Backfilled as approved (`legacy_status`, no approver). Nobody is deactivated or loses scheduling. |
| API (`apps/sv-api`) | 8 routes: readiness, approve, cpr-tb extend / extensions, compliance settings (GET/POST), contact, signin-link. Added to the CDK route list. |
| Web | Caregiver page = one checklist (5 requirements + Approve for work). Removed: Compliance card, Onboarding card/progress bar, status picker, Documents status labels (now a file list). Both lists and the Staff list show the calculated status. Send sign-in link / Add email in all three places. |

## Decisions taken without asking (change on request)
1. **Active** = approved and has a current assignment or any visit. Deactivate is the only manual status; "Approve for work" also reactivates.
2. **Approve** needs `caregivers.manage` (as the old status change did); **extend** and the **due-days setting** need the administrator permission `caregivers.compliance.manage`; background verification stays administrator-only.
3. A training item already **waived** under 0054 still counts as met for approval (existing capability kept).
4. **Request** CPR/TB button: not built. Ogevia has no channel to message a caregiver except the Cognito invitation (no SMS, no document-request notice). Upload is on the Documents page.
5. The Recruiting board's "Move to Approved" is replaced by a link to the record (approval is not a stage move).
6. **Reverses the 2026-10-19 (0081) rule** that a missing CPR/TB blocked work from day one, as the 2026-10-30 brief requires.

## Evidence (local only)
| Check | Result |
|---|---|
| DB suite, `infra/aws` (real PostgreSQL 16, 102 files) | see REPORT section "Tests" |
| New `caregiver-readiness.db.test.ts` (22 tests) | pass |
| New `sv-api/test/caregiver-readiness-http.db.test.ts` (5) + existing sv-api DB suite | pass |
| Web (1,200+ tests), eslint, tsc | pass |
| Real Chromium, production bundle, 390 px and 320 px (`apps/web/e2e/readiness-mobile.mjs`) | 21/21 pass |
| Task 8 query (`TASK8_ACTIVE_CAREGIVER_GAPS.sql`) | syntax and output shape checked on a synthetic local row; **not run on any shared database** |

## Superseded-package tests (retired 2026-10-30)
The release-pin and script tests of the 2026-10-19 and 2026-10-21 packages were moved (not deleted, not re-pinned) to `infra/aws/retired-tests/` on the owner's instruction; see its README. The 41 earlier database failures are categorized in `TEST_FAILURE_CATEGORIZATION.md` (37 obsolete and retired, 4 date-dependent and since remediated: `TEST_REMEDIATION_DATE_DEPENDENT.md`, 0 defects).

## Not verified (cannot be, from this session)
Cognito temporary-password expiry and single use, the content/PHI-freeness of the Cognito invitation email, the live demo database, CloudFront/Netlify behaviour, the CDK diff (`cdk synth`/`diff` not run), production load.
