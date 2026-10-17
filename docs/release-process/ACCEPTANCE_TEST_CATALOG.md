# Acceptance-test catalog

The reusable list of what to test, how, what should happen, and how to undo it, for every area of Ogevia. Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. A change runs the areas its type requires (process section 6.3) plus every case marked **R** (the Regression set), and adds cases for anything new in the same change.

**How to read this**
- **ID**: area prefix and number. Never reuse an ID; retire it by marking it `RETIRED`.
- **R**: runs in every release (Regression set). **S**: also in the Smoke set (minutes, every environment).
- **How**: `AUTO` names an existing automated test file (a pointer, not a PASS: run it). `HARNESS` is a manual check in the local harness, `PILOT` on the pilot/test environment. Personas: Olivia Owner (Administrator), Morgan Manager, Sam Scheduler, Alex and Blair Caregiver.
- **Expected**: exact numbers or text. If you cannot state an exact result, the case is not ready.
- **If it fails / rollback**: what to do. The area rollback below applies to every case in the area unless a row says otherwise.
- Tags: `NOT BUILT` (feature absent today; keep the row, write the test when built), `PENDING 0047/0048` (applies once those migrations are deployed), `OPEN DEFECT Fx` (known defect with an `it.fails` reproduction; see `docs/product/SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md`).
- **What was verified when this catalog was written (2026-10-13):** every named file exists in the repository, and the suites that were run passed (counts in process section 3.1). Test names given in quotes were read from the files. For the other pointers only the file's existence was checked, not that it covers the exact Expected text: confirm that when you first use the row, and fix the row if it does not.
- Automated-test paths: `infra/aws/db/test/` = DB, `apps/sv-api/test/` = API, `apps/web/src/aws/` = UI.

**Common rollback order for every area:** web (redeploy previous bundle) → API (previous template/commit) → database (`.down.sql` of the migrations in the release, newest first). Records created during testing are never deleted by hand; correct them through the product (cancel, void, correct) and note them in the checklist. A database restore goes to a **new** instance and is a separate approval.

---

## SMK: Smoke set (every release, every environment)
| ID | R/S | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| SMK-01 | R S | Each role can sign in | HARNESS/PILOT: sign in as Owner, Manager, Scheduler, Caregiver | Each lands on its home; no error screen | Stop; roll back web/API |
| SMK-02 | R S | Home loads with numbers | Owner opens Home | Hours cards and Action needed render, no "Unable to check" | Stop |
| SMK-03 | R S | Schedule opens | Scheduler opens Schedule | Week view loads | Stop |
| SMK-04 | R S | Caregiver sees only assigned clients | Alex opens Verify visit | Only assigned clients, client codes only, no names or payer IDs | Stop; treat as a security failure |
| SMK-05 | R S | Start and end a visit | Alex starts then ends a visit (synthetic client) | Server Time In and Time Out recorded; visit locked after confirmation | Stop |
| SMK-06 | R S | Unauthenticated API call refused | PILOT: call any `/v1/...` route without a token | HTTP 401 | Stop; security failure |
| SMK-07 | R S | Environment banner | Open any screen on the pilot | "TEST — synthetic data only" shown | Stop: wrong environment |
| SMK-08 | S | API health through the standard suites | PILOT: `infra/aws/slice/smoke.py` and `pilot_smoke.py` | All checks PASS | Stop |

---

## SCH: Scheduling
**Area rollback:** common order. Shifts created during testing stay; cancel them through the product (cancelling releases their reserved time).
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| SCH-01 | R | One-time shift within authorization reserves time | AUTO `db/test/shifts.db.test.ts` ("manager schedules a shift in agency time ..."). HARNESS: Sam schedules a 4 h shift for Demo Vega | Shift saved, covered or open as chosen, reserved minutes = 240, remaining drops by 240, audit event written | Stop |
| SCH-02 | R | Over-limit shift refused with exact time | AUTO `shifts.db.test.ts` ("owner test 2026-10-05: 3 hr authorized, 1 min used"). HARNESS: try a shift larger than hours left | Refused; message states hours available and hours needed (3 h authorized, 1 min used, 3 h shift: "2 hr 59 min available") | Stop |
| SCH-03 | R | Two schedulers cannot both take the last hours | AUTO `shifts.db.test.ts` ("refuses more time ..., under concurrency too"); `shift-series.db.test.ts` ("two schedulers at once ...") | Exactly one succeeds; total never exceeds the cap | Stop; highest severity |
| SCH-04 | R | Caregiver cannot be double-booked | AUTO `shifts.db.test.ts` ("refuses overlapping shifts ..."), `readiness-gate.db.test.ts` (care-request race). HARNESS: overlap Alex's shift | Refused with the conflict named | Stop |
| SCH-05 | | Past, too short, too long shift refused | AUTO `shifts.db.test.ts` | Past: "already over, record past service as a visit"; under 15 min or over 24 h refused | Stop |
| SCH-06 | | Overnight shift ends the next day | AUTO `shifts.db.test.ts` | End is next local date; minutes correct | Stop |
| SCH-07 | R | Retry with the same key creates one shift | AUTO `shifts.db.test.ts` | One shift, same result returned | Stop |
| SCH-08 | | Daylight-saving times refused | AUTO `dst-local-times.db.test.ts` | Nonexistent or repeated local time refused, date and reason named, nothing saved | Stop |
| SCH-09 | R | Call-out and replacement keep history | AUTO `shifts.db.test.ts` ("call-outs and replacements"). HARNESS: Morgan records a call-out, assigns Casey | Shift shows needs coverage, then covered; both caregivers in history; reservation unchanged | Stop |
| SCH-10 | R | Cancel releases reserved time | AUTO `shifts.db.test.ts` ("cancelling releases ..."). HARNESS: cancel a shift | Reserved minutes returned to Hours left; cancelled shift cannot be changed; reason stored | Stop |
| SCH-11 | | Reschedule one shift re-checks authorization | AUTO `shift-series.db.test.ts` ("one occurrence vs this and future") | Reservation moves with the shift; over-limit move refused | Stop |
| SCH-12 | | Open shift shows "Needs coverage" | HARNESS: Schedule, filter "Needs coverage" | Open and called-out shifts listed; covered shifts not | Fix before GO |
| SCH-13 | R | Role and tenant isolation | AUTO `shift-access.db.test.ts`, `access-roles.db.test.ts`, `tenant-assignment-visit.db.test.ts` | Caregiver cannot create or list agency shifts; other agency sees nothing | Stop; security failure |
| SCH-14 | | Readiness gate on assignment (also CMP-07 for background clearance and the 14-day period) | AUTO `readiness-gate.db.test.ts`, `enforcement-matrix.db.test.ts`. PILOT only after activation | Report-only agencies get a warning; once active, an unavailable caregiver is refused for Manager | Stop |
| SCH-15 | | Administrator override of "No Match", one shift only | AUTO `availability-approval.db.test.ts`; `PENDING 0047/0048` | Second shift needs a second explicit override; shift shows "Assigned with Admin override" | Stop |
| SCH-16 | | Client double-booking refused | `NOT BUILT` (client overlap check) | Write the test when built | n/a |
| SCH-17 | | Authorization shown before saving a shift | `NOT BUILT` (pre-save panel; approved design) | Panel shows Authorized, Used, Reserved, Remaining, This shift, Projected remaining; Save disabled when projected remaining is below zero | n/a |

## REC: Recurrence
**Area rollback:** common order. Series created in testing are ended through the product ("End from a date"), which cancels future occurrences and releases their time.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| REC-01 | R | Preview lists every date and its outcome before saving | AUTO `shift-series.db.test.ts` ("monthly authorization limit (30 h = 1800 min)"). HARNESS: Sam previews Mon to Thu, 2 h, Demo Vega | Each date shown with ok or the reason; month table shows already reserved, this series, available after | Stop |
| REC-02 | R | Over-limit dates flagged, nothing shortened or moved, nothing saved without a choice | Same test | 30 h cap, 2 h Mon to Thu: first 15 occurrences fit, the 16th onward are flagged with dates; creation refused unless "skip" is chosen | Stop |
| REC-03 | R | Skipped dates recorded with reason | AUTO `shift-series.db.test.ts`, `dst-local-times.db.test.ts` | Skipped dates stored with reason and minutes | Stop |
| REC-04 | | A month with five of a weekday has five occurrences | AUTO `shift-series.db.test.ts` ("a month with five Mondays ...") | Five Monday occurrences | Stop |
| REC-05 | | A four-week month | Not found by name: ADD a test (February of a non-leap year) | 4 occurrences per weekday; month total correct | Add test before relying on it |
| REC-06 | | Daylight-saving Sunday | AUTO `dst-local-times.db.test.ts` | Repeated-hour or missing-hour date flagged; skip recorded | Stop |
| REC-07 | | Dates outside every authorization flagged | AUTO `shift-series.db.test.ts` | `no_authorization`, never created | Stop |
| REC-08 | | Caregiver conflicts flagged per date | AUTO `shift-series.db.test.ts` | Conflicting dates flagged with the reason | Stop |
| REC-09 | R | Change one occurrence only | AUTO `shift-series.db.test.ts` ("one occurrence vs this and future") | Only that date changes; its reservation moves with it | Stop |
| REC-10 | R | "This and future" without double counting | Same test | New series created, old future dates cancelled, released time counted once | Stop |
| REC-11 | | End and extend a series | AUTO `shift-series.db.test.ts` | End cancels scheduled occurrences from the date, keeps ones with visits; extend adds later months with the same checks | Stop |
| REC-12 | R | Concurrent series creation | AUTO `shift-series.db.test.ts` ("two schedulers at once ...") | Cap never exceeded | Stop |
| REC-13 | | Excluded dates require acknowledgement | `PARTIAL`: today one button click ("Create and skip the N listed dates"). Target: explicit acknowledgement | Define when built | n/a |
| REC-14 | | Different hours by weekday in one series | `NOT BUILT` | Write when built | n/a |

## VIS: Visits (Service Verification workflow)
**Area rollback:** common order. Visits are never deleted; a test visit is corrected or voided through the product.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| VIS-01 | R | Start and end use server time | AUTO `apps/sv-api/test/workflow.db.test.ts`, `db/test/verification.db.test.ts`. HARNESS: Alex starts and ends | Time In and Time Out come from the server; end cannot precede start | Stop |
| VIS-02 | R | One open visit per caregiver | AUTO `workflow.db.test.ts` | Second start refused: "Finish your current visit before starting another client" | Stop |
| VIS-03 | | A refresh or restart keeps the active visit | HARNESS: start, reload the page | Same visit, same Time In, elapsed time continues | Stop |
| VIS-04 | R | Visit links to its scheduled shift | AUTO `visit-shift-link.db.test.ts`, `shift-access.db.test.ts` | Linked shift becomes completed at Time Out; a signed visit releases the shift's reservation | Stop |
| VIS-05 | R | Confirmed visit is locked and billable minutes are capped | AUTO `authorization.db.test.ts` ("caps an exceeding visit ...") | Signed visit not editable by ordinary update; minutes beyond the authorization go to review with zero billable | Stop |
| VIS-06 | R | Confirmation without a signature goes to review | AUTO `signature-recovery.db.test.ts`; HARNESS: confirm "unable to confirm" | Status administrator_review, 0 billable, appears in Action needed | Stop |
| VIS-07 | | Late confirmation: request, response, review | AUTO `signature-recovery.db.test.ts`, `visit-review.db.test.ts`. HARNESS: Morgan creates a request; open the link; Morgan accepts | Accepted minutes become eligible for human billing approval only; five wrong codes lock the link; visit itself unchanged | Stop |
| VIS-08 | R | Corrections keep the original | AUTO `correction-unchanged-times.db.test.ts`, `approved-visit-correction.db.test.ts`, `signature-correction-idempotency.db.test.ts` | Original retained, corrected values, actor, time and reason recorded; approved visit cannot be silently double-billed | Stop |
| VIS-09 | | Manager closes a missed visit | AUTO `close-missed-visit.db.test.ts` | Closed with a reason, audited, not billable by default | Stop |
| VIS-10 | | Outage (paper) visit record | AUTO `outage.db.test.ts`, `continuity.db.test.ts` | Recorded with its reason; reconciliation lists it | Stop |
| VIS-11 | R | Billing approval is a separate human step | AUTO `workflow.db.test.ts`, `rounding*.db.test.ts` | Billing Ready is not approved; only Administrator approves; approved minutes never exceed billable | Stop |
| VIS-12 | | Caregiver without a login | AUTO `workflow.db.test.ts` (no-login cases) | Scheduling and coverage work; no access granted | Stop |
| VIS-13 | | A caregiver whose assignment ended cannot start | AUTO `tenant-assignment-visit.db.test.ts` | Refused | Stop |

## EVV: Electronic Service Verification
Ogevia's Service Verification is **not** California EVV / Sandata (`CLAUDE.md` section 10). These cases prove what Ogevia actually does and that it claims nothing more.
**Area rollback:** common order; evidence objects are never deleted.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| EVV-01 | R | Timestamps are server-authoritative | AUTO `verification.db.test.ts`, `workflow.db.test.ts` | Client-supplied times are not accepted for start or end | Stop |
| EVV-02 | | Signature evidence is private and checksummed | AUTO `apps/sv-api/test/workflow.db.test.ts` (evidence routes). PILOT: object exists in the private bucket, no public URL, reads only through the app | Metadata and checksum in the database, image only in S3; the harness cannot prove this | Stop |
| EVV-03 | | Evidence is not logged | PILOT: search API logs for a signature payload | None found | Stop; security failure |
| EVV-04 | R | No "EVV compliant" claim in any screen or text | HARNESS: search the built app and docs for "EVV Compliant" | Absent. Wording is "server-timestamped", "service verification" | Fix before GO |
| EVV-05 | | Caregiver screen shows no unnecessary identifiers | HARNESS: Alex's screens | Client code only; no date of birth, UCI, Medicaid or payer identifiers | Stop |
| EVV-06 | | GPS or geofencing | `NOT BUILT` (deferred by owner) | n/a | n/a |
| EVV-07 | | Sandata / CalEVV export or reconciliation | `NOT BUILT` (deferred) | n/a | n/a |

## AUT: Authorizations
**Area rollback:** common order. Authorization versions are immutable and never deleted; a wrong amendment is corrected by a new amendment.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| AUT-01 | R | Balance = authorized − used − reserved, in whole minutes | AUTO `remaining-hours.db.test.ts`, `authorization.db.test.ts` ("computes exact integer remaining minutes") | 600 authorized, 60 used, 420 reserved: remaining 120; never negative in reports | Stop; highest severity |
| AUT-02 | R | Amendment never resets use | AUTO `authorization.db.test.ts` ("keeps consumption across the lineage") | Usage counted across all versions | Stop |
| AUT-03 | R | Amendment: increase, decrease, history | AUTO `authorization.db.test.ts` ("reports impacted visits on amendment") | Old version retained and immutable; affected visits listed (`increase_may_allow_more`, `decrease_now_exceeds`) | Stop |
| AUT-04 | R | A minute is counted once: used OR reserved | AUTO `authorization-accounting-risks.db.test.ts` (F1). HARNESS: client "Demo Rivera (late confirmation)" | 10 h authorized, 45 min accepted, 2 h shift reserved: **Hours left 9 hr 15 min**; revoking the decision restores reserved 120 and used 0; reservation row never changed | Stop |
| AUT-05 | R | Concurrent confirmations cannot spend the last minutes twice | AUTO `authorization.db.test.ts` ("serializes concurrent confirmations", "many concurrent confirmations ...") | Total never exceeds the cap | Stop |
| AUT-06 | | One current authorization per client, service and date | AUTO `authorization.db.test.ts` (exclusion constraint) | Overlapping current authorizations refused | Stop |
| AUT-07 | | Visit uses the current version only | AUTO `authorization.db.test.ts` ("binds a new visit to the CURRENT version ...") | Superseded version never used | Stop |
| AUT-08 | | Expired or missing authorization | AUTO `shift-series.db.test.ts`, `shifts.db.test.ts` | Scheduling refused ("No current authorization covers ..."); series date flagged | Stop |
| AUT-09 | | Rounding adjustments count in use | AUTO `rounding.db.test.ts`, `rounding-regression.db.test.ts` | Approved adjustment changes used and remaining; void reverses | Stop |
| AUT-10 | | No carry-forward between months; calendar-month cap | HARNESS: same client, change month on the client page | Each month has its own authorized, used, reserved | Stop |
| AUT-11 | | Dollar values and rates only for the Administrator | AUTO `access-roles.db.test.ts`. HARNESS: Morgan vs Olivia on client page and Home | Manager sees no rates or dollar values | Stop; security failure |
| AUT-12 | | Retroactive decrease reports affected shifts | `OPEN DEFECT F8` (`it.fails` in the risks test) | Amendment lists reservations put over the cap | n/a until fixed |
| AUT-13 | | Authorization monitor statuses and thresholds | `NOT BUILT` (design in the review package, mockup in `docs/product/mockups/`) | Healthy / Near Limit (80%) / Critical (95%) / Exhausted / Over Limit / Expiring Soon / Expired / No Authorization / Pending Correction; warnings never block scheduling | n/a |
| AUT-14 | | Hand recalculation (UAT) | Phase D: Authorization validator recalculates three balances from visits and shifts | Match to the minute | Blocker |

## DSH: Dashboard (Home)
**Area rollback:** web and API only unless a migration is in the release.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| DSH-01 | R S | Home numbers equal the reports they summarize | HARNESS: compare Home "Hours left" with the sum of client page balances and "Monthly hours & billing" | Same figures | Stop |
| DSH-02 | R | Action needed badge and Home banner show the same total | AUTO `action-needed.test.ts`, `attention-badge.test.tsx` | Same number in both | Stop |
| DSH-03 | | The server total equals the displayed total | `OPEN DEFECT F2` (`it.fails`): server 0, web 2 in the reproduction | One total, calculated on the server | n/a until fixed |
| DSH-04 | R | Every count opens a list with exactly those rows | HARNESS: click each Action needed row, count rows | Counts equal list lengths; no visit in two counts | Stop |
| DSH-05 | | Urgent coverage gaps only (within 48 h) | `OPEN DEFECT F4` (`it.fails`); approved rule: Critical = started and unfilled, Urgent = within 48 h, Upcoming beyond | Upcoming gaps not in Action needed | n/a until fixed |
| DSH-06 | | Month follows the agency's timezone | `OPEN DEFECT F7` (`home-page-month.test.tsx`) | At 2026-11-01 03:00 UTC, an agency in Los Angeles sees October | n/a until fixed |
| DSH-07 | | "Scheduled ahead" accounts for reserved started shifts | `OPEN DEFECT F6` | authorized = billable + scheduled + remaining for the test fixture | n/a until fixed |
| DSH-08 | R | Dollar values only for the Administrator; missing rates stated, never $0 | AUTO `access-roles.db.test.ts`; HARNESS: Olivia vs Morgan | Manager sees no dollars; missing rate stated | Stop; security failure |
| DSH-09 | | Empty, loading and error states | AUTO `sidebar-home.test.tsx`; HARNESS: a new agency with no data | "All clear" only for a confirmed zero; "Unable to check" on failure, never a false zero | Fix before GO |
| DSH-10 | | Ready for Approval is not in the Action needed total | Approved decision (2026-10-13); open until implemented | Shown as a separate work queue | n/a |
| DSH-11 | | KPI values match the KPI dictionary | `NOT BUILT` (dictionary in the review package) | Each KPI recomputed by hand from the fixture | n/a |
| DSH-12 | | Mobile: no horizontal page scroll, readable | HARNESS at 390 px | Tables scroll inside their card; page does not | Fix before GO |

## RPT: Reporting
**Area rollback:** web and API; reports are read-only, so data is unaffected.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| RPT-01 | R | Monthly service summary equals client balances | AUTO `remaining-hours.db.test.ts`, `workspace.db.test.ts` | Same authorized, billable, reserved, remaining | Stop |
| RPT-02 | | Monthly approval summary | AUTO `workflow.db.test.ts`; HARNESS: Billing review | Approved minutes and amounts per approval; approvals voidable with reason | Stop |
| RPT-03 | | Correction history lists originals and corrections | AUTO `approved-visit-correction.db.test.ts`; HARNESS: report "Corrections" | Original, new values, actor, reason, time | Stop |
| RPT-04 | | Visit records filters | AUTO `billing-review-filters.test.tsx`; HARNESS | Filters change the rows; counts shown | Fix before GO |
| RPT-05 | | CSV export matches the screen | HARNESS: export, compare rows and totals; no identifiers beyond what the screen shows | Same rows and totals | Stop |
| RPT-06 | | Client monthly calendar | HARNESS | Visits and shifts on the right days (agency time) | Stop |
| RPT-07 | | Dollar columns only for those allowed | AUTO `access-roles.db.test.ts` | Hidden for Manager | Stop |
| RPT-08 | | Unfilled shift report (filters: month, range, client, caregiver, service, location, weekday, coverage status, urgency, recurring vs one-time; chart, table, drill-down, CSV) | `NOT BUILT` (approved requirement) | Each filter changes rows; CSV equals table | n/a |
| RPT-09 | | Print layout and letterhead | AUTO `letterhead.db.test.ts`, `environment-letterhead-availability.test.tsx` | Agency name and letterhead as configured; test banner never printed as production | Fix before GO |

## AVL: Caregiver availability
**Area rollback:** common order; availability history is retained by the rollback scripts (see `availability-rollback.db.test.ts`).
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| AVL-01 | | A change is a request; approved hours stay until approved | AUTO `availability-approval.db.test.ts`. HARNESS: Alex requests a change; Olivia reviews | Pending shown apart from approved; sent message says current hours stay until approved | Stop |
| AVL-02 | | Decline needs a note; direct edit needs a reason | AUTO `availability-approval.db.test.ts` | Both audited | Stop |
| AVL-03 | | Overnight windows | AUTO `overnight-availability.db.test.ts` | Window crossing midnight covers both days correctly | Stop |
| AVL-04 | | A date exception replaces that day | AUTO `availability-approval.db.test.ts` | Not unioned with weekly hours | Stop |
| AVL-05 | | Daylight-saving and agency time | AUTO `availability-approval.db.test.ts` | Hours in agency time | Stop |
| AVL-06 | | Visit start checks availability once enforcement is active | AUTO `visit-start-availability.db.test.ts` | Report-only agencies warned; active agencies refused without an override | Stop |
| AVL-07 | | Concurrent availability edits | AUTO `availability-approval.db.test.ts` (concurrency) | No lost updates | Stop |

## MAT: Matching and care requests
**Area rollback:** common order; offers and assignments created in testing are cancelled through the product.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| MAT-01 | | Eligibility first, then an explained, provisional score | AUTO `matching.db.test.ts`. HARNESS: Sam opens a care request's candidates | Not-eligible caregivers excluded with a reason; score marked provisional; "Score incomplete" when inputs are missing | Stop |
| MAT-02 | | Wording is Match / Partial Match / No Match | AUTO `matching.db.test.ts`, UI tests in `aws/readiness` | Exact wording | Fix before GO |
| MAT-03 | R | Caregivers never see scores | AUTO `matching.db.test.ts`, `access-roles.db.test.ts` | Hidden from caregiver roles | Stop; security failure |
| MAT-04 | | Manual offer and assignment | AUTO `manual-assignment.db.test.ts`, `care-requests.db.test.ts` | Assignment reserves authorization once; no double booking | Stop |
| MAT-05 | | Public care-request and offer links are token-only | AUTO `care-token-security.db.test.ts` | Invalid, expired or revoked token gives the same generic refusal | Stop; security failure |
| MAT-06 | | Required documents and CPR/TB readiness | AUTO `required-documents.db.test.ts`, `readiness-review.db.test.ts` | Setup gaps reported; unset rules shown as "setup incomplete" | Stop |
| MAT-07 | | Matching uses no invented formula | Review the change against `docs/product/PENDING_RESTORATION.md` | Any scoring change is an owner-approved definition | Stop |

## NTF: Notifications and alerts
Today the AWS build has in-app alerts and token links; it has no SMS or push (replacement-offer texts are pending a PHI decision).
**Area rollback:** common order.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| NTF-01 | | Care alert staff and care notifications lists | AUTO `care-requests.db.test.ts`. HARNESS: Sam | The right staff listed; notifications shown to the right roles only | Stop |
| NTF-02 | | Document expiry reminders and alerts | AUTO `document-reminders.db.test.ts`, `document-expiry-types.db.test.ts` | Expiring items are reminders, not Action needed; overdue items counted | Stop |
| NTF-03 | | Invitation emails | PILOT only (Cognito sends them): invite a synthetic caregiver | Email arrives from the system; no password is shown or stored anywhere in Ogevia | Stop |
| NTF-04 | | No personal data in notification text or URLs | HARNESS/PILOT: read each message and link | Tokens only in the URL fragment; no names, identifiers or diagnoses in subjects or bodies | Stop; security failure |
| NTF-05 | | SMS or push alerts | `NOT BUILT` (PHI decision pending) | n/a | n/a |

## USR: User administration
**Area rollback:** common order. Accounts disabled during testing must be re-enabled **before** rolling back migration 0048 (see its rollback header).
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| USR-01 | R | Roles see only what they should | AUTO `access-roles.db.test.ts`, `workflow.db.test.ts`. HARNESS: each persona opens every menu item | Menus and data match the role; caregiver sees no administrator data | Stop; security failure |
| USR-02 | R | Other agency cannot read or write | AUTO `tenant-assignment-visit.db.test.ts`, `care-token-security.db.test.ts` | Every cross-agency read and write refused | Stop; security failure |
| USR-03 | | Invite a caregiver | AUTO `invitations-planned.db.test.ts`, `identity.test.ts` | Invitation recorded; status "Invitation pending"; no duplicate identity | Stop |
| USR-04 | | Account status in plain words | `PENDING 0047/0048`. AUTO `account-status.db.test.ts`, `accounts.test.tsx` | Active, Invitation Pending, Password Change Required, Disabled, Account Setup Required | Stop |
| USR-05 | | Disable and enable | `PENDING 0047/0048`. AUTO `account-status.db.test.ts`, `apps/sv-api/test/accounts.db.test.ts`. PILOT: a synthetic caregiver | Disabled person cannot load the app; after enable they can; two audit events; your own row has no Disable button | Stop |
| USR-06 | | Only the Administrator manages accounts | `PENDING 0047/0048`. AUTO `account-status.db.test.ts` | Manager sees the notice that only an administrator can manage accounts | Stop |
| USR-07 | | Passwords are never displayed, stored or logged | Review of code and PILOT log search | None found | Stop; security failure |
| USR-08 | | Inactive caregiver loses access | AUTO `caregiver-service-admin.db.test.ts`, `care-team.test.tsx` | Assignments end, sign-in suspended; reactivation restores sign-in only | Stop |
| USR-09 | | MFA required for the pool | PILOT: sign in as the Administrator | MFA prompt; checked read-only by the standard live-status script | Stop |
| USR-10 | | Caregiver readiness: services, documents, availability | AUTO `caregiver-service-approvals.db.test.ts`, `required-documents.db.test.ts` | Approved services separate from assignments; status shown | Stop |

## CMP: Caregiver compliance (background clearance, CPR/TB 14-day period, compliance hold)
**These are OWNER-DEFINED rules (2026-10-17), not verified legal requirements.** Migration 0053; release folder `docs/releases/2026-10-17-caregiver-compliance/`. Enforcement follows the owner's existing activation switch (0042): before activation the checks report and do not block. Personas on the pilot: Olivia Owner (Administrator), Morgan Manager, Sam Scheduler, and two synthetic caregivers made for this run.
**Area rollback:** common order, then `0053_caregiver_compliance_hold.down.sql` (class BACKUP REQUIRED: it drops hire dates, background-check results and hold history; export them first). Holds, flags and verified results created in testing are never edited by hand; resolve them through the product.
| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| CMP-01 | R | Background clearance: only a VERIFIED APPROVED result qualifies | AUTO `db/test/compliance-hold.db.test.ts` ("BACKGROUND: 'completed' alone does not qualify ..."); `apps/sv-api/test/compliance.db.test.ts`. PILOT: Olivia sets a synthetic caregiver's status to Completed, then tries to schedule them | No record, Completed only, and Not approved are each refused with "Background check ..."; after Olivia records Approved with an evidence note the same shift saves | Stop; highest severity |
| CMP-02 | R | Only an administrator verifies; never your own check; evidence note required | AUTO `compliance-hold.db.test.ts` ("only an administrator can verify ..."; "verification needs a valid result and an evidence note ..."). PILOT: Morgan and Sam open the card | Morgan and Sam see no Verify form (403 if called); Olivia cannot verify a record linked to her own sign-in; empty note refused | Stop; security failure |
| CMP-03 | R | The 14-day period: hire date is day 0, the due date (hire + 14) is the LAST day, the hold starts 00:00 the next day in the agency time zone | AUTO `compliance-hold.db.test.ts` ("the 14-day period: exact calculation ...", including daylight-saving days). PILOT: set a synthetic hire date 14 days ago, then 15 days ago | 14 days ago: shift saves, CPR/TB shown Pending with the due date. 15 days ago: refused "CPR missing. TB missing." | Stop |
| CMP-04 | R | A missing hire date never passes | AUTO `compliance-hold.db.test.ts` (same block, "a missing hire date is never a pass") | Without current verified CPR and TB: refused and held with "Hire date is not recorded, so the 14-day period cannot be applied"; entering the real date resolves it | Stop |
| CMP-05 | | CPR-only and TB-only gaps | AUTO `compliance-hold.db.test.ts` ("CPR-only and TB-only gaps ...") | Only the missing requirement is listed; both verified and current: no hire date needed | Stop |
| CMP-06 | R | Stricter existing controls are not relaxed | AUTO `compliance-hold.db.test.ts` ("stricter existing controls are NOT relaxed ...") | Rejected and expired records block on day 1 of the period | Stop |
| CMP-07 | R | Every backend path refuses a held caregiver | AUTO `compliance-hold.db.test.ts` ("every path refuses ..."); `apps/sv-api/test/compliance.db.test.ts` ("direct API bypass attempts ..."). PILOT: Sam tries manual assignment, reassignment; the caregiver tries open-shift pickup and Start visit | Each refused (422 `not_ready`, plain reason); nothing written; a direct database insert is refused by the database too | Stop; highest severity |
| CMP-08 | R | The deadline passes and nobody opens the profile | AUTO `compliance-hold.db.test.ts` ("the deadline passes and NOBODY opens the profile ..."). PILOT after the owner approves the schedule rule: wait for the 15-minute run | Enforcement is immediate; the scheduled run opens the hold (automatic), flags every affected shift (each recurring occurrence) and standing assignment, writes one audit event with no person as actor; a second run changes nothing | Stop |
| CMP-09 | R | A visit in progress is never ended by a hold | AUTO `compliance-hold.db.test.ts` ("a visit in progress is NOT ended ..."). PILOT: hold a caregiver mid-visit | Visit stays open; Caregiver Holds shows an urgent alert; the caregiver can still End visit; completed visits and assignment history unchanged | Stop |
| CMP-10 | R | Release only when everything is resolved; nothing is resumed | AUTO `compliance-hold.db.test.ts` ("partial resolution ..."; "a hold with several causes ..."; "a flagged shift that was reassigned or cancelled ...") | Verifying CPR alone leaves TB listed; the last verification lifts the hold and resolves the flags; cancelled and reassigned shifts stay as they are; new work is allowed again | Stop |
| CMP-11 | | A hold from an ended period is sticky; hire-date edits are controlled | AUTO `compliance-hold.db.test.ts` ("the hold is sticky ..."; "hire date: the office may set ..."). PILOT: Morgan tries to change a recorded date | Morgan refused; Olivia may change it with a reason and the hold stays; entering a first-time date for a missing one is allowed and audited | Stop |
| CMP-12 | R | Audit: hire date, background status and result, documents, holds | AUTO `compliance-hold.db.test.ts` ("background changes are audited ...", "hire date ... audited"). PILOT: read the audit events for the synthetic caregiver | Each change shows who, when, old and new value, and the reason; automatic hold events have no person as actor | Stop |
| CMP-13 | R | Action needed shows the shifts to cover | AUTO `apps/web/src/aws/compliance/compliance.test.tsx` ("Caregiver holds page ...", "Action needed"). HARNESS/PILOT at 390 px: Morgan opens Home, then Caregiver Holds | A "Caregiver Holds" line with shifts to cover plus visits in progress; the page lists reason with a fix link, shifts (recurring marked), standing assignments, no horizontal scrolling | Stop |
| CMP-14 | | Profile Compliance card | AUTO `compliance.test.tsx` ("the profile's Compliance card ..."). HARNESS: Olivia then Morgan open a caregiver | Eligible / Pending / On hold wording; due date and "A hold starts at 12:00 AM on <next day> (America/Los_Angeles)"; Verify form for Olivia only | Fix before GO |
| CMP-15 | R | Before activation nothing is blocked and nobody is stranded | AUTO `compliance-hold.db.test.ts` ("report-only first ..."). PILOT: Olivia opens Readiness | Report lists who would be held and why; no hold exists; schedule and visits unchanged | Stop |
| CMP-16 | R | Permissions and other agencies | AUTO `compliance-hold.db.test.ts` ("compliance is read by staff only ..."); `apps/sv-api/test/compliance.db.test.ts` | Caregivers 403; another agency 404; nothing leaks across agencies | Stop; security failure |
| CMP-17 | | The scheduled run | AUTO `apps/sv-api/test/scheduled.test.ts`, `infra/aws/test/service-verification-api-stack.test.ts` ("the compliance run ..."). `NOT DEPLOYED`: the rule needs the owner's approval | The rule is 15 minutes, one target, constant payload, retried once; a failed agency fails the run and logs only counts and a code | Stop |

---

## UIS: Alerts by purpose, simpler documents and financial section, appearance
Migration 0054; release folder `docs/releases/2026-10-18-interface-simplification/`. The 24-hour urgent window is an assumption awaiting owner review. Personas: Olivia Owner, Morgan Manager, a caregiver.
**Area rollback:** common order, then `0054_attention_streams_appearance.down.sql` (BACKUP REQUIRED: drops saved appearance choices).

| ID | R | What | How | Expected | If it fails |
|---|---|---|---|---|---|
| UIS-01 | R | Four alert tiles with their own pages | AUTO `attention-badge.test.tsx`. PILOT: Home, click each tile | Needs attention now, Upcoming staffing, Documents & compliance, Visit review open `/attention`, `/staffing`, `/documents`, `/visit-review`; each page's row count equals its tile | Stop |
| UIS-02 | R | 24-hour split | AUTO `attention-streams.db.test.ts`. PILOT: create an uncovered shift 5 hours out and one 3 days out | 5 hours: Needs attention now (red); 3 days: Upcoming staffing only | Stop |
| UIS-03 | R | Unscheduled visit is not an uncovered shift | AUTO `attention-streams.db.test.ts`. PILOT: caregiver starts an unscheduled visit | Counted in Visit review only, never in staffing | Stop |
| UIS-04 | R | Unique counts and labelled issues | AUTO both test files. PILOT: a shift with a held caregiver and a non-current document | One item, "2 issues across 1 item"; Visits needing attention equals the number of visits | Stop |
| UIS-05 | R | Held caregiver's imminent shift is not hidden | AUTO `attention-streams.db.test.ts`. PILOT: hold a caregiver with a shift tomorrow | Appears in Needs attention now with "Review compliance record"; always listed on Caregiver holds | Stop; highest severity |
| UIS-06 | R | Severity colours always have words | AUTO `attention-badge.test.tsx`; `theme-contrast.test.ts` | Urgent (red, dot), Soon (amber, triangle), Routine (neutral, circle); red only for blocked or at-risk care | Fix before release |
| UIS-07 | R | Document cards simplified, nothing lost | AUTO `interface-simplification.test.tsx`. PILOT: open a card, press Details with the keyboard | Name, caregiver, one status, View, Replace visible; reviewer, times, versions, exact date in Details; Replace keeps earlier versions | Fix before release |
| UIS-08 | R | Due soon and Overdue are separate filters | AUTO `interface-simplification.test.tsx` | Overdue lists expired and overdue only; Due soon lists expiring only; counts match the Documents tile | Stop |
| UIS-09 | R | Financial empty states | AUTO `interface-simplification.test.tsx`. PILOT: month with an authorization missing a rate | One message with the count and Review authorizations; no "Unavailable" cards; no $0; no cost/margin | Stop |
| UIS-10 | R | Appearance saves, overrides and is isolated | AUTO `interface-simplification.test.tsx`, `attention-streams.db.test.ts`. PILOT: Morgan picks Dark; Olivia sets agency Warm cream | Morgan sees Dark, others Warm cream; Morgan cannot set agency defaults; reload keeps it | Stop |
| UIS-11 | R | Charts honest | AUTO `interface-simplification.test.tsx` | Donut keeps values and percentages; Line falls back to bars with a note; totals and units always shown | Fix before release |
| UIS-12 | | Phone and keyboard | MANUAL at 390 px and keyboard only, on Home, Documents, attention pages, Appearance | No sideways scroll; Details and filters work by keyboard and touch; targets 44 px | Fix before release |

## Adding to this catalog
Every new feature adds its rows in the same change, with all of: ID, What, How, Expected (exact), If it fails. A defect found in production or UAT adds a **permanent** regression row. When a defect marked `OPEN DEFECT` is fixed, remove `.fails` from its test, remove the tag here, and add the row's `R` mark if the area is high-risk.
