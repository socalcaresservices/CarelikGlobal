# Ogevia controlled-pilot scope: status against the consolidated requirements

**Date:** 2026-10-04, updated about 16:45 Pacific. **Builds:** (a) the 0019–0021 increment. The first deployment (1a39dd5) failed at 10/12 because the Lambda resource policy exceeded 20 KB, and the API stack was rolled back. The revision (69e8799: one API-scoped invoke permission) and its recovery are in `infra/aws/slice/increment-resume-block.sh`. Live completion is **NOT VERIFIED**. (b) Release 0022–0026, packaged in `infra/aws/slice/release-0026-bootstrap.sh`, requires (a) live first.
**Verdict: NOT READY FOR OGEVIA CONTROLLED PILOT (real clients).** The blockers are in the summary at the end.

## Status key

| Status | Meaning | Evidence class |
| --- | --- | --- |
| **LIVE** | Deployed to AWS TEST through migration 0018 (pilot build 87a9be2) | Owner-reported deployment 12/12. Phone results C and part of G passed 2026-10-04. Live check ledger 0018. |
| **THIS DEPLOYMENT** | In the 0019–0021 increment (revision 69e8799; the first attempt, 1a39dd5, failed at 10/12 and was rolled back). Passes the local gate and the rehearsal; live completion not yet confirmed. | Verified locally; needs live evidence plus phone checks |
| **RELEASE 0025** | In release 0022–0025 (built, tested, deployment package prepared). Not deployed. | Local tests and scope gate; needs the live run plus screen checks |
| **NEEDS IMPLEMENTATION** | Not in either build for AWS. Either absent, or only in the old Supabase build. | Repository search (cited) |
| **BLOCKED** | Waiting on an owner action or decision | Cited |

## 1. Roles and access

| Requirement | Status | Evidence |
| --- | --- | --- |
| Owner shown as **Administrator** everywhere; ADMINISTRATOR / MANAGER / CAREGIVER VIEW with name, then email | THIS DEPLOYMENT | `aws-workspace.ts` (`viewKind` → `ADMINISTRATOR`), `aws-shell.tsx`. Error messages in 0020/0021 and the API now say Administrator. Test: `aws-app.test.tsx` "organization_owner sees ADMINISTRATOR VIEW". |
| Internal `organization_owner`, memberships, permissions and audit history preserved | LIVE (unchanged) | Display-only change. Migrations 0019–0021 add permissions and do not rename roles. |
| Administrator sees rates and money | THIS DEPLOYMENT | `billing.read` is granted to `organization_owner` only (0019). Tests: `access-roles.db.test.ts:143`, `workspace.db.test.ts:191`. |
| Manager: operations and approving billable hours, no rates or money in pages, API or exports | THIS DEPLOYMENT | Money is returned only by `list_billing_approvals` and `get_utilisation_overview`, and only with `billing.read`. No other function returns rate or amount columns. The app role has no table privileges (`db:verify` `app_role_has_no_table_privileges`). Tests: DB `access-roles.db.test.ts:141`; API `workflow.db.test.ts:390`. **Live check added:** `pilot-manager-account.sh` runs as the new manager and requires `billing.approve` = true, `billing.read` = false, `organization.update` = false, and 0 rows with dollar values. Rehearsed: manager 0 rows with dollars; the Administrator sees dollars on 2 rows. There are no exports in the AWS build. |
| Caregiver: own assignments, visits, availability, documents | LIVE (visits, availability); THIS DEPLOYMENT (My documents) | Pilot phone section C; 0021 `documents.manage_own` |
| Platform Administrator distinct; agency isolation | LIVE | No platform-admin role in the AWS build. Isolation: `05_tenant_boundaries.sql` verification and tests `managerB` → `[]`. The phone isolation check (G) has not been re-reported. |
| `admin.ogevia@gmail.com` is Administrator | LIVE (done 2026-10-04, not repeated) | Owner-reported read-back and audit event |
| Caregiver invitations from the Care Team screen (manager or Administrator); caregiver role only; server-checked agency and role; invite and resend audited; no password shown or logged; invited / first-signed-in status shown | RELEASE 0025 | 0025 `begin/complete_caregiver_invitation`, `begin_invitation_resend`, `note_my_sign_in`; identity Lambda with AdminCreateUser/AdminGetUser on the one pool only; tests `invitations-planned.db.test.ts` (11), API (2), identity unit (4), web (2). Staff sign-ins cannot be attached (test). |
| Separate manager sign-in in the pilot agency | THIS DEPLOYMENT (runs after the deployment) | `ogemails+ogevia-pilot-manager@gmail.com` via `pilot-manager-account.sh`. Rehearsed: refuses with no owner, applies once, a re-run changes nothing, and the rollback file works. |

## 2. Branding and agency settings

| Requirement | Status | Evidence |
| --- | --- | --- |
| Agency name, colour (contrast-checked), preview, save | THIS DEPLOYMENT | `workspace-settings-pages.tsx`, 0020 `set_organization_branding` |
| Logo upload and removal; private storage; appears for every role and on printed reports | THIS DEPLOYMENT | 0020 logo functions, private S3 `{org}/branding/logo/*`, letterhead fetch |
| **Reset** branding to default | NEEDS IMPLEMENTATION (small) | No reset control; the colour can be set back manually |
| Ogevia shown subtly | THIS DEPLOYMENT | "Powered by Ogevia" in the header |
| Services, timezone and operational rules configured per agency without hard-coding | PARTIAL: services BUILT, NOT YET DEPLOYED (0023); timezone and rules NEEDS IMPLEMENTATION | No AWS API to create or edit services or set the timezone. Services and the agency are seeded by SQL (`04_seed_scs_pilot_synthetic.sql`). Shared code has no SoCal or IRC logic; the seed is agency data. |

## 3. Navigation and mobile

| Requirement | Status | Evidence |
| --- | --- | --- |
| Menu button showing the current page; Sign out | THIS DEPLOYMENT | `aws-shell.tsx` (longest-path match) |
| NEEDS ATTENTION in bold red uppercase, with a count and a link | THIS DEPLOYMENT | `aws-shell.tsx`, 0020 `get_attention_summary` |
| Visit records open on the list; one date-range dropdown; collapsible filters; phone cards with status; column chooser kept; unambiguous dates | THIS DEPLOYMENT | `service-verification-reports-page.tsx`. Browser scenario 42/42 earlier. |
| Plain-language labels (for example `unable_to_confirm` shown raw) | PARTIAL | Recovery defect 4 is still open |
| Ogevia, CareScore, AskCare, Service Verification and Care Requests naming | PARTIAL | CareScore and AskCare are not in the AWS build (see 12) |

## 4. Clients, caregivers and services — **launch blocker**

| Requirement | Status | Evidence |
| --- | --- | --- |
| Create, view, update and activate/deactivate **clients** from screens | **RELEASE 0025** (migration 0022) | Clients list and client page: add, edit details, change status with a reason (refused while a visit is in progress), configurable client types, city. Audited. Tests: DB 12, API 2, web 8, browser 28/28 at 390 px. |
| Same for **caregivers and services** | **RELEASE 0025** (migration 0023) | Care Team: add (random code), rename, status with a reason. Making a caregiver **inactive ends their active assignments and suspends their sign-in for the agency at once** (refused while a visit is in progress); reactivation restores the sign-in only. Services (Administrator only): add (code fixed, unique per agency), rename, deactivate/reactivate with a reason; deactivation refused while current authorizations use the service. Audited. Tests: DB 7, API 2, web 5, browser 20/20 at 390 px, including a signed-in caregiver losing access. **Not included:** inviting a caregiver to sign in (needs the API to create Cognito users, a security decision). | The AWS database API has no create or update function for clients, caregivers or services (full list of `ogevia_api` functions checked 2026-10-04). Records come from SQL seeds. |
| Administrator and manager see client names | THIS DEPLOYMENT | 0020 `client_private_names`, `clients.names.read` |
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
| Managers and Administrators approve eligible billable hours; duplicates prevented; approved visits cannot be corrected until voided | THIS DEPLOYMENT | 0019; tests; the same rule was proven for production in `supabase/tests/billing-correction` (14 paths, 5 concurrency cases) |
| Worked, confirmed, billable, Billing Ready and Billing Approved kept distinct; approval separate from confirmation and document verification | THIS DEPLOYMENT | `billing-review-page.tsx`, 0019 |
| Managers cannot get rates or dollars | THIS DEPLOYMENT, with a live check | See section 1 |
| Automatic payer submission | Out of scope (decided) | — |

## 9. Administrator utilisation dashboard

| Requirement | Status | Evidence |
| --- | --- | --- |
| Monthly per service: authorized, scheduled, worked, billable, approved, remaining; potential value for the Administrator only, labelled as potential | THIS DEPLOYMENT | 0020 `get_utilisation_overview`, `home-page.tsx`. Unrated authorizations are excluded, not counted as $0. |
| Confirmed hours as a separate figure | NEEDS IMPLEMENTATION | Not a separate column |
| Breakdowns by client, location/city and client type | NEEDS IMPLEMENTATION | Per service only; city and client type are not in the schema |
| Daily, weekly and custom periods; trends over time | NEEDS IMPLEMENTATION | Monthly only |
| Upcoming uncovered shifts, expiring authorizations, unused hours with no future coverage | NEEDS IMPLEMENTATION | — |
| Projected end-of-period usage and shortfall, labelled as estimates | NEEDS IMPLEMENTATION | — |
| Future scheduled time kept apart from actual usage | THIS DEPLOYMENT | Separate `scheduled_minutes` and `worked_minutes` |

## 10. Reports and printable calendar

| Requirement | Status | Evidence |
| --- | --- | --- |
| One client per monthly calendar; agency branding; full client name; per service: authorized, worked, remaining; caregivers combined and not named; landscape print without navigation | THIS DEPLOYMENT | `buildMonthCalendar` (grouped by service, never caregiver); "Authorized / Remaining to schedule" table; print styles |
| Daily totals reconcile to the month; filters cannot produce partial client totals | THIS DEPLOYMENT | The calendar runs its own whole-month query, independent of list filters |
| Operational reports with working filters and column preferences | LIVE, improved in THIS DEPLOYMENT | Reports page |

## 11. Documents and credentials

| Requirement | Status | Evidence |
| --- | --- | --- |
| Request, upload (phone photo, PDF or image), open, review, reject with reason, replace, history; Administrator self-review audited | THIS DEPLOYMENT | 0021; `documents-page.tsx`; tests |
| Configurable types (TB, CPR, First Aid, clearance, licence/insurance, training) | THIS DEPLOYMENT | `create_document_type`. The agency creates the types; none are pre-set as agency requirements. |
| Due versus issued versus expiry dates; missing, awaiting, rejected, due soon, overdue, expiring and expired statuses, with exact days | THIS DEPLOYMENT | `document-status.ts`, 0021 alerts |
| Upload confirmed by the server before success is shown | THIS DEPLOYMENT | Upload registers after the S3 put; replay check |
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
| 0019–0021 increment: backup, rollback that keeps records, strict scope check, 10 live checks | **NOT VERIFIED** live. The first deployment (1a39dd5) **FAILED** at 10/12: the Lambda resource policy reached 20,624 of 20,480 bytes because there was one invoke statement per route. CloudFormation rolled the API back; migrations 0019–0021 stayed applied (owner report). **Fixed** in 69e8799: one invoke permission limited to this API; route authentication is unchanged. The peak during the update is today's policy + 1 statement, and it is checked before deploying. The recovery block verifies the state the failed run left (ledger, objects, record values, API rollback, Lambda policy, stack status, web, admin host groups, snapshot), then deploys without re-applying migrations. Rehearsed: the reproduced failure, then RECOVER (peak 13,963 bytes) with 10/10 live checks and the post-check passing; 19 refusals; failure and resume; complete re-paste; API rollback. |
| Release 0022–0026: snapshot, account/record counts checked unchanged, applied migrations never modified (checksums), strict gate (27-variant self-test, including per-route or widened invoke permissions), 13 live checks (13 = the Lambda policy is still one statement), layered rollback | Package ready on the single-permission base. It refuses to start unless the revised increment is live (one invoke statement). Requires the 0019–0021 increment live. New fixed cost ≈ 7.30 USD/month (Lambda endpoint) needs approval (typing DEPLOY). |
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
| C2 | Recovery time, as measured | Measured minutes from the drill; no target is stated as a guarantee |
| C3 | Maximum potential data loss, per data type, from the actual configuration | Database (backup and point-in-time settings as read live), S3 objects, Cognito, and anything outside them, each stated with its source |
| C4 | Each agency has a recent operational export, reachable while Ogevia is down, with a "last updated" time | A design and implementation, tested with two agencies: each sees only its own export, only authorised staff can open it, and the export holds no more data than needed for the minimum required |
| C5 | Temporary visit recording during an outage, and reconciliation afterwards, with no lost or duplicate hours | A written procedure plus the system support for entering outage visits as provisional exception visits, with duplicate detection and an audit trail. Must be rehearsed |
| C6 | A status table: works now / needs implementation / agency must set up | Each row supported by evidence |

**Initial evidence (for the assessment; not the assessment itself):**

| Part | What is known | Class |
| --- | --- | --- |
| Database | RDS automated backups for 7 days with point-in-time recovery (Phase 7 E1). One restore to a new instance on 2026-10-03: ledger and row counts matched. The duration was **not measured** (the script reported a false 0 seconds; corrected to report "unknown") | OWNER-REPORTED; recovery time UNKNOWN |
| Documents and signatures | Evidence bucket versioned, KMS-encrypted, private. Never restored together with the database | VERIFIED controls; joint recovery NOT VERIFIED |
| Account access | Cognito with deletion protection and MFA. No user-pool backup or restore path has been defined or tested | NOT VERIFIED |
| Application | Infrastructure as code (CDK) plus pinned deploy scripts. Rebuilding it against a restored database was never drilled | NOT VERIFIED |
| Agency export while Ogevia is down | Does not exist. The existing reports and rollback exports run inside Ogevia or CloudShell, so they are unavailable in the same outage | NOT BUILT |
| Temporary visit recording | The Phase 7 risk table assumes "paper, corrected later with audit history". No procedure, form or reconciliation support is defined | NOT BUILT |
| Continuity from backups alone | Not sufficient: backups restore data after an outage; they give no agency access to visits, schedules or authorizations during one | — |

## Summary: why NOT READY for real clients, and what clears it

| # | Blocker | Next step owner | Next action | Fits the 13:20 target? |
| --- | --- | --- | --- | --- |
| 0 | 0019–0021 increment NOT VERIFIED. The 1a39dd5 deployment failed at 10/12 (Lambda policy size) and was rolled back. Ledger 0021 and the completed rollback are owner-reported, not yet verified | Owner | Paste `infra/aws/slice/increment-resume-block.sh` (revision 69e8799). Its preflight verifies the failed run's state before anything changes, then the revision deploys with one invoke permission | — |
| 1 | Release 0022–0026 (administration, invitations, planned assignments, schedule and call-outs, S3 endpoint fix) not deployed | Owner | Only after 0 is verified: paste the release block, type DEPLOY, then screen checks 6.1–6.11 | — |
| 2 | Staff shifts, call-outs, replacements: built (0026), not deployed | Owner | Deploys with release 0022–0026 | — |
| 3 | Utilisation beyond monthly per service (section 9) | Claude (build) | Periods, breakdowns, coverage and expiry warnings, projections | **No** |
| 4 | G1 alarm subscriber and D2 account S3 public-access block | Owner | `phase7-remediate.sh`, type APPLY, confirm the alarm email | About 10 minutes |
| 5 | HIPAA operating policies not confirmed | Owner | Confirm in writing | Owner decision |
| 6 | Phone/screen retest of changed workflows on real AWS | Owner | After deployments (plan section 6) | — |
| 7 | Outage continuity and recovery (section 17): combined recovery drill with measured recovery time and data loss; per-agency offline export with a "last updated" time; outage visit recording and reconciliation | Claude (assess, build) + Owner (drill run, agency setup) | Starts after 0 is verified; the recovery block is not changed | — |

Verdict unchanged: **NOT READY** for real clients. After 0, 1, 4 and 6 it is ready for a synthetic-data dress rehearsal of everything except staff-created shifts and call-outs. Real-client readiness also requires 7 (outage continuity and recovery), 3 and 5.
