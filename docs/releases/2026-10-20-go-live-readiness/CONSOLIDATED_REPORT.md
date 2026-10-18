# Ogevia go-live readiness: consolidated report (LOCAL; nothing pushed, merged or deployed)

Baseline: `4029176795264bf9c0532d8d2029910e493b3c02` (branch `local/review-updates`). This report's own commit is the HEAD recorded in the backup. Environment of all test evidence: local developer container, PostgreSQL 16, synthetic data, Node 22. None of it is CI, TEST or Production evidence.
Publication states: local commits only. Not pushed. Not merged. Not deployed to TEST. Not deployed to Production. Enforcement not activated anywhere. No AWS, Netlify, Supabase or GitHub setting was read or changed.

## A. Executive readiness assessment
| Stage | Decision | One-line basis |
|---|---|---|
| Controlled synthetic-data pilot | **CONDITIONAL GO** | The product logic is verified locally (accounting, eligibility, concurrency, isolation, 9 workflows mostly). It is not yet deployed or run on TEST with real sign-in. |
| Real-customer pilot with PHI | **NO-GO** | No breach/incident procedure or owner, no risk analysis, BAAs not evidenced, no restore drill at the current schema, TEST and production share a credential and a Cognito pool, legacy Supabase/Netlify path unresolved. |
| General production launch | **NO-GO** | All of the above plus: production ledger never read, no stable build identification, 6 alarms, CI never run on this SHA, no real-device, screen-reader or load testing. |
Technical completion is not operational readiness: unit and database tests prove rules, not the agency journey on deployed infrastructure.

## B. Evidence matrix (requirement, location, evidence, status, risk, correction and owner)
Env/SHA for every PASS row: local, baseline plus the go-live commits (see section E). "PASS (local)" never means deployed.
| # | Requirement (source) | Implementation | Evidence | Status | Risk | Correction / owner |
|---|---|---|---|---|---|---|
| 1 | Capacity cannot be exceeded by concurrent consumption (directive 4) | migration 0082 `lock_visit_lineage` in end, close-missed, void, decide, revoke, void-rounding | `lineage-lock-race.db.test.ts` 12 tests, two connections; reproduced 645 of 600 on 0081, fixed on 0082; 40 random interleavings, no deadlock | PASS (local) | Critical if absent | deploy 0082 to TEST (owner approval) |
| 2 | Residual: ending, close-missed and reopen are never refused for capacity | by design | test shows 645 of 600 shown as Over limit when serialised after a shift that took the last minutes | OWNER DECISION | Medium | owner (register 1) |
| 3 | Pending, reserved, billable, rounding equation per authorization | 0079, 0081 | `hours-accounting` 20+1, `pending-hours-guards` 18, `review-reopen-accounting` 12 | PASS (local) | High | none |
| 4 | Unreserved Pending counts when deciding if more work fits | 0081 guards | failing-first on 0080 (605 of 600 accepted); races: one of two 300s wins, five of six 100s | PASS (local) | Critical | deploy |
| 5 | Closed-not-billable: worked time preserved, no automatic capacity restore | 0081 labelling; no release path | tests; no governing release rule exists (HOURS_ACCOUNTING.md, 0052 README) | PASS (local); POLICY OPEN | High | owner (register 2) |
| 6 | Immutable audit with actor, time, reason, before and after | audit_events, decisions; 0082 adds previous values | `review-reopen-accounting` asserts all five fields and rejects UPDATE/DELETE; app role has no table access | PASS (local) | High | deploy 0082 |
| 7 | No double counting on reopen, re-close, late confirmation, rounding apply/void, correction | existing + 0082 | same suite, equation checked at every step | PASS (local) | High | none |
| 8 | Timezone, month-end, DST, idempotent retry | existing | `hours-month-boundaries` 4 tests (fall-back, spring-forward, month-end midnight, retry gives one shift) | PASS (local) | Medium | none |
| 9 | Tenant isolation and role access | RLS, organization checks in functions | `tenant-isolation-sweep` 9 tests: 228 routes = 212 swept + 10 public token + 6 caller-only; 424 probes, 0 leaks; fingerprint of every org-A row in 60+ tables unchanged | PASS (local) | Critical if failed | live re-test on TEST with two real orgs |
| 10 | CPR/TB: verified current documents required; no grace bypass; 14-day hold kept | 0081 | `cpr-tb-verified-required` 12 (failing-first on 0080): blocks all assignment paths and visit start when enforced; warns when report-only | PASS (local) | High | enforcement activation is an owner action, not done |
| 11 | Assignment outcome Allowed / Warning / Blocked from one server decision | 0078 | `assignment-outcome` 10+2 | PASS (local) | Medium | none |
| 12 | Document upload fix (client-documents key) | CDK role and endpoint policy | policy test fails without the fix; live error never observed | LOCAL FIX; NOT TESTED on TEST | High | approve NetworkEgress then ServiceVerificationApi deploy; NetworkEgress is shared with production (owner gate) |
| 13 | Form-state preservation in a real browser | schedule form etc. | Add shift: tab switch PASS; reload FAIL (input lost, no warning); back-navigation FAIL (lost). Other forms and sign-out cases NOT RUN. Appearance change in another tab does not reach an open tab. Unit test proves all 8 appearance combinations keep input | PARTIAL | Low to medium | owner decision (register 6) |
| 14 | Five approved boards reconciled | FIVE_BOARD_COMPARISON.md addendum | approved handoff zip not available | BLOCKED | Medium | owner supplies the zip |
| 15 | Authorization-management workflow understandable | client page Add / Amend / Renew; nav "Authorization changes" (label unified) | traced in code; add/amend verified in browser (W1) | PARTIAL | Medium | owner decision (register 5): no "End authorization", no all-clients list |
| 16 | Usability: duplicate client label on phone row, repeated impact text, disabled contrast, small controls | schedule-page, amendment-impacts, button.tsx, many controls | focused tests, 7 contrast cases (>= 3:1 on 4 backgrounds), a11y smoke 10 tests | PASS (local) for code; NOT RE-MEASURED in a browser | Low | none |
| 17 | Keyboard and screen reader | structural tests only | NVDA, JAWS, VoiceOver | NOT TESTED | Medium | a person with a real device |
| 18 | Real-device phone layout | emulated 390 px only | 106/106 scripted checks desktop and phone | NOT TESTED on devices | Medium | pilot acceptance step |
| 19 | End-to-end workflows 1 to 9 | see section C2 | browser-scenario 106/106 desktop, 106/106 phone; workflows.mjs partly | PARTIAL | Medium | finish on TEST |
| 20 | Cognito, encryption, secrets, backups, monitoring, HIPAA safeguards | CDK and docs | SECURITY_PRIVACY_EVIDENCE.md (each row classified) | PARTIAL: many UNVERIFIED | Critical for PHI | see register and Go/No-Go |
| 21 | Stable commit identification, CI on exact SHA | none | `ci.yml` never ran on this SHA; no version stamp in web or API | FAIL / NOT TESTED | High | build-stamp change then CI on the release SHA |

## C. Defect register
### C1. Defects found in this directive
| ID | Defect | Severity | State |
|---|---|---|---|
| R1 | Visit end, close-missed, void, decide, revoke and rounding-void changed consumed minutes without the lineage lock; 645 of 600 committed | Critical | FIXED in 0082, verified locally; NOT deployed |
| R2 | Review decision, revoke and late-review audit rows lacked previous values | High | FIXED in 0082 (audit tests), local |
| R3 | 0082 first draft failed the static `search_path` convention | Low | FIXED (syntax normalized; static test and 43 affected DB tests re-run) |
| R4 | Add shift: choosing "Open shift - fill later" snapped back to the single assigned caregiver (found by the browser run) | Medium | FIXED; regression test fails without the fix |
| R5 | Client page readiness card and alerts stayed stale after Add authorization until reload (found by the browser run) | Low to medium | FIXED (query invalidation); regression assertion fails without the fix |
| R6 | Disabled primary, danger, secondary and ghost buttons below 3:1 | Low | FIXED in the shared Button; not re-measured in a browser |
| R7 | Phone Unfilled row named the client twice; authorization-impact cards repeated client, version and amendment text | Low | FIXED (local) |
| R8 | Documents page skipped a heading level (h1 then h3) | Low | FIXED |
| R9 | Infra test type error (`closedHeld`) and one ESLint unused variable | Low | FIXED earlier at the Batch 5 checkpoint |
### C2. Workflow results (engineer C, local harness, emulated phone)
| W | Workflow | Result | Evidence and remaining risk |
|---|---|---|---|
| 1 | Client intake, profile, authorization, amend | PASS (pieces) | 10 h authorization shown; zero hours and end-before-start refused; amend keeps version 1 in history; edits audited by field name only |
| 2 | Caregiver onboarding, documents, eligibility | PASS (earlier piece) | Approved refused with items outstanding; second account verifies CPR/TB; blocked caregiver accepted after availability and service approval. Not re-run in the final run |
| 3 | Scheduling, recurring, cancel, make-up, pickup | PASS | overlap refused, weekly series 3 shifts, cancel needs a reason, make-up linked, pickup request confirmed by office |
| 4 | Authorization consumption, amendments, warnings | PASS | Near Limit shown; next shift refused with hours left; raise lets it through; lower to 5 h keeps shifts and lists them for review |
| 5 | Visit start, end, confirmation (phone) | PASS | double tap gives one visit; reload keeps it in progress; offline End records nothing, retry gives one Time Out; signature stored with role, method and object reference; verbal and unable-to-confirm go to administrator review |
| 6 | Missed, disputed, closure, correction | PARTIAL | missed time-out, close-not-billable with reason, dispute link and code PASS. Correction NOT proven in the browser (test-data overlap, not an app defect) |
| 7 | Roles and isolation in the UI | PASS on facts | scheduler refused billing and accounts; manager sees no dollar values; caregiver refused on 8 of 9 admin routes; `/attention` renders for a caregiver (server returns what a stranger gets: no data; low) ; other-organization lookups return 404 or empty 200, never data |
| 8 | Reporting, reconciliation, billing readiness | PASS (one check script row missed) | ready-for-review and not-billable states correct; over-approval refused; page says not submitted or paid |
| 9 | Interrupted operations | PARTIAL | offline retry and double tap PASS; reload mid-confirmation keeps the visit and loses typed text; sign-out in another tab NOT RUN |
Not testable locally: real phone touch and keyboard, real session expiry, deployed API Gateway and Cognito, real email, SMS and S3.
### C3. Unresolved and newly discovered
| ID | Item | Severity | Owner |
|---|---|---|---|
| U1 | Ending, close-missed, reopen never refused for capacity (shown as Over limit) | Medium | owner decision |
| U2 | Correcting a visit with an active close: close stays on the superseded original (pinned in a test) | Medium | owner decision |
| U3 | Add shift loses input on reload and back navigation; sign-out in another tab not noticed by the open tab | Low to medium | owner decision |
| U4 | No "End authorization" action and no all-clients authorization list | Medium | owner decision |
| U5 | Other-organization list calls return 200 with empty bodies rather than 403 (no leak; no existence oracle) | Low | accepted unless owner prefers 403 |
| U6 | Scheduler can read approved-minutes in monthly-approval-summary | Low | owner confirm |
| U7 | Duplicate seed document types ("TB result" and "TB test result"): harness data | Info | none |
A local fix is never counted as deployed.

## D. Authorization accounting assessment
Definitions (HOURS_ACCOUNTING.md): Authorized = Billable + Rounding + Pending + Reserved + Hours left; Hours left may be negative and is shown as Over limit, per authorization, never offset between authorizations. Worked-not-billable and closed-not-billable sit outside the equation as visible lines: worked time is never redefined as capped billable time.
Worked examples verified by tests: authorized 600 with 45 Pending (unscheduled, awaiting confirmation) gives Hours left 555; closed-not-billable on a 130 shift: Pending 130 becomes 0, Reserved 130, worked 60 kept, Hours left 470 before and after; rounding +10: billable 50 + rounding 10 + pending 45 + reserved 100 + left 395 = 600; worked 150 on 100: Hours left 0 and 15 more minutes refused.
Concurrency: every path that consumes or reclassifies minutes now takes the lineage lock (0082) except release-only paths (cancel, series cancel). Capacity is protected for scheduling; completion paths are not refused.
Audit: actor, time, reason, previous and new values asserted for decide, revoke, late review, rounding approve and void, correction; audit tables reject UPDATE and DELETE.
Open rule: no governing rule allows releasing a reservation when a review is closed not billable. The default (keep holding, show it) is kept.

## E. Deployment readiness (prepared, NOT executed)
Full detail: ENVIRONMENT_AND_RELEASE_PLAN.md (10 approval gates) and SECURITY_PRIVACY_EVIDENCE.md.
- Migration dependency: TEST ledger last known at 0077 (owner operation 2026-10-18); this branch adds 0078 to 0082 (functions only, each with a rollback). Production ledger never read; its last known release is 38 migrations (2026-10-10), so a production release would apply a long contiguous run. `deploy-production.sh` still carries a "0001 to 0038" comment to review.
- AWS changes: NetworkEgress then ServiceVerificationApi (document-upload policy). Correction to earlier statements: production is `Ogevia-prd-*` / `ogevia_prd`; the `prod`-named stacks serve TEST (`ogevia_sv_test`), but TEST and production share one RDS instance, one master credential, one Cognito pool and the egress endpoints, so the endpoint-policy deploy also touches production's path (owner gate).
- Gaps: no web or API build stamp (cannot prove which commit is deployed); CI never run on this SHA; `candidate-pins.txt` and the CI bundle step are stale; only 6 alarms (none for auth failures, latency, DB connections or the ComplianceSweep).
- Rollback and recovery: function migrations have tested rollbacks; the only restore drill was 2026-10-03 at migration 0012, database only: a drill at the current schema, for `ogevia_prd`, and joint with S3 and Cognito is required before PHI.
- Proposed (not implemented) rollback triggers and health thresholds are in the plan.

## F. Go / No-Go
**1. Controlled synthetic-data pilot: CONDITIONAL GO.** Conditions (acceptance criteria): (a) owner approves and executes TEST deployment of migrations 0078 to 0082 with a ledger check and snapshot first; (b) NetworkEgress and ServiceVerificationApi deploy approved, then a real document upload, second-account approval and reload persistence on TEST; (c) the 9 workflows re-run on TEST with real Cognito logins incl. a real phone for visit start and signature; (d) owner decisions 1 to 4 below recorded; (e) a named person owns TEST incidents. Enforcement stays off until the owner activates it deliberately, after (a) to (c).
**2. Real-customer pilot with PHI: NO-GO.** Blockers: no breach or incident procedure or named owner; no risk analysis, workforce training or sanction policy in the repository; AWS BAA only owner-stated and no evidence for Netlify, Supabase, Twilio or the email provider; RDS, Cognito and security-group settings not in code and only owner-reported 15 days ago; no restore drill at the current schema or for `ogevia_prd`; TEST and production share a master credential, Cognito pool and endpoints; the `ogevia-web` 5-day refresh token is accepted by the production authorizer; the legacy Supabase/Netlify path may hold PHI; alarms and on-call absent. Acceptance: every Critical row in SECURITY_PRIVACY_EVIDENCE.md closed with live evidence, a successful restore drill, and a clean TEST acceptance run.
**3. General production launch: NO-GO.** All PHI-pilot blockers plus: production ledger unread, no commit identification, CI never run on the release SHA, no real-device, screen-reader or load testing, no rollback rehearsal, and no pilot learning yet.

## G. Owner decision register (decisions only the owner can make)
| # | Decision | Recommendation | Alternatives | Consequence |
|---|---|---|---|---|
| 1 | Ending a visit, closing a missed visit or reopening when no capacity remains: refuse or accept and show Over limit | Accept and show Over limit for ending and close-missed (the care happened); refuse reopen when it would exceed the limit | refuse all; accept all | refusing hides worked time or strands a caregiver mid-visit; accepting needs an Over-limit review routine |
| 2 | Release a shift reservation when a review is closed not billable | Do not release automatically; allow release only by an explicit, audited action by a permitted role once the authorization rule is written | automatic release; never release | automatic release can restore capacity for non-billable time against payer rules |
| 3 | Correcting a visit that has an active close | Refuse the correction until the close is revoked | carry the close forward | carrying forward silently classifies a new record |
| 4 | Provisional hold for a draft unscheduled visit | No hold | hold | a hold blocks scheduling for visits that may never occur |
| 5 | Authorization management scope | Add "End authorization" now; add an all-clients Authorizations list before the pilot scales | defer both | managers must open each client; ending needs the Amend form with an earlier end date |
| 6 | Unsaved form input on reload, back navigation and sign-out | Warn when a form is dirty; no draft storage | keep dirty-form URL state; do nothing | silent loss of a half-typed shift |
| 7 | Separate TEST and production Cognito pool, master credential and egress endpoints before any PHI | Separate | keep shared | shared resources let a TEST change affect production |
| 8 | Legacy Supabase/Netlify path: confirm whether it holds real PHI and retire or cover it | Confirm now; if PHI, treat as a blocker for the PHI pilot | leave | an unmanaged PHI store is a compliance risk |
| 9 | Name owners: incident/breach lead, security officer, on-call, BAA custodian | Assign before the synthetic pilot starts | assign at the PHI stage | no one is responsible when an alarm fires |
| 10 | Approve the TEST deployment sequence (0078 to 0082, NetworkEgress, ServiceVerificationApi, web) | Approve as one rehearsed step with snapshot and ledger check | piecemeal | piecemeal deploys risk mixed states |

## Test results used (all local, synthetic; counts describe only what ran)
Final integrated tree: infra DB 92 files / 961 tests; API DB 19 / 133; infra default 14 / 206; API unit 3 / 74; UI 20 / 73; web 122 / 1,191; typecheck clean (web, API, infra, UI); web eslint clean; web build succeeded. Browser scripted checks on the pre-fix tree: desktop 106/106, phone 106/106; workflows.mjs never ran green end to end. Appearance matrix 192 configurations (earlier tree; not re-run: unchanged UI affected only by contrast and target-size fixes). The reported counts at the baseline were produced in this session, not by CI, and were re-run on the final tree rather than reused where code or migrations changed.
