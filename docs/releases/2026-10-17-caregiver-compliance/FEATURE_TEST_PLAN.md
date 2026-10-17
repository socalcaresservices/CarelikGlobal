# Feature test plan: 2026-10-17-caregiver-compliance

**Status: IMPLEMENTED AND TESTED LOCALLY. NOT DEPLOYED. NOT RUN ON THE PILOT.** Owner-defined rules (2026-10-17). They are not verified legal requirements.

## 1. The change
| Field | Value |
|---|---|
| Requirement (the owner's words) | A caregiver may be created before clearance; assignment is blocked until authorised office staff verify an **approved** background-check result ("completed" alone does not qualify). CPR and TB must be verified within **14 calendar days of the hire date**; when that ends, a caregiver missing verified CPR or TB is flagged and put on a compliance hold, using the agency time zone, with the exact deadline documented, and a missing hire date must not bypass enforcement. Existing stricter controls for expired or rejected credentials stay. Eligibility is enforced on the backend for manual assignment, reassignment, open-shift pickup and visit start; a hold flags all affected assignments (including recurring shifts), shows them in Action needed, preserves history and completed visits, and alerts the office for a visit in progress instead of ending it. The hold shows its exact reason with links; only authorised office staff verify; eligibility returns only when every blocking requirement is resolved; hire dates, evidence, approval status and holds are audited; cancelled or reassigned shifts are never resumed. |
| What changes, per role | **Owner/Administrator:** verifies background clearance, may change a recorded hire date, sees the Compliance card, Caregiver Holds and the readiness report. **Manager:** enters a missing hire date, tracks the check's status, sees holds. **Scheduler:** sees holds; cannot change anything. **Caregiver:** cannot be assigned, pick up a shift or start a visit while held (message from the server); sees none of the compliance screens. |
| What must NOT change | Existing signed or locked visits; billing approval; authorization arithmetic; assignment history; shifts the hold touches are never cancelled, moved or ended; a visit in progress is never ended; agencies that have not activated enforcement are not blocked. |
| Migrations, routes, screens touched | Migration `0055_caregiver_compliance_hold.sql` (rollback `0055_caregiver_compliance_hold.down.sql`, class BACKUP REQUIRED). Six routes (section 6 of the README). Screens: Compliance card on the Care Team profile, `/compliance` (Caregiver Holds), one Action needed line. |
| Catalog areas required | CMP (new), plus SCH, REC, VIS, USR, DSH, SMK and every R row. |
| Harness data needed | Synthetic caregivers only: the test harness now seeds approved clearance for the fixture caregivers so older suites keep testing what they were written to test (`db/test/harness.ts`). `infra/aws/local-harness/setup.ts` was **not** changed: VERIFIED by reading it that it never activates enforcement, so its caregivers need no clearance until someone activates enforcement through the screens (then they would show as held, which is the intended behaviour). |
| Things only the pilot can prove | Cognito sign-in as each role; the Action needed badge on a phone; the EventBridge rule (not deployed); real CloudFront; that the live TEST migration ledger is `52|0052` before 0055 is applied. |

## 2. Test cases
The authoritative list is `docs/release-process/ACCEPTANCE_TEST_CATALOG.md`, area **CMP** (CMP-01 to CMP-17). Each row names the automated test that already exists and the manual pilot step with its exact expected result. All four required columns (what, how, expected, rollback) are in the catalog and are not repeated here.

## 3. Failure-first checklist
☑ Invalid input (bad result/status/date, empty reason or evidence note, date outside 2000 to 2100) ☑ Stale data (hold reasons re-evaluated at every change; sticky hold after the period ended) ☑ Two people at once (the per-caregiver lock `ogevia.lock_caregiver` is taken by every evaluation and every commit check; each mutation also takes the row lock) ☑ Retried or duplicated request (idempotency keys on the three mutators, a replay returns the same answer; a second sweep changes nothing) ☑ Wrong role (manager, scheduler, caregiver refused) ☑ Other agency (404, nothing leaks) ☐ Network failure at submit: not applicable beyond the retry above; the web uses an idempotency key per form ☑ Database failure mid-way (each mutation is one transaction; the scheduled run isolates each agency and reports a failed agency as a failed run) ☑ Old data and old signed or locked records (no column of an existing row changes; the upgrade tests prove it) ☑ Correction after the fact (a hire date correction is administrator-only and audited; a withdrawn approval is audited) ☑ Daylight-saving and month-boundary dates (tested on the 25-hour and the 23-hour day) ☑ Timezone is the agency's, not the browser's (`organizations.timezone`; the web prints the date from the server's string)

## 4. Numbers that must agree
| Figure | Where it appears | Single source | Agreement check |
|---|---|---|---|
| Caregivers on hold; shifts to cover; visits in progress | Action needed line, Caregiver Holds page, readiness report | `caregiver_compliance_holds`, `shift_readiness_flags` (kind `compliance`), `service_visits` | API test: `GET /v1/attention`, `GET /v1/compliance/holds`, `GET /v1/readiness` read the same rows |
| Who would be held | Readiness report, profile card | `ogevia.compliance_blockers` | The same function feeds the gate, the hold, the profile and the report |
| The 14 days | Gate, hold, profile, deadline text | `ogevia.compliance_grace_days()` | One function; the text on the profile is built from it |

## 5. Evidence plan
| Evidence | Phase | File name |
|---|---|---|
| Deliberate breakages: boundary shifted by a day (5 tests failed); "completed" accepted as clearance (5 tests failed). Both restored. | A | recorded in the README |
| Full gate output | A | README section 8 |
| Pilot checks and UAT | C and D | NOT RUN |
