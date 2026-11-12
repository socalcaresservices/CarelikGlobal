# Feature test plan: 2026-10-30-caregiver-readiness

## 1. The change
| Field | Value |
|---|---|
| Requirement (owner brief 2026-10-30, "Caregiver readiness simplification brief" and the decisions of the same day) | One readiness source instead of four disconnected places. Hard requirements before approval: verified background check, app sign-in, required training. CPR and TB due within an agency setting (default 30 days) of the hire date, extendable per caregiver with a reason, every extension audited. One final human step, **Approve for work**, replaces Compliance clearance and the manual status. Status is calculated (Not ready, Approved, Active, plus Inactive) and identical on every screen. Sign-in link by email through the existing Cognito invitation. Everything enforced server-side. |
| What changes, per role | **Administrator:** verifies the background check, extends a CPR/TB date, changes the agency due-days setting, approves. **Manager:** approves, records training, adds an email and sends the sign-in link, enters a missing hire date; cannot verify the background check or extend. **Scheduler:** no change (cannot read readiness). **Caregiver:** no Care Team access; cannot be assigned or start a visit under the same rules as before. |
| What must NOT change | Signed or locked visits; billing approval; authorization arithmetic; assignment history; existing Ready/Active caregivers are not deactivated and keep scheduling; strict states (rejected, expired, expiring before the work ends, rule not set up) still block at once; enforcement stays off until the owner switches it on. |
| Migrations, routes, screens | Migration `0086_caregiver_readiness_approve_for_work` (rollback class BACKUP REQUIRED). Routes added: GET `/v1/caregivers/{id}/readiness`, POST `.../approve`, POST `.../cpr-tb/extend`, GET `.../cpr-tb/extensions`, POST `.../contact`, POST `.../signin-link`, GET and POST `/v1/compliance/settings`. Screens: caregiver page rebuilt, Caregivers list, Staff list (Accounts), Recruiting board link. |
| Catalog areas required | RDY (new, in the catalog), plus CMP, USR, SMK and every R row. |
| Harness data needed | Added to `local-harness/setup.ts`: legacy approvals for the four seeded Active caregivers, and Reese (approvable), Quinn (no email), Dana (CPR/TB overdue). |
| Things only the pilot can prove | Cognito invitation send/resend, temporary-password expiry and single use, what the invitation email contains (no PHI), the 8 new API Gateway routes and Lambda code, CloudFront serving the new bundle, the migration on a populated database. |

## 2. Test cases
Automated names are in `infra/aws/db/test/caregiver-readiness.db.test.ts` (DB), `apps/sv-api/test/caregiver-readiness-http.db.test.ts` (API), `apps/web/src/aws/care-team.test.tsx`, `accounts.test.tsx`, `recruiting.test.tsx` (web). Harness steps are `infra/aws/local-harness/readiness-scenario.mjs`.

| ID | What to test | How to test | Expected result | Rollback plan if it fails or must be undone |
|---|---|---|---|---|
| RDY-01 | Approve is blocked without a verified background check, even when everything else is done, even for an administrator, through a direct API call | AUTO DB "approval is blocked without a verified background check ..."; API "approve: ... names what is missing (409)". PILOT: call the approve route for a caregiver with sign-in and training but no clearance | 409 "Cannot approve yet. Waiting on: Background check"; no approval row; stored status unchanged. "Completed" alone and "Not approved" are refused too | Down script (section 6) |
| RDY-02 | Approve is blocked until the caregiver has signed in; an invitation alone is not a sign-in | AUTO DB "approval is blocked until the caregiver has signed in ..." | "Waiting on: App sign-in" until first sign-in; then approval succeeds | Same |
| RDY-03 | Approve is blocked until required training is done | AUTO DB "... until the required training is done" | "Waiting on: Required training" | Same |
| RDY-04 | Approve records approver, time, requirement snapshot, audit; double-click makes one record | AUTO DB "Approve for work records ..." and "a concurrent double-click ..."; HARNESS desktop+phone "Reese: after a double-click ..." (DB shows 1 approval, 1 audit row) | Exactly one `caregiver_work_approvals` row and one `caregiver.approved_for_work` audit entry; second call returns `alreadyApproved` | Same |
| RDY-05 | CPR/TB missing inside the due date: approval allowed, warning with the due date | AUTO DB "the default is 30 days ..."; HARNESS "Reese: Not ready, 3 of 5 done, CPR/TB pending ..." | Pending with due date hire+30; approve enabled; shifts not blocked | Same |
| RDY-06 | CPR/TB overdue: enforcement ON blocks a new shift server-side; OFF allows and flags | AUTO DB "enforcement: ..." (both describes); API sweep tests | ON: create_shift refused 422/OGR30 "CPR missing. TB missing."; OFF: created, row shows overdue "Flagged only" | Same |
| RDY-07 | Extension: moves the due date, needs a reason, is audited, history kept; non-administrator and other tenant refused | AUTO DB "extensions: ..." (2 tests); API "extend: ..."; HARNESS "Dana: ..." | Date moves for that requirement only; `caregiver_cpr_tb_extensions` row with old and new date, actor, reason; audit row; manager 403; other agency 404 | Same |
| RDY-08 | Agency due-days setting (default 30): administrator only, reason, 0 to 365, audited, per agency | AUTO DB "the agency setting changes the period ..."; API "settings: ..." | Another agency still 30 | Same |
| RDY-09 | One status everywhere | AUTO DB "the detail summary, the Caregivers list and the Staff list agree ..."; web tests; HARNESS "Staff list shows the calculated status ..." | Same word for the same person on the page, both lists | Web redeploy of the previous bundle |
| RDY-10 | Legacy records: Ready/Active before 0086 are approved (legacy), none deactivated; old onboarding clearance data still renders | AUTO DB "every caregiver who was Ready or Active before 0086 ..."; pilot: compare counts before and after (section F of the runbook) | `calc status` is approved/active for every previously Ready/Active caregiver | Down script |
| RDY-11 | Background check has one source (the two records no longer disagree) | AUTO DB "the two background-check records no longer disagree ..." | A 'Recorded' onboarding row is not a verification | Same |
| RDY-12 | Sign-in link: no email, add email, send, resend limit, already signed in | AUTO DB "contact and the sign-in link" (4 tests); API "the full path over HTTP ..."; HARNESS "Quinn: ..." | "Add an email address first"; first send creates the invitation, a second within a minute is refused, at most 5 resends a day, none after sign-in; the email address appears in no response, list, log or audit row | Same |
| RDY-13 | Contact is restricted | AUTO DB (privileges check inside RDY-12) | Neither `ogevia_app` nor `ogevia_readonly` can select `caregiver_contacts` | Same |
| RDY-14 | Tenant isolation | AUTO DB "tenant isolation and permissions"; API 404 rows | Other agency: 404 on read, approve, extend, contact, settings; caregiver: 403 | Same |
| RDY-15 | Mobile: single column, no sideways scroll, controls 44 px | AUTO web test; BROWSER `apps/web/e2e/readiness-mobile.mjs` (390 and 320 px, mocked API); HARNESS `readiness-scenario.mjs phone` | All checks pass; screenshots in `evidence/` | Web redeploy |
| RDY-16 | Removed sections are gone | AUTO web "the caregiver page is one checklist ..."; HARNESS "Reese: none of the removed sections ..." | No Compliance, Onboarding, "Not eligible under the rules", "Compliance clearance", Status or duplicate Name section | Web redeploy |
| RDY-17 | Controls: older rules still hold (CMP, onboarding, hours, authorization) | AUTO: full DB suite (changed tests listed in the checklist) | Pass, apart from the pre-existing environmental failures named in the checklist | Down script |

## 3. Failure-first checklist
☑ Invalid input (bad email, requirement, date, days, reason) ☑ Stale data (readiness is computed live at every read and commit) ☑ Two people at once (row lock plus unique approval; concurrent double-click test) ☑ Retried or duplicated request (idempotency keys on approve, extend, settings, contact; replay returns the stored answer) ☑ Wrong role ☑ Other agency ☑ Network failure at submit (web keeps one idempotency key per form) ☐ Database failure mid-way: not applicable beyond the transaction per function ☑ Old data and old signed or locked records (legacy approvals; old onboarding rows kept) ☑ Correction after the fact (extensions append-only; hire-date change audited, unchanged) ☑ Daylight-saving and month-boundary dates (due-date math uses the agency's local date, unchanged from 0055) ☑ Timezone is the agency's

## 4. Numbers that must agree
| Figure | Where it appears | Single source | Agreement check |
|---|---|---|---|
| Status (Not ready / Approved / Active / Inactive) | Caregiver page, Caregivers list, Staff list | `ogevia.caregiver_work_status` | AUTO DB agreement test across all three reads |
| "n of 5 done" | Caregiver page, both lists | `ogevia.caregiver_readiness` | Same test |
| CPR/TB due date | Page header, each row, assignment gate, Task 8 query | `ogevia.compliance_grace_for` (hire date + agency days, or the extension) | AUTO DB: extension test and enforcement test use the same date |

## 5. Evidence plan
| Evidence | Phase | File |
|---|---|---|
| Failing tests before the change were the old rule tests (listed in the checklist, A) | A | checklist |
| Screenshots of the real stack, desktop 1280 and phone 390 | B | `evidence/desktop-*.png`, `evidence/phone-*.png` |
| Items the harness cannot prove | C | `RUNBOOK.md` section F |

## 6. Rollback plan (whole change)
See `RUNBOOK.md` section G.
