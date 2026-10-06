# Ogevia controlled-pilot scope: status against the consolidated requirements

**Date:** 2026-10-05. **Builds:** (a) the 0019–0021 increment, revision 69e8799, is **LIVE in AWS TEST (owner-reported 2026-10-05)**: live verification 10/10 PASS, post-check all PASS (records unchanged by value), manager account created with the role check true/false/false (approve hours yes, see money no, change branding no). The first attempt (1a39dd5) had failed at 10/12 on the Lambda policy limit and was rolled back. (b) Release 0022–0026, packaged in `infra/aws/slice/release-0026-bootstrap.sh`, is next.
**Verdict: NOT READY FOR OGEVIA CONTROLLED PILOT (real clients).** The blockers are in the summary at the end.

## Status key

| Status | Meaning | Evidence class |
| --- | --- | --- |
| **LIVE** | Deployed to AWS TEST through migration 0018 (pilot build 87a9be2) | Owner-reported deployment 12/12. Phone results C and part of G passed 2026-10-04. Live check ledger 0018. |
| **LIVE 0021** | In the 0019–0021 increment (revision 69e8799), live in AWS TEST since 2026-10-05 (owner-reported: 10/10 live checks, post-check all PASS). Phone checks of the changed screens still pending. | Owner-reported live evidence; phone checks pending |
| **RELEASE 0025** | In release 0022–0025 (built, tested, deployment package prepared). Not deployed. | Local tests and scope gate; needs the live run plus screen checks |
| **NEEDS IMPLEMENTATION** | Not in either build for AWS. Either absent, or only in the old Supabase build. | Repository search (cited) |
| **BLOCKED** | Waiting on an owner action or decision | Cited |

## 1. Roles and access

| Requirement | Status | Evidence |
| --- | --- | --- |
| Owner shown as **Administrator** everywhere; ADMINISTRATOR / MANAGER / CAREGIVER VIEW with name, then email | LIVE 0021 | `aws-workspace.ts` (`viewKind` → `ADMINISTRATOR`), `aws-shell.tsx`. Error messages in 0020/0021 and the API now say Administrator. Test: `aws-app.test.tsx` "organization_owner sees ADMINISTRATOR VIEW". |
| Internal `organization_owner`, memberships, permissions and audit history preserved | LIVE (unchanged) | Display-only change. Migrations 0019–0021 add permissions and do not rename roles. |
| Administrator sees rates and money | LIVE 0021 | `billing.read` is granted to `organization_owner` only (0019). Tests: `access-roles.db.test.ts:143`, `workspace.db.test.ts:191`. |
| Manager: operations and approving billable hours, no rates or money in pages, API or exports | LIVE 0021 | Money is returned only by `list_billing_approvals` and `get_utilisation_overview`, and only with `billing.read`. No other function returns rate or amount columns. The app role has no table privileges (`db:verify` `app_role_has_no_table_privileges`). Tests: DB `access-roles.db.test.ts:141`; API `workflow.db.test.ts:390`. **Live check added:** `pilot-manager-account.sh` runs as the new manager and requires `billing.approve` = true, `billing.read` = false, `organization.update` = false, and 0 rows with dollar values. Rehearsed: manager 0 rows with dollars; the Administrator sees dollars on 2 rows. There are no exports in the AWS build. |
| Caregiver: own assignments, visits, availability, documents | LIVE (visits, availability); THIS DEPLOYMENT (My documents) | Pilot phone section C; 0021 `documents.manage_own` |
| Platform Administrator distinct; agency isolation | LIVE | No platform-admin role in the AWS build. Isolation: `05_tenant_boundaries.sql` verification and tests `managerB` → `[]`. The phone isolation check (G) has not been re-reported. |
| `admin.ogevia@gmail.com` is Administrator | LIVE (done 2026-10-04, not repeated) | Owner-reported read-back and audit event |
| Caregiver invitations from the Care Team screen (manager or Administrator); caregiver role only; server-checked agency and role; invite and resend audited; no password shown or logged; invited / first-signed-in status shown | RELEASE 0025 | 0025 `begin/complete_caregiver_invitation`, `begin_invitation_resend`, `note_my_sign_in`; identity Lambda with AdminCreateUser/AdminGetUser on the one pool only; tests `invitations-planned.db.test.ts` (11), API (2), identity unit (4), web (2). Staff sign-ins cannot be attached (test). |
| Separate manager sign-in in the pilot agency | THIS DEPLOYMENT (runs after the deployment) | `ogemails+ogevia-pilot-manager@gmail.com` via `pilot-manager-account.sh`. Rehearsed: refuses with no owner, applies once, a re-run changes nothing, and the rollback file works. |

## 2. Branding and agency settings

| Requirement | Status | Evidence |
| --- | --- | --- |
| Agency name, colour (contrast-checked), preview, save | LIVE 0021 | `workspace-settings-pages.tsx`, 0020 `set_organization_branding` |
| Logo upload and removal; private storage; appears for every role and on printed reports | LIVE 0021 | 0020 logo functions, private S3 `{org}/branding/logo/*`, letterhead fetch |
| **Reset** branding to default | NEEDS IMPLEMENTATION (small) | No reset control; the colour can be set back manually |
| Ogevia shown subtly | LIVE 0021 | "Powered by Ogevia" in the header |
| Services, timezone and operational rules configured per agency without hard-coding | PARTIAL: services BUILT, NOT YET DEPLOYED (0023); timezone and rules NEEDS IMPLEMENTATION | No AWS API to create or edit services or set the timezone. Services and the agency are seeded by SQL (`04_seed_scs_pilot_synthetic.sql`). Shared code has no SoCal or IRC logic; the seed is agency data. |

## 3. Navigation and mobile

| Requirement | Status | Evidence |
| --- | --- | --- |
| Menu button showing the current page; Sign out | LIVE 0021 | `aws-shell.tsx` (longest-path match) |
| NEEDS ATTENTION in bold red uppercase, with a count and a link | LIVE 0021 | `aws-shell.tsx`, 0020 `get_attention_summary` |
| Visit records open on the list; one date-range dropdown; collapsible filters; phone cards with status; column chooser kept; unambiguous dates | LIVE 0021 | `service-verification-reports-page.tsx`. Browser scenario 42/42 earlier. |
| Plain-language labels (for example `unable_to_confirm` shown raw) | PARTIAL | Recovery defect 4 is still open |
| Ogevia, CareScore, AskCare, Service Verification and Care Requests naming | PARTIAL | CareScore and AskCare are not in the AWS build (see 12) |

## 4. Clients, caregivers and services — **launch blocker**

| Requirement | Status | Evidence |
| --- | --- | --- |
| Create, view, update and activate/deactivate **clients** from screens | **RELEASE 0025** (migration 0022) | Clients list and client page: add, edit details, change status with a reason (refused while a visit is in progress), configurable client types, city. Audited. Tests: DB 12, API 2, web 8, browser 28/28 at 390 px. |
| Same for **caregivers and services** | **RELEASE 0025** (migration 0023) | Care Team: add (random code), rename, status with a reason. Making a caregiver **inactive ends their active assignments and suspends their sign-in for the agency at once** (refused while a visit is in progress); reactivation restores the sign-in only. Services (Administrator only): add (code fixed, unique per agency), rename, deactivate/reactivate with a reason; deactivation refused while current authorizations use the service. Audited. Tests: DB 7, API 2, web 5, browser 20/20 at 390 px, including a signed-in caregiver losing access. **Not included:** inviting a caregiver to sign in (needs the API to create Cognito users, a security decision). | The AWS database API has no create or update function for clients, caregivers or services (full list of `ogevia_api` functions checked 2026-10-04). Records come from SQL seeds. |
| Administrator and manager see client names | LIVE 0021 | 0020 `client_private_names`, `clients.names.read` |
| Caregiver restrictions; payer identifiers protected | LIVE | Caregivers see codes only. Payer and authorization numbers are not returned to caregivers. |
| Location/city and configurable client type | RELEASE 0025 (0022) | `clients.city`, per-agency `client_types`; names and city returned only with `clients.names.read` |
| **Ordinary administration without database commands** | **NOT MET live; MET in RELEASE 0025 except shifts** | After release 0025: clients, authorizations, caregivers (with invitations), services and assignments from screens. Shifts are still created only through Care Requests. |

## 5. Authorizations and hours

| Requirement | Status | Evidence |
| --- | --- | --- |
| Service-specific monthly minutes, period start and end, remaining balance | LIVE (data and calculations) | `client_authorizations`, reconciliation and summary reports |
| Amendments keep history (versioned lineage) | LIVE (database) | `amend_client_authorization`; `06_authorization_invariants.sql` |
| No double allowance or double counting; calculated per client, service and period | LIVE | `no_overlapping_current_authorizations`; reservations; tests |
| **Create or amend authorizations from a screen** | **RELEASE 0025** (0022) | Add (version 1); overlapping coverage for the same client and service is refused with "amend that one instead"; minutes 1–44,640 (catches hours typed as minutes); amend creates a new version with a reason, keeps history, carries the rate forward and lists visits to review. Balances come from the existing `list_monthly_service_summary`, so there is one calculation. Only the Administrator can set a rate (`authorizations.rates.manage`), and only `billing.read` sees it. Concurrent overlapping creations: exactly one succeeds (test). |
| Warnings for approaching limits, overages and expiry | PARTIAL | NEEDS ATTENTION counts review and overage visits; there is no expiry warning |
| Worked hours kept when not billable | LIVE | `worked_minutes` versus `billable_minutes`; administrator review |

## 6. Scheduling and coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| Availability; shifts created through Care Requests with authorization checks | LIVE | Pilot section B (pre-deployment result; B4 refusal not re-reported) |
| Visits linked to scheduled shifts; unscheduled visits flagged for review; overlaps prevented | LIVE | 0016/0017 shift link; `start_ad_hoc_service_visit`; one open visit per caregiver; overlap check in close-out |
| Staff-scheduled shifts, call-outs (staff and caregiver), replacement caregivers, uncovered-shift view, coverage history screens | **BUILT, NOT YET DEPLOYED** (0026, in release 0022–0026) | Schedule page (week, NEEDS COVERAGE count, add, call-out, assign, cancel, history); My shifts for caregivers. Hours reserved against the authorization under the lineage lock; overbooking refused (concurrency test). Bug found and fixed: reservations without a Care Request were not counted by the existing helper. Tests: DB 9 + 2 rollback, API 1, web 4, browser 22/22 at 390 px. |
| Assignment management screens | **RELEASE 0025** (0024) |
| Plan an assignment before the caregiver has a sign-in (planning separate from access) | RELEASE 0025 (0025) | Planned assignments grant nothing; access starts automatically once the record has a linked sign-in and is Ready or Active, and stops if it returns to Onboarding. Visit start unchanged. Tests: 5 DB, 1 API, 1 web. | On the client page ("Caregivers assigned") and the caregiver page ("Clients assigned"): assign with a first day (defaults to the agency's local today) and an optional last day. The caregiver must have a sign-in; overlapping assignments for the same caregiver, client and service are refused (two simultaneous attempts: exactly one succeeds); a missing authorization is flagged in red, not hidden. End with a reason: a future assignment is cancelled; a running one gets a last day (shortening only); ending before today is refused while a visit is in progress. Audited. Tests: DB 7, API 1, web 2, browser 19/19 at 390 px (a caregiver gains the client on Verify visit once assigned). |

## 7. Visit verification

| Requirement | Status | Evidence |
| --- | --- | --- |
| Select, start, end, confirm; resume after interruption; server times; no-signer path | LIVE | Phone section C PASS (Oct 4, 00:51–01:30 UTC) |
| Scheduled and actual times separate; missing Time Out (manager close-out); missing confirmation; corrections keep the original, reason, editor and history; short visit references | LIVE | 0015, 0018, `visit_number_snapshot`. Sections E and F have not been re-reported on the deployed build. |

## 8. Billing-hour approval

| Requirement | Status | Evidence |
| --- | --- | --- |
| Managers and Administrators approve eligible billable hours; duplicates prevented; approved visits cannot be corrected until voided | LIVE 0021 | 0019; tests; the same rule was proven for production in `supabase/tests/billing-correction` (14 paths, 5 concurrency cases) |
| Worked, confirmed, billable, Billing Ready and Billing Approved kept distinct; approval separate from confirmation and document verification | LIVE 0021 | `billing-review-page.tsx`, 0019 |
| Managers cannot get rates or dollars | THIS DEPLOYMENT, with a live check | See section 1 |
| Automatic payer submission | Out of scope (decided) | — |

## 9. Administrator utilisation dashboard

| Requirement | Status | Evidence |
| --- | --- | --- |
| Monthly per service: authorized, scheduled, worked, billable, approved, remaining; potential value for the Administrator only, labelled as potential | LIVE 0021 | 0020 `get_utilisation_overview`, `home-page.tsx`. Unrated authorizations are excluded, not counted as $0. |
| Confirmed hours as a separate figure | NEEDS IMPLEMENTATION | Not a separate column |
| Breakdowns by client, location/city and client type | NEEDS IMPLEMENTATION | Per service only; city and client type are not in the schema |
| Daily, weekly and custom periods; trends over time | NEEDS IMPLEMENTATION | Monthly only |
| Upcoming uncovered shifts, expiring authorizations, unused hours with no future coverage | NEEDS IMPLEMENTATION | — |
| Projected end-of-period usage and shortfall, labelled as estimates | NEEDS IMPLEMENTATION | — |
| Future scheduled time kept apart from actual usage | LIVE 0021 | Separate `scheduled_minutes` and `worked_minutes` |

## 10. Reports and printable calendar

| Requirement | Status | Evidence |
| --- | --- | --- |
| One client per monthly calendar; agency branding; full client name; per service: authorized, worked, remaining; caregivers combined and not named; landscape print without navigation | LIVE 0021 | `buildMonthCalendar` (grouped by service, never caregiver); "Authorized / Remaining to schedule" table; print styles |
| Daily totals reconcile to the month; filters cannot produce partial client totals | LIVE 0021 | The calendar runs its own whole-month query, independent of list filters |
| Operational reports with working filters and column preferences | LIVE, improved in THIS DEPLOYMENT | Reports page |

## 11. Documents and credentials

| Requirement | Status | Evidence |
| --- | --- | --- |
| Request, upload (phone photo, PDF or image), open, review, reject with reason, replace, history; Administrator self-review audited | LIVE 0021 | 0021; `documents-page.tsx`; tests |
| Configurable types (TB, CPR, First Aid, clearance, licence/insurance, training) | LIVE 0021 | `create_document_type`. The agency creates the types; none are pre-set as agency requirements. |
| Due versus issued versus expiry dates; missing, awaiting, rejected, due soon, overdue, expiring and expired statuses, with exact days | LIVE 0021 | `document-status.ts`, 0021 alerts |
| Upload confirmed by the server before success is shown | LIVE 0021 | Upload registers after the S3 put; replay check |
| File reopens on another device | Not verified | Phone check 4 and 5 after deployment |
| **Uploads reach S3 from the private API Lambda** | **DEFECT FOUND (INFERRED), fixed in RELEASE 0025** | The deployed S3 gateway endpoint policy allows only the signature key shape; document and logo keys are expected to be refused. Release 0025 adds both shapes; acceptance check 6.4 proves it. |
| Agency's approved requirements, such as required types per role | NEEDS IMPLEMENTATION | Types only have a requires-expiry setting. There is no list of required types and no per-role requirement set; documents are requested one by one. |

## 12. Feature recovery

| Item | Status | Evidence |
| --- | --- | --- |
| Inventory of the archives, Supabase build and AWS build | Done | `docs/product/FEATURE_RECOVERY_INVENTORY.md` |
| CareScore and Matching | NEEDS IMPLEMENTATION in AWS | Working in Supabase (`_score_caregiver_matches`); not ported |
| AskCare | NEEDS IMPLEMENTATION in AWS | The archive version is a rule-based question box with no external AI (inventory) |
| Clients, Care Team, Authorizations, Schedule screens | Working in the Supabase build only | This is the source to port for section 4 |

## 13. Landing page

| Requirement | Status | Evidence |
| --- | --- | --- |
| Public Ogevia page with a sign-in path | Exists on Netlify (Supabase build), **not in AWS** | Inventory row "Public landing, pricing". Its claims have not been reviewed against what the AWS build offers. Any change goes through the Netlify deployment approval. |

## 14. Pricing

Proposal: `docs/product/PRICING_PROPOSAL.md`. It is a recommendation. Nothing is activated.

## 15. Security and real-client clearance

| Item | Status | Responsible person and action |
| --- | --- | --- |
| AWS BAA ACTIVE, effective 2026-09-29 | Recorded (owner-reported; Artifact not visible to Claude) | — |
| Restore drill | Done 2026-10-03 (owner-reported; restored instance matched row counts at 0012) | Keep the evidence (PHASE7 §3.0). The live check still lists E3 as MANUAL because it can't detect drills. |
| **G1** alarms reach a person | **BLOCKED** (required) | Owner: `phase7-remediate.sh`, APPLY (subscribes the owner's email), then confirm the email |
| **D2** account-wide S3 public-access block | **BLOCKED** (required) | Owner: same script, APPLY (checks every bucket first; automatic rollback) |
| G3 GuardDuty | Recommended | Same script (30-day trial, then usage-based) |
| C6 VPC flow logs | Recommended, not blocking | CDK change, later |
| D4 app database secret rotation | Decided: manual every 90 days for the pilot | Record the next rotation date |
| Private storage, permissions, tenant isolation, monitoring, backups | Verified in TEST (Phase 7 PASS 36) | — |
| Temporary database access removed after each window | Verified every run (security groups `sg-00e01e2ca80442c1f`) | — |
| Operating policies (incident response, access review, workforce training, minimum necessary) | NOT VERIFIED | Owner: confirm SCS HIPAA policies cover Ogevia use. BAA acceptance alone is not HIPAA readiness. |

## 16. Deployment and acceptance

| Item | Status |
| --- | --- |
| Pilot through 0018 | LIVE; not restarted |
| 0019–0021 increment: backup, rollback that keeps records, strict scope check, 10 live checks | **LIVE (owner-reported 2026-10-05)**: 10/10 live checks, post-check all PASS. Recovered from the failed 1a39dd5 run without re-applying migrations; one API-scoped invoke permission. First sign-ins of the new manager and the corrected caregiver are still pending. |
| Release 0022–0026: snapshot, every existing record checked **by value** across the migrations (all 0021 columns, exact permission additions, earlier audit rows), applied migrations never modified (checksums), strict gate (27-variant self-test, including per-route or widened invoke permissions), 14 live checks, layered rollback | Pinned at `0ca5616`. Rehearsed clean (14/14) and tampered (a changed signer name stopped it before API/web). Base live. New fixed cost ≈ 7.30 USD/month (Lambda endpoint) is approved by typing DEPLOY. |
| Full workflow on real AWS (authorization and scheduling through confirmation, approval and reports), with two-agency isolation | After deployment. Authorizations and schedules still come from seeds, so only the seeded part can be tested. |
| Phone retest of changed workflows | After deployment (plan section 6) |
| Production correction fix | Kept separate; needs its own approval |

## 17. Outage continuity and recovery (requirement recorded 2026-10-04)

**Owner requirement, recorded as stated:** outage continuity and recovery are part of pilot readiness.
- Verify database, documents/signatures, account access and application recovery together.
- State the measured recovery time and the maximum potential data loss. Do not invent guarantees.
- Define how each agency can securely reach a recent operational export, with its "last updated" time, while Ogevia is unavailable.
- Provide a temporary visit-recording and reconciliation process that prevents lost or duplicate hours.
- Explain which parts already work, which need implementation, and what each agency must set up.
- Keep agency exports isolated and restricted to authorised staff.
- Do not claim that AWS database backups alone provide agency continuity.

**Sequencing (owner instruction):** this work does not change the 0019–0021 recovery block or its pins. It starts after the permission fix is deployed and the recovery is verified live (blocker 0). It must be finished before real-client readiness is declared.

**Acceptance criteria:**

| # | Criterion | Evidence required |
| --- | --- | --- |
| C1 | One combined recovery drill restores together: the database (to a new instance), document and signature objects (versioned S3, referenced keys resolve), account access (Cognito users can sign in and keep their roles and agency), and the application (API and web work against the recovered data) | A drill log with start and end times for each part |
| C2 | Recovery time, as measured | Measured minutes from the drill for the whole system; no target is stated as a guarantee. The database restore alone measured 4 min 15 s on 2026-10-03 |
| C3 | Maximum potential data loss, per data type, from the actual configuration | Database (backup and point-in-time settings as read live), S3 objects, Cognito, and anything outside them, each stated with its source |
| C4 | Each agency has a recent operational export, reachable while Ogevia is down, with a "last updated" time | A design and implementation, tested with two agencies: each sees only its own export, only authorised staff can open it, and the export holds no more data than needed for the minimum required |
| C5 | Temporary visit recording during an outage, and reconciliation afterwards, with no lost or duplicate hours | A written procedure plus the system support for entering outage visits as provisional exception visits, with duplicate detection and an audit trail. Must be rehearsed |
| C6 | A status table: works now / needs implementation / agency must set up | Each row supported by evidence |

**Initial evidence (for the assessment; not the assessment itself):**

| Part | What is known | Class |
| --- | --- | --- |
| Database | RDS automated backups for 7 days with point-in-time recovery (Phase 7 E1). One restore to a new instance on 2026-10-03 took **4 min 15.142 s** (23:03:12.179 to 23:07:27.321 UTC). Data verification (ledger, row counts) and cleanup passed. Evidence: `~/ogevia-phase7/drill-finish-20261003T234756Z.log` (CloudShell). This is the database restore only; it does not include finding the fault, repointing the application, or verifying documents, signatures and sign-in | OWNER-REPORTED; database restore time MEASURED; **full-system recovery time UNKNOWN** |
| Documents and signatures | Evidence bucket versioned, KMS-encrypted, private. Never restored together with the database | VERIFIED controls; joint recovery NOT VERIFIED |
| Account access | Cognito with deletion protection and MFA. No user-pool backup or restore path has been defined or tested | NOT VERIFIED |
| Application | Infrastructure as code (CDK) plus pinned deploy scripts. Rebuilding it against a restored database was never drilled | NOT VERIFIED |
| Agency export while Ogevia is down | Does not exist. The existing reports and rollback exports run inside Ogevia or CloudShell, so they are unavailable in the same outage | NOT BUILT |
| Temporary visit recording | The Phase 7 risk table assumes "paper, corrected later with audit history". No procedure, form or reconciliation support is defined | NOT BUILT |
| Continuity from backups alone | Not sufficient: backups restore data after an outage; they give no agency access to visits, schedules or authorizations during one | — |

## 18. Consolidated pilot fixes and the 10/05/2026 findings: tracked checklist

**Status values:**
- **Built and tested:** on the branch, automated tests pass; not deployed.
- **Rehearsed:** in the pinned release, rehearsed against stubbed AWS.
- **Deployed and verified:** live in AWS TEST, with evidence.
- **Designed:** not built.
- **Open.**

**Release:** everything below marked "Built and tested" is in the pinned
release **0027–0036 at `7b1236d`**. That release replaces the unreleased
0027–0034 package.

It was rehearsed against stubbed AWS on 10/05/2026:
- clean run 14/14;
- a tampered run that stopped in the DB window;
- every rollback layer, including the 0036 refusal.

It is **deployed and verified on AWS TEST** (owner-run, 10/05/2026: 14/14 PASS after the read-only rerun with corrected checks; see `docs/aws/DEPLOYMENT_PLAN_0027_0036.md` §9). Screen acceptance (§19) is pending. The
deployed TEST base is 0022–0026 (`0ca5616`), as reported by the owner.
Production, Netlify and Supabase are untouched.

| # | Item | Status | Evidence / what remains |
| --- | --- | --- | --- |
| 1 | Navigation: exactly one current item, `aria-current="page"`; `/visits/*` maps to Visit records | Built and tested | Unit tests; browser nav 23/23 desktop and 390 px. Deploy, then the phone check |
| 2 | Needs attention: badge and Home use one server definition, including uncovered shifts and documents blocking or to review; expiring documents listed separately as Reminders | Built and tested | 0033 `get_attention_summary`; `document-reminders.db.test.ts` 5/5; badge links to Home |
| 3 | Visit review **(priority blocker)**: "Review visit" opens the exact visit; names, code, caregiver, service, times, scheduled window, confirmation, no-signer reason; explained decisions; separate from Correct visit; audited; agency-isolated | Built and tested | 0031; `visit-review.db.test.ts` 6/6; API tests; `review-e2e.ts` 17/17 including phone. A no-signer visit can only be closed **not billable** |
| 4 | Missing-signature recovery: staff-copied secure link + one-time phone code, paper fallback. The visit stays pending (no forced closure); accepted evidence makes it eligible for manager billing review only | Built and tested; **not complete until done end to end on AWS TEST** | 0036. DB tests 14 (lock after 5 wrong codes, expiry, void on correction, dispute never billable, capped minutes, append-only, isolation, rollback refusal); API 2 (token and code never logged); web 3; browser `recovery-e2e.ts` 22/22 at 390 px (`evidence/2026-10-05/recovery/`). Payer acceptance of late or electronic confirmations: **UNKNOWN** (owner) |
| 5 | Correction preview 3 vs 4 min; MM/DD/YYYY and AM/PM everywhere; UTC storage; DST | Built and tested | `pacific-correction-fields.test.tsx` reproduces the bug and fails without the fix; date-format sweep with tests. 0035: a time that does not exist or happens twice is refused for one-time shifts and one-date changes, and flagged per date in series. Skipping a flagged date is an explicit choice. `dst-local-times.db.test.ts` 6/6 uses the next real transitions |
| 6 | Cancelled shift showed "1h reserved"; wording "2 hr 59 min available" | Built and tested | 0032; shifts DB tests including the owner case (3 h authorized, 1 min used, a 3 h shift refused with "2 hr 59 min available") |
| 7 | Document reminders 90/60/30/14/7 per agency and document type; separate review and currency status; reviewer and date shown; no alerts without an expiry; no email implied | Built and tested | 0033; DB 5/5; Documents page |
| 8 | Recurring schedules: weekly series, real occurrence counts, per-month limits, conflicts and overages flagged, this-occurrence vs this-and-future changes, reservations released or moved, agency timezone, concurrency | Built and tested | 0034; `shift-series.db.test.ts` 9/9, including real weekday counts per month (a fifth weekday included) and the 30 h example (15 occurrences fit, the 16th and later flagged with dates); `recurring-e2e.ts` 15/15 |
| 9 | Billing rounding (0029) | Built and tested, regression complete | `rounding-regression.db.test.ts` 11/11 covers retries/idempotency, concurrent approval, the authorization cap under a race, concurrent policy versions, correction after an adjustment (void, correct, re-round), future-dated and "no rounding" policy changes, a retroactive authorization decrease (the adjustment is never rewritten) and agency isolation. No defect found. 0036 adds rounding of review-accepted visits once approved |
| 10 | Report names, approval summary (minutes only for managers), Scheduled label | Built and tested | 0030 `list_monthly_approval_summary`; API test |
| 11 | Hire type, flexible scheduling, family relationship (0030) | Built and tested | Not yet accepted on screens |
| 12 | One-page Letter-landscape client calendar with caregiver summary and reconciliation check | Built and tested | `calendar-e2e.ts` 16/16; PDFs in `evidence/2026-10-05/` |
| 13 | Utilization pace and projection; small values never shown as zero | **Open** | Not started in this batch |
| 14 | Continuity: combined recovery drill (database + documents + accounts + application) | **Open** | Database-only restore measured at 4 min 15 s (owner-run). Full-system time not measured, so no claim of full recovery |
| 15 | Client Bravo vs "Synthetic Bulk Test" | **Open** | After deployment: the Visit review page shows the linked client (retest step 10). Fallback: `infra/aws/slice/reconcile-2026-10-05-no-signer.sql` (read-only; needs a DB window) |
| 16 | Monthly cost estimate | Done (estimate) | `docs/aws/MONTHLY_PLATFORM_COST_2026-10.md` |

## Summary: why NOT READY for real clients, and what clears it

| # | Blocker | Owner of the next step | Next action |
| --- | --- | --- | --- |
| 1 | Release 0027–0036 deployed and verified 14/14; screen acceptance pending | Owner | Run the retest batch in §19 (synthetic data only) |
| 2 | Payer acceptance of late or electronic confirmations unknown | Owner | Confirm with the payer or contract before any real-client use of recovered signatures |
| 3 | G1 alarm subscriber, D2 account S3 public-access block | Owner | `phase7-remediate.sh`, type APPLY |
| 4 | HIPAA/BAA and operating policies | Owner | Confirm in writing; separate from TEST work |
| 5 | Full-system recovery drill | Claude (script) + Owner (run) | Measure full-system time and the data-loss window |
| 6 | Utilization pace and projection | Claude | Build |

**Verdicts:**
- **Synthetic pilot:** ready for a synthetic-data dress rehearsal after
  blocker 1 and its retest.
- **Real clients:** **NOT READY**. Blockers 2–5 must be resolved first.
- **Remote signature:** built and rehearsed. It is **not accepted** until the
  retest batch passes on AWS TEST, and real use stays blocked by blocker 2.

## 19. Retest batch after release 0027–0036 (AWS TEST, synthetic data only)

1. **Visit review.** In Billing review, open "Review visit" on the no-signer
   visit (Client Bravo, 3 min).
   - The visit page shows the client name and code, caregiver, service, times,
     "Unscheduled visit" and the no-signer reason. This also settles Synthetic
     Bulk Test vs Client Bravo.
   - The page offers both "Close the review: not billable" and "Get the
     missing signature". Do not close it.
2. **Request a link.** Under "Get the missing signature", enter the person's
   name, choose Parent, enter how you will verify them by phone, then press
   "Create secure link".
   - The link and the 6-digit code are shown once.
   - The badge count drops by 1. Home shows "Waiting for a signature".
     Billing review shows "Waiting for signature".
3. **Recipient phone.** Use a private window, not signed in. Open the link.
   - A wrong code shows "4 attempts left". The right code shows the service,
     date (MM/DD/YYYY), times (AM/PM), length and the caregiver's first name,
     with no client code or name.
   - Sign with a finger, tick the box and send: "Thank you".
   - Reopening the link says it is no longer valid.
4. **Review.** On the visit page:
   - It shows "Signature received — review it"; Home shows "Signatures
     received to review"; the badge rises by 1.
   - "View signature" shows the drawing.
   - "Accept confirmation" with a reason shows "Accepted — 3 min eligible for
     billing approval". No billing approval exists yet.
5. **Human billing approval.** In Billing review the visit shows "Awaiting
   approval".
   - Approving 4 min is refused; approving 3 min shows "Approved — not
     submitted".
   - Nothing is submitted anywhere.
6. **Paper path.** On a second no-signer visit, choose "Paper form", then
   "Upload a signed paper form" (a PDF or photo, the signer and the date on the
   form).
   - "View form" works.
   - Reject it with a reason: the visit returns to Needs attention.
7. **Dispute.** Make a new link and, as the recipient, choose "No, something
   is wrong" with a description.
   - The manager can only "Record as reviewed". Nothing becomes billable.
8. **Lock.** Make a new link and enter a wrong code 5 times.
   - The link is locked, and the visit returns to Needs attention.
   - A new request shows the old one as "Closed … (locked)".
9. **Daylight saving.**
   - A one-time shift on 11/01/2026 from 1:30 AM is refused: "happens twice".
   - A one-time shift on 03/14/2027 from 2:30 AM is refused: "does not
     exist".
   - A Sunday 1:00–3:00 AM series from 10/25/2026 flags 11/01/2026 and creates
     nothing until you choose to skip it.
10. **Recurring.** For a 30 h/month service, create Mon/Wed/Fri 2–4 PM from
    11/01/2026.
    - Over-limit dates are listed, and "Create series" stays disabled until
      you choose skip.
    - "Change this date only" and "Cancel this date" work.
11. **Correction precision.** Open "Correct visit" on a 4-minute visit and
    change nothing: the preview shows the same minutes, with "unchanged".
12. **Shift card.** Cancel a shift: no reserved time shows.
    - An over-limit shift says "X hr Y min available".
13. **Action needed** (replaces the earlier Needs attention expectation,
    owner decision 2026-10-06). The header badge and the Home banner show the
    same total: Missing Clock-Out + Awaiting Confirmation + Visits to Review +
    Signatures to Review + Unfilled Shifts + Overdue Documents + Documents to
    Review + Ready for Approval. It is the sum of the category counts, not a
    count of unique visits. Ready for Approval now counts. Waiting for a
    Signature and Documents Expiring Soon stay under Reminders and are not
    counted. Red above zero, green only for a confirmed zero, neutral while
    loading or on failure. Not deployed until the branch is reviewed.
14. **Document reminders.** Set agency reminder days to 60, 30 and 7.
    - The CPR document shows its reminder stage, reviewer and date.
    - A document type without expiry shows none.
15. **Calendar and boundary.**
    - One client's month prints on one Letter landscape page.
    - A manager sees approval summaries in minutes only.
