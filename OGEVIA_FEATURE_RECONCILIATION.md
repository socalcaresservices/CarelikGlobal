# Ogevia — Owner Acceptance / Feature Reconciliation Audit

**Audit date:** 2026-10-02 (UTC)
**Type:** inspection and testing only. No code, schema, migration, PR, merge or AWS configuration changes were made.
**Data used:** synthetic TEST data only. No production client or caregiver rows were read. Production Supabase was read for **metadata only**:
- the list of applied migrations;
- table and column names;
- function definitions;
- the role → permission configuration;
- storage-bucket flags;
- cron job names;
- which integration providers are configured (which keys are present, never their values);
- the security advisor output.

---

## 0. Read this first — there are two different "deployed" Ogevias

| | **PRODUCTION** (Netlify + Supabase) | **AWS TEST** (CloudFront + API Gateway + Lambda + RDS) |
|---|---|---|
| Code | `main` @ `de30bd8` | `feature/care-request-availability` @ `4138447` (PR #52, **unmerged**) |
| Database | Supabase project `CarelikGlobal`. All 158 `main` migrations are applied. Name drift: 3 renamed, 2 applied in two parts. **None** of #53–#58's migrations are applied. | RDS `ogevia-prod-postgres`, database `ogevia_sv_test`, migrations 0001–0012 |
| Auth | Supabase Auth (email/password) | Amazon Cognito (MFA on, admin-create-only) |
| Screens | ~20 operational screens (dashboard, schedule, clients, Care Team, candidates, authorizations, incidents, credentials, billing, reports, settings, access) | **5 screens only**: Verify visit, Visit records, Billing review, Care requests, Availability |
| Holds | Real agency data | Synthetic data only |

Consequences that drive most findings below:
1. **Care Requests, offers, coverage queue and self-service links exist only in AWS TEST.** Production has no `care_requests` table.
2. **The AWS TEST UI has no screens for clients, caregivers, services, authorizations, assignments, scheduling, CareScore, incidents, dashboard or credentials.** In TEST those records exist only because they were seeded.
3. **The entire AWS backend (`apps/sv-api`, `infra/aws`) is not on `main`.** It sits on a 138-commit unmerged chain:
   - `phase0`…`phase3` branches, which have **no PRs**;
   - #51, which targets `claude/phase3-cognito-auth`;
   - #52.

   There is currently **no merge path from that chain to `main`**.

**How the testing was done**

- **Production UI:** not browser-tested. Its only deployed instance holds real data, and this audit used synthetic data only. Production rows are therefore assessed from:
  - code;
  - the live schema and functions;
  - `main`'s automated tests.
- **AWS TEST:** tested live through the deployed Lambda. API Gateway's JWT authorizer was tested over HTTPS.
- **AWS TEST staff screens in a real browser:** not exercised. Cognito sign-in needs the owner's TOTP.

### Status definitions used

| Status | Meaning in this report |
|---|---|
| **WORKING** | Verified end-to-end today through the deployed AWS TEST API with synthetic data. |
| **PARTIAL** | Works in part, or works in one environment with a code-verified gap. |
| **BROKEN** | A code-verified or test-verified defect stops the workflow. |
| **MISSING** | No implementation on any branch, or none in the environment noted. |
| **HIDDEN** | The backend exists but no UI or API route reaches it. |
| **NOT TESTED** | Implemented, and its schema is live in production, but not exercised end-to-end today. |
| **PENDING PR** | The behaviour exists only in open PRs #53–#58. |

---

## 1. Executive summary

- **What works, with fresh evidence:** the AWS TEST chain passes **104 of 105** live checks. The one failure is this container's proxy blocking CloudFront, not an app defect. The chain covers:
  - Service Verification: start, end, signature, no-signature path, correction, billing review;
  - tenant isolation;
  - S3 evidence controls;
  - the Care Request chain: link → request → offer → accept → assign → call-out → Coverage Needed → cancel → revoke.

  Server metrics for the test window: 0 Lambda errors, 0 throttles, 0 API 5xx, maximum Lambda duration 421 ms.
- **Production is a separate, richer, Supabase-based app.** Its screens are present and `main`'s automated tests pass, except one date-dependent test that keeps `main` CI red. It was not browser-tested in this audit.
- **The core chain is broken in both environments at Schedule → Visit.** Both `start_visit` (AWS) and `start_ad_hoc_service_visit` (production) always write `scheduled_shift_id = null`. As a result:
  - scheduled time is never compared with worked time;
  - an AWS authorization reservation is never consumed or released by the visit;
  - in AWS, a caregiver assigned through a Care Request **cannot clock in** unless a separate `caregiver_assignments` row was already seeded. No API or UI creates one.
- **"Hours remaining" in AWS reports is misleading.** The monthly summary showed TEST-C01 with **590 min remaining**. The assignment cap, which counts 420 min already scheduled, correctly refused a 240-min assignment because only **170 min** were actually free.
- **Compliance concern — highest priority, and a decision for you:**
  - Production is configured with Twilio, and the `process-events` cron runs every minute. It texts caregivers the client's **full name** and shift time.
  - When Twilio is not configured, it logs the phone number and message text.
  - Whether Twilio is covered under a BAA is **UNKNOWN**.
- **Missing outright:** AskCare (no code on any branch), and a report of incomplete visits / missed clock-outs, which is the business problem Ogevia was started to solve.

### Totals (from the table in §2)

| Total reviewed | WORKING | PARTIAL | BROKEN | MISSING | HIDDEN | NOT TESTED | PENDING PR |
|---|---|---|---|---|---|---|---|
| 72 | 23 | 25 | 2 | 3 | 1 | 16 | 2 |

The 58 requested features are rows 1–57 plus row 58 (other substantial features: billing approval). Rows 59–72 are further substantial items found in the repository or during testing.

---

## 2. Feature reconciliation table

Environment prefixes: **PROD** = Netlify + Supabase (`main`); **TEST** = AWS TEST (PR #52 chain).

| # | Feature | Backend | Database | UI | E2E Tested | Status | Evidence | Problem / Gap |
|---|---|---|---|---|---|---|---|---|
| 1 | Authentication / Cognito | TEST: Cognito pool + JWT authorizer. PROD: Supabase Auth | TEST: `app_users`, memberships. PROD: `auth.users` | TEST: Cognito managed login (code + PKCE). PROD: login, set-password, reset-password pages | API: yes (TEST). Browser login: no | PARTIAL | `smoke.py`: anonymous / forged / ID-token / unknown-sub / unapproved-client requests all get 401; pool MFA on and admin-create-only | Cognito covers only the 5-screen TEST slice; production still uses Supabase Auth. Supabase "leaked password protection" is **off** (security advisor). Live browser sign-in needs the owner's TOTP, so it was not run |
| 2 | Owner role | PROD/TEST: `has_permission` + role_permissions | `role_permissions` (PROD, read today) | PROD: full nav. TEST: same 5 screens | No | NOT TESTED | PROD config: `organization_owner` holds every tenant permission, including billing submit and membership update | TEST has no seeded owner identity; the smoke uses manager and caregiver only |
| 3 | Manager role | as above | `role_permissions` | PROD: nav filtered by permission | TEST: yes (manager sub) | PARTIAL | TEST: manager reads visits, billing review, signatures, corrections, care requests (PASS). PROD config: manager lacks `membership.update`, `billing.read`, `billing.submit` | **In PROD a manager cannot edit Care Team records**: profile, skills and availability are all gated by `membership.update`. Stale caregiver availability then feeds CareScore. Billing limits are by design (#46) |
| 4 | Caregiver role | TEST/PROD RPCs check assignment | memberships, `caregiver_assignments` | Verify visit, My Visits, Availability (TEST) | Yes (TEST) | WORKING | TEST: sees assigned client codes only; gets 403 on signatures, corrections and assignment; gets no billing or report data (PASS) | Production caregiver UI not browser-tested |
| 5 | Clients | PROD: direct table + RPCs. TEST: none | PROD `clients`. TEST `ogevia.clients` (seed) | PROD: Clients list + detail. TEST: **none** | No | NOT TESTED | PROD routes `/clients`, `/clients/:id`; component tests pass | **No client management in the AWS path.** TEST clients are seed-only |
| 6 | Caregivers | PROD: `list_care_team_records`, Care Team RPCs | PROD `caregiver_records` | PROD: Care Team list + detail. TEST: none | No | NOT TESTED | PROD routes `/team`, `/team/:id` | No caregiver management in the AWS path. Manager cannot edit (row 3) |
| 7 | Applicants / hiring | PROD: candidate pipeline RPCs, candidate portal | `job_applicants`, `candidate_*` | PROD: Candidates, candidate detail, public apply + portal pages | No | NOT TESTED | Migrations `candidates_hiring_v1*` applied in PROD | Not in the AWS path |
| 8 | Services | PROD: services table | `services` | PROD: Settings → services | No | NOT TESTED | Used by authorizations and scheduling | TEST services are seed-only |
| 9 | Authorizations | PROD: `list_client_authorizations`, `amend_client_authorization` (versioned). TEST: versioned tables + amend function, **no route** | `client_authorizations` (PROD). `ogevia.authorizations` (TEST) | PROD: Authorizations page with "used / scheduled this month" | No (PROD). TEST: read paths only | NOT TESTED | PROD function returns `hours_used_this_month`, `hours_scheduled_this_month`, `version_number` | TEST has no screen or route to create or amend authorizations (see row 59) |
| 10 | Client–caregiver assignments | PROD: insert into `caregiver_assignments`. TEST: none | `caregiver_assignments` keyed by **`caregiver_user_id` only** | PROD: client detail "assign". TEST: none | No | PARTIAL | PROD picker lists only members with role `caregiver` (`client-detail-page.tsx`); PROD schema has no `caregiver_record_id` column | **Caregivers without a login cannot be assigned**, so they cannot use Service Verification. TEST assignments are seed-only |
| 11 | Scheduling | PROD: shifts + triggers (authorization cap, overlap, eligible status), bounded recurrence. TEST: shifts created only by Care Request assignment | `shifts`, `shift_coverage_events` | PROD: Schedule page. TEST: **none** | No | NOT TESTED | PROD migrations `enforce_shift_*`, `prevent_duplicate_shift_scheduling` applied | No scheduling screen in the AWS path |
| 12 | Visits | TEST: `/v1/visits*`. PROD: SV v3 RPCs | `service_visits` | TEST/PROD: Verify visit, Visit records | Yes (TEST) | WORKING | `smoke.py`: visit list, tenant-neutral visit reference, statuses (PASS) | Visits never link to a shift (row 72) |
| 13 | Visit start / clock-in | `start_visit` (server time) | `service_visits.time_in` | Verify visit screen 1 | Yes (TEST) | WORKING | Server time used and client time ignored; same-key retry returns the same visit; a second open visit is refused with 409 (PASS) | Caregiver must hold a `caregiver_assignments` row (row 26) |
| 14 | Visit end / clock-out | `end_visit` (server time) | `time_out`, `worked_minutes` | Verify visit screen 2 → 3 | Yes (TEST) | WORKING | End recorded; `worked >= 2 min` (PASS) | No alert for a visit that is never ended (row 46) |
| 15 | Signature capture | `confirm_visit` + S3 | `visit_signature_metadata` / `visit_signatures` + S3 / Supabase Storage | Verify visit screen 3 | Yes (TEST, API) | WORKING | SSE-KMS encryption; versioned object; UUID-only key path; anonymous GET returns 403; manager-read bytes are identical; caregiver gets 403 (PASS). PROD bucket `visit-signatures` is private | The drawing canvas against the live API was not run today (needs TOTP); earlier runs used a mocked API |
| 16 | No-signature handling | `confirm_visit` without signer | status `administrator_review` | Verify visit "unable to confirm" path | Yes (TEST) | WORKING | No-signature visit → `administrator_review`, 0 billable; listed as needs review (PASS) | — |
| 17 | Manager corrections | `/v1/visits/{id}/corrections` | `visit_corrections` (before/after, reason, actor) | Visit records → "Correct" | Yes (TEST, API) | WORKING | Corrected row created, original kept as `corrected`; history keeps before/after; caregiver gets 403/409 (PASS); UI action present on the AWS branch | — |
| 18 | Audit history | TEST: correction-history report, `care_request_events`. PROD: `audit_logs` + triggers | `audit_logs` (PROD), event tables (TEST) | PROD: platform Audit page, client audit tab. TEST: correction history | Partly (TEST) | PARTIAL | TEST correction-history report PASS; caregiver gets none | TEST has no organization-wide audit view; PROD audit not exercised |
| 19 | Hours worked | Visit minutes + monthly summary | `service_visits` | Visit records, monthly summary | Yes (TEST) | WORKING | Monthly summary: worked / verified / billable minutes per client and service (PASS) | — |
| 20 | Authorization usage | `monthly-service-summary`; `ogevia.authorization_reservations` | reservations + visits | Reports | Yes (TEST) | WORKING | Summary shows authorized vs used; a separate authorization row per service (PASS) | — |
| 21 | Hours remaining | Same summary | — | Reports | Yes (TEST) | PARTIAL | Live today: TEST-C01 October shows `remainingMinutes: 590`, but 420 min were already scheduled (two assigned shifts), so only 170 were free | **"Remaining" ignores reserved / scheduled time.** It overstates what can still be scheduled |
| 22 | Over-authorization prevention | TEST: assignment checks reservations. PROD: shift cap trigger | reservations / shifts | — | Yes (TEST) | WORKING | Live today: assignment refused with 409 "Not enough authorized time remains for this assignment"; smoke cap check PASS | PROD trigger not exercised today |
| 23 | Care Requests | TEST only (`/v1/care-requests`, public portal routes) | `ogevia.care_requests` (TEST). **Absent in PROD** | TEST: Care requests page + public `/care#token` page | Yes (TEST) | WORKING | `smoke.py` care section: 24 of 24 PASS; browser rerun today passed 14 steps before environment timeouts (§3) | **Not in production.** Requires merging the AWS chain |
| 24 | Caregiver offers | TEST: offer links (`/care-offer#token`) | `care_offers` | TEST: staff "send offer" + public offer page | Yes (TEST) | WORKING | Offer link created (256-bit); offer page hides client identity beyond the safe label (browser PASS today) | Links are copied and sent by hand; no SMS or email (row 51) |
| 25 | Caregiver acceptance | TEST: `respond` | offers / requests | Offer page Available / Not available | Yes (TEST) | WORKING | "Available" → `accepted_pending_assignment` and never auto-assigns; caregiver cannot assign (403) (PASS) | — |
| 26 | Assignment from Care Requests | TEST: `assign` creates shift + reservation | `shifts`, `authorization_reservations` | TEST: Care requests → Assign | Yes (TEST, API) | PARTIAL | One shift created; repeat does not duplicate; cap enforced (PASS) | **Does not create a `caregiver_assignments` row**, and `start_visit` requires one (`caregiver_has_active_assignment`). A caregiver who was not pre-seeded is assigned but cannot clock in. Code-verified; not run live |
| 27 | Coverage Needed | TEST: call-out → `coverage_needed`. PROD: `list_shifts.needs_coverage` | requests / `shift_coverage_events` | TEST: staff queue. PROD: Schedule "needs coverage" | Yes (TEST) | WORKING | Call-out → `coverage_needed`; staff queue shows it (smoke PASS today); staff notified and caller not re-offered (08:08 UTC browser run) | PROD path not exercised |
| 28 | Caregiver call-outs | TEST: caregiver's link `cancel-assignment`. PROD: `call_out_shift` | coverage events | TEST: offer page. PROD: Schedule | Yes (TEST) | WORKING | PASS as above | TEST has **no staff-initiated** call-out |
| 29 | Cancellation | TEST: client cancel via link. PROD: `cancel_shift` with reason | requests / shifts | TEST: client page. PROD: Schedule | Partly (TEST) | PARTIAL | Client cancel → `client_cancelled`; offer link returns 404 afterwards; shift released (PASS) | TEST: **agency cannot cancel a care request** (no route). PROD path not exercised |
| 30 | Replacement caregiver workflow | TEST: re-offer + assign | reuses the same shift | TEST: Care requests | Yes (TEST, earlier build) | WORKING | Browser acceptance 42/42 at 08:08 UTC today: replacement is a candidate and assignment **reuses the same shift** (no duplicate). The 14:55 deploy changed only the client-link list (0012) | Replacement cannot clock in unless pre-assigned (row 26) |
| 31 | CareScore | PROD: `_score_caregiver_matches` (20260823080000) | caregiver records / profiles | PROD: client detail Matches tab; Schedule picker | No | PARTIAL | Live PROD formula: proximity 30 + language 25 + availability 20 + skills 10 + history 15 | (a) **Missing caregiver data earns credit** (9/8/10/25 neutral points); fixed in #53. (b) Skills read only from login profiles; fixed in #54. (c) Not in the AWS path at all |
| 32 | Matching engine | PROD: CareScore. TEST: candidate filter only | — | PROD: Matches tab | No (PROD). TEST filter: yes | PARTIAL | TEST candidates = active + available + no overlapping shift + no unavailable date (PASS); no ranking | TEST shows **no score and no reasoning**; PROD ranking not exercised |
| 33 | Location / city matching | PROD: ZIP equal 30, city+state 18, state 6, else 0 | addresses | Breakdown shows "Proximity n/30" | No | PARTIAL | Code read from the PROD-applied migration | No distance or geocoding; no caregiver preferred area (#58 adds a note) |
| 34 | Service compatibility | PROD: **none** in CareScore | `job_applicant_services` (applicant only) | — | No | PENDING PR | #58: `caregiver_record_services` + `match_notes` (service not supported), carried over on hire | Today a caregiver who does not provide the service can rank first |
| 35 | Weekday availability | PROD: `caregiver_record_availability` windows vs client requested schedule (8 pts) | windows table | Care Team availability editor | No | PARTIAL | PROD code | **Overnight windows (e.g. 22:00–06:00) cannot be represented**; #55 fixes this. Managers cannot edit availability (row 3) |
| 36 | Weekend availability | Same day-of-week model (Sat/Sun are ordinary days) | same | same | No | PARTIAL | No separate weekend logic exists | Overnight Fri→Sat / Sat→Sun windows have the same limit (#55) |
| 37 | Schedule availability (conflicts) | TEST: overlap exclusion. PROD: overlap triggers | shifts | — | Yes (TEST) | WORKING | Live today: a caregiver already assigned to an overlapping 20 Oct shift was **excluded** from candidates (diagnostic) | — |
| 38 | Client preferences | PROD: `language_needs`, `care_needs`, requested schedule / services, notes | `clients`, `client_requested_*` | Client detail | No | PARTIAL | Schema read in PROD | No caregiver-gender, continuity, "do not send" or excluded-caregiver fields |
| 39 | Caregiver qualifications | PROD: profile skills (login users), languages | `user_profiles.skills`, `caregiver_records.languages` | Care Team detail | No | PARTIAL | — | Caregivers without a login have no skills on `main` (#54 pending); no service list (#58 pending) |
| 40 | Compliance records | PROD: credentials RPCs, credential types, document requests + daily reminders | `caregiver_record_credentials`, `document_*` | Credentials page, document requests | No | PARTIAL | Cron `queue-document-reminders` active | **Expired or missing credentials do not block matching or scheduling** (no reference in scorer or shift triggers) |
| 41 | Incidents | PROD: insert + `list_incidents`, status / resolution | `incidents` (`caregiver_user_id` only) | Incidents page | No | PARTIAL | PROD schema read | Incidents cannot reference a caregiver without a login |
| 42 | Incident categories | PROD: single `category text` + `incident_types` catalog | `incidents.category` | Single select | No | PENDING PR | #57: `categories text[]`, normalize trigger, `list_incidents` / `global_search` updated, UI multi-select, retry without `categories` on an unmigrated DB (unit-tested); not deployed | — |
| 43 | Reports | PROD: Report Center. TEST: visit records, monthly summary, correction history | — | both | Yes (TEST) | PARTIAL | TEST reports PASS | Remaining-time flaw (row 21); no incomplete-visit report (row 46) |
| 44 | Client utilization reports | PROD: `list_client_operations` (delivered vs authorized). TEST: monthly summary | — | PROD: client operations dashboard | Partly (TEST) | PARTIAL | — | No requested / scheduled / worked / billable / projected split in PROD (#56 pending) |
| 45 | Caregiver hours reports | PROD: Report Center caregiver hours; `get_caregiver_hours` dashboard | — | Report Center, dashboard | No | PARTIAL | `get_caregiver_hours` joins `organization_memberships`, so login users only | **Caregivers without a login are missing from the hours dashboard.** `main` CI fails on this report's date-dependent test |
| 46 | Incomplete visit reports | None | — | Draft visits appear only as rows with a "Draft" badge | — | MISSING | Exceptions filter = `administrator_review`, corrected, or out-of-authorization; **open / draft visits are excluded** | Missed clock-outs (the founding problem) are not surfaced |
| 47 | Billing-ready visit reports | TEST: `/v1/billing-review` | — | Billing review page ("Billing Ready ≠ billed") | Yes (TEST) | WORKING | Corrected signed visit = ready; no-signature visit = needs review; caregiver gets none (PASS) | — |
| 48 | Exception reports | PROD: Report Center "Exceptions". TEST: billing review needs-review | — | both | Partly | PARTIAL | Definition read in code | Excludes open visits (row 46) and schedule variance (row 72) |
| 49 | Dashboard | PROD: `get_agency_dashboard`, owner insights, actionable counts | — | PROD: Operations Dashboard. TEST: none (redirects to a work screen) | No | NOT TESTED | — | Hours figures exclude caregivers without a login (row 45) |
| 50 | AskCare | None | None | None | — | MISSING | Every remote branch searched for "AskCare" / "ask care" / "ask-care": no match | Not started |
| 51 | Notifications | PROD: `process-events` (cron every minute) → Twilio SMS for `shift.assigned` / `shift.coverage_offer`; document reminders. TEST: in-app staff notifications only | `domain_events`, `notifications` (PROD); `care_notifications` (TEST) | TEST: Care requests page list | TEST in-app: yes | PARTIAL | PROD: Twilio and app base-URL providers configured; deployed function identical to repo | **SMS contains the client's full name** (BAA status unknown). With Twilio unconfigured it logs phone + body. Endpoint is `verify_jwt:false`; only an optional shared secret guards it (whether that secret is set is unknown). TEST has no outbound channel |
| 52 | Audit logging | PROD: audit triggers → `audit_logs`. AWS: CloudTrail `ogevia-audit-trail` (multi-region, log-file validation) | — | PROD: Audit page | Partly | PARTIAL | CloudTrail verified | PROD audit not exercised |
| 53 | PHI / security controls | — | — | — | Partly | PARTIAL | TEST: tenant isolation, forged claims, logs free of identifiers and tokens (PASS); RDS private and encrypted | See §6: Twilio PHI, logging of phone and body, leaked-password protection off, two unnecessary `anon` grants (gated), RDS log retention unlimited |
| 54 | RDS / PostgreSQL integration | Lambda (VPC, private subnets) → RDS | `ogevia_sv_test` | — | Yes (TEST) | WORKING | Not public; encrypted; 7-day backups; deletion protection; Lambda in private subnets with app security group (PASS) | Two `db.t4g.micro` instances running (`ogevia-postgres`, `ogevia-prod-postgres`): duplicate fixed cost to review |
| 55 | Evidence / signature storage | S3 (TEST); Supabase Storage (PROD) | metadata only in DB | — | Yes (TEST) | WORKING | Block Public Access ×4, SSE-KMS (customer key), versioning, policy not public, anonymous list 403 (PASS) | — |
| 56 | API authentication | API Gateway JWT authorizer; 8 approved public token routes | — | — | Yes (TEST) | WORKING | 37 routes; only the 8 token routes are public; CORS limited to the web origin (PASS) | — |
| 57 | CloudWatch / logging | 6 alarms (API 5xx, Lambda errors / throttles, RDS CPU / credits / storage), all OK with actions | — | — | Yes | PARTIAL | API / Lambda log groups 365 days | **RDS PostgreSQL log group has no retention (never expires)**; duplicate orphaned API / Lambda log groups |
| 58 | Human billing approval / submission | PROD: `approve_visit_for_billing`, `submit_billing_approvals`. TEST: **read-only review** | `billing_approvals`, `billing_submissions` (PROD) | PROD: Billing page. TEST: no approve action | No | PARTIAL | TEST routes contain no approve or submit endpoint | AWS path cannot approve billing |
| 59 | Authorization amendments (AWS TEST) | `ogevia_api.amend_authorization` exists | versioned `ogevia.authorizations` | None | — | HIDDEN | No API route among the 37 | Retroactive changes cannot be made in TEST |
| 60 | Client self-service request links | TEST public portal routes (token in URL fragment) | `care_portals` | `/care#token` | Yes (TEST) | WORKING | Link shows only that client's services; 3-hour minimum; short-notice flag; reopen lists own requests; revoke → 404 (PASS) | — |
| 61 | Caregiver self-service availability | TEST `/v1/availability/me` | availability windows + unavailable dates | Availability screen | Yes (TEST, API) | WORKING | Unavailable date filters the caregiver out (PASS) | — |
| 62 | Shift claim by SMS link | PROD `claim_shift` (anon, token) | `shift_claim_tokens` | `/claim/:token` | No | NOT TESTED | Live in PROD via Twilio | Same PHI-in-SMS concern as row 51 |
| 63 | Candidate portal / document requests / uploads | PROD token RPCs + `submit-document-upload` edge function | `document_*`, `files` | `/candidate/:token`, `/upload/:token` | No | NOT TESTED | — | — |
| 64 | Subscriptions / Stripe | Netlify functions (checkout, portal, webhook) | `stripe_webhook_events`, plans | Settings / pricing | No | NOT TESTED | — | — |
| 65 | Platform admin (organizations, flags, system health, audit) | platform RPCs | — | Platform shell | No | NOT TESTED | — | — |
| 66 | Support access | `support_access_grants`, cron `expire-support-access` | — | Access page | No | NOT TESTED | Base applied in PROD; follow-up PR #43 still open | — |
| 67 | Global search | `global_search` | — | Header search | No | NOT TESTED | — | — |
| 68 | Data entry in the AWS path (clients, caregivers, services, authorizations, assignments) | None | tables exist | None | — | MISSING | Route list read today | TEST is seed-only; AWS cannot replace production until this exists or an import path does |
| 69 | Caregiver mobile Verify-Visit UI against the live API | — | — | 4 screens | No (today) | NOT TESTED | Component tests + earlier mocked-API browser run at 390 px | Needs an owner TOTP session |
| 70 | Owner / Manager staff UI on AWS TEST in a browser | — | — | 5 screens | No | NOT TESTED | API behind each screen verified | Needs an owner TOTP session |
| 71 | `main` CI | GitHub Actions `validate` | — | — | Yes | BROKEN | `de30bd8`: `service-verification-reports-page.test.tsx` expects "Caregiver hours for 2026-08" (date-dependent); local run: 503/504 web tests, all other packages pass | Fix exists in #53 (`8616449`) |
| 72 | Scheduled shift ↔ visit reconciliation | Both `start_visit` (TEST) and `start_ad_hoc_service_visit` (PROD v3) insert `scheduled_shift_id = null` | column exists, never set | — | Code-verified | BROKEN | Function bodies read: TEST `0006`; PROD `20260824010000`, applied | No scheduled-vs-actual variance; reservations never consumed or released by the visit; shift status not driven by the visit |

---

## 3. End-to-end trace — Phase 3 (Client → billing-ready)

The trace was run in AWS TEST with synthetic TEST-C01 / TEST-C02 and seeded caregiver and manager identities. There are 105 automated checks.

| Step | UI screen | API | Table(s) | Expected | Actual | Result |
|---|---|---|---|---|---|---|
| Client | none in TEST (PROD: Clients) | none | `ogevia.clients` | Create / select client | Seeded client only; code-only display | PARTIAL |
| Authorization | none in TEST | none (read via summary) | `ogevia.authorizations` | Create / amend authorization | Seeded; amendment function has no route | PARTIAL |
| Service | none | `GET /v1/clients/{id}/services` | `services` | Authorized services listed | RSP, 600 min/month listed | PASS |
| Caregiver matching | Care requests | `GET /care-requests/{id}/candidates` | availability, shifts | Eligible caregivers | Available, non-conflicting caregivers listed | PASS |
| CareScore | none in TEST | none | — | Ranked, explained | Not present in TEST; PROD only | NOT TESTED |
| Assignment | Care requests → Assign | `POST /care-requests/{id}/assign` | `shifts`, `authorization_reservations` | Shift + reservation | Created once; cap enforced (409 live) | PASS |
| Schedule | none in TEST | — | `shifts` | Visible schedule | No schedule screen | PARTIAL |
| Visit / clock-in | Verify visit (1) | `POST /v1/visits` | `service_visits` | Server-time start, linked to shift | Server-time start PASS; **`scheduled_shift_id` always null** | PARTIAL |
| Clock-out | Verify visit (2→3) | `POST /v1/visits/{id}/end` | `service_visits` | Server-time end | PASS | PASS |
| Signature | Verify visit (3) | `POST /v1/visits/{id}/confirm` | signature metadata + S3 | Encrypted private evidence; visit locked | PASS | PASS |
| Manager review | Visit records | `GET /v1/visits`, `/signature`, `/corrections` | visits, corrections | Review + correct with audit | PASS | PASS |
| Hours calculation | Visit records / summary | `GET /v1/reports/monthly-service-summary` | visits | Worked / verified / billable | PASS | PASS |
| Authorization usage | Summary | same | visits, reservations | Usage vs authorized | PASS | PASS |
| Hours remaining | Summary | same | — | Authorized − (worked + reserved) | Authorized − worked only (590 shown, 170 actually free) | FAIL |
| Billing-ready | Billing review | `GET /v1/billing-review` | visits | Clean → ready; exceptions → review | PASS | PASS |
| Human billing approval | none in TEST | none | — | Explicit human approval | Not available in TEST (PROD Billing page exists, untested) | FAIL (TEST) |

---

## 4. Care Request chain — Phase 4

| Step | Result | Evidence |
|---|---|---|
| Care Request created (client link) | PASS | API smoke + browser today |
| Eligible caregivers | PASS | Unavailable date and overlapping shift correctly exclude |
| Offer | PASS | 256-bit token link; client identity limited to the safe label |
| Caregiver accepts | PASS | `accepted_pending_assignment`, no auto-assign |
| Assignment created | PASS | One shift + reservation; idempotent; caregiver cannot assign |
| Client / request status updated | PASS | Client link shows Assigned with the caregiver's first name |
| Scheduled shift → caregiver can clock in | **BROKEN** (code-verified) | Assignment does not create `caregiver_assignments`; `start_visit` requires it |
| Caregiver call-out | PASS | Via the caregiver's link only (no staff action) |
| Coverage Needed + staff queue | PASS | Queue shows `coverage_needed`; staff notified in-app |
| Replacement caregiver | PASS (08:08 UTC run) | Same shift reused; no duplicate |
| Cancellation | PARTIAL | Client cancel PASS; agency cancel of a request has no route |

**Where it breaks:** right after assignment. The shift exists, but a caregiver who was not pre-seeded with a `caregiver_assignments` row is refused at clock-in with "This client and service are not assigned to you", and any visit that does happen is not linked to the shift.

The earlier problems you saw — assignment, client Assigned status, call-out → Coverage Needed, and the staff queue — **all pass today** in API checks.

**Browser rerun today:** three attempts against the current build all stopped on 75-second UI waits at different steps (lines 91, 110 and 142). Server metrics for the same window show 0 errors and a maximum Lambda duration of 421 ms. This points to the container's browser→API proxy path (INFERRED). These browser steps are **NOT TESTED today**.

Two first-run failures were diagnosed as **correct behaviour** caused by accumulated synthetic data:
- the October authorization was used up, so assignment was refused with 409;
- the second caregiver was correctly excluded for an overlapping shift.

---

## 5. CareScore / matching — Phase 5

### A. Deployed now (`main` / production)

Source: `20260823080000_wire_real_availability_into_caregiver_matching.sql`, applied in production.

| Factor | Max | Rule | Missing-data behaviour |
|---|---|---|---|
| Proximity | 30 | Same ZIP 30; same city + state 18; same state 6; else 0 | 0 |
| Language | 25 | Share of the client's languages the caregiver speaks | **25 if the client lists none** |
| Availability | 20 | Weekly-hours headroom (12) + requested windows covered (8) | **9 if no target; 8 if no windows recorded** |
| Skills | 10 | Share of care needs in **login profile** skills | **10 if no skills / needs** |
| History | 15 | Completed shifts together (cap 3) − 10 for an open incident | 0 |

Other facts:
- **Eligibility:** only `caregiver_records.status = 'active'`.
- **Not considered:** service type, preferred area, credentials or compliance, client caregiver preferences, distance.
- **Shown to the manager:** total score plus the 5-part breakdown on the client Matches tab. The Schedule picker is ranked by score.
- **Not shown:** reasons or warnings. There are no filters.

### B. Only in pending PRs

| PR | Adds |
|---|---|
| #53 | Missing caregiver data earns **0**, and is named ("Not recorded (scored 0): …") |
| #54 | Skills on the workforce record, so caregivers without a login can match on skills |
| #55 | Overnight windows (22:00–06:00) for availability and requested schedule, in the agency's timezone |
| #56 | Client operations hours split: requested / scheduled / worked / confirmed / billable / remaining / projected |
| #58 | Services supported + preferred cities on the workforce record (carried over on hire); match notes "doesn't support the requested services" / "outside preferred cities"; **weights unchanged** |

### C. AWS TEST

There is no CareScore. Care-request candidates are filtered (active, available, no conflict, no unavailable date) but not ranked or explained.

---

## 6. Security / compliance concerns

1. **PHI to Twilio (production, live).**
   - `process-events` runs every minute, and Twilio is configured.
   - SMS bodies include the client's **full name** and shift time.
   - BAA coverage is UNKNOWN.
   - CLAUDE.md §3 limits notification tooling to non-PHI unless separately approved.
2. **PHI in logs (production).** When Twilio is not configured, the function logs `to` (phone) and the full message body.
3. **`process-events` endpoint is public** (`verify_jwt:false`) and guarded only if `PROCESS_EVENTS_SECRET` is set. That is UNKNOWN; secrets were not read.
4. **Supabase leaked-password protection is off.** Production has no MFA requirement for staff (Supabase Auth).
5. **Unnecessary `anon` execute grants** on `list_care_team_records` and `reassign_shift`. Both are internally gated (`has_permission` / `auth.uid() is null` → refused), so there is **no data exposure**; this is defence in depth only.
6. `prevent_direct_authorization_edit` has a mutable `search_path` (advisor WARN).
7. **RDS PostgreSQL CloudWatch log group never expires.** This conflicts with the finite-retention rule.
8. **Production data is still entirely on Supabase / Netlify.** The AWS controls verified here (KMS, private RDS, Cognito MFA) do not yet protect production data.

Verified **good**:
- TEST tenant isolation and forged-claim rejection;
- logs without identifiers or tokens;
- private, encrypted evidence storage;
- private, encrypted RDS with deletion protection;
- CloudTrail with log-file validation;
- the production `visit-signatures` bucket is private.

---

## 7. Data integrity concerns

1. **Visits never link to their shift** (both environments). Scheduled vs worked cannot be reconciled, and AWS reservations remain held after the visit.
2. **"Remaining" overstates availability** (AWS): reserved time is not subtracted.
3. **Caregivers without a login** are missing from:
   - assignments;
   - incidents;
   - the hours dashboard (`get_caregiver_hours`);
   - CareScore skills (#54 pending).
4. **Care Request assignment does not grant visit access**, so an assigned caregiver can be blocked at clock-in.
5. **Neutral credit for missing caregiver data** inflates scores of incomplete profiles (#53 pending).
6. **Overnight availability cannot be stored**, so overnight caregivers are under-matched (#55 pending).
7. **Synthetic TEST data has accumulated:**
   - TEST-C01's October authorization is mostly reserved;
   - 13 cancelled and 6 offering requests.

   Future acceptance runs must use a later month, or a data reset done in an approved window.

---

## 8. Highest-priority fixes

The ten blockers are listed at the end, in §11.

## 9. Features that should NOT be rebuilt — they already exist

- Service Verification v3, both production and AWS:
  - server-time start and end;
  - the 4-screen flow;
  - signature and no-signature paths;
  - corrections with before/after audit.
- Billing-ready separation and the "Billing Ready ≠ billed" wording.
- Production human billing approval and submission (`approve_visit_for_billing`, `submit_billing_approvals`).
- Versioned authorizations with amendments (production, and the AWS function).
- The shift authorization cap and overlap triggers (production), and the reservation cap (AWS).
- The AWS Care Request chain: links, offers, acceptance, assignment, call-out, coverage queue, replacement, cancellation, revoke.
- Production call-out / reassign / cancel-with-reason, and SMS claim links.
- CareScore and the Matches tab. Improve it through #53–#58; do not redesign it.
- Candidate hiring pipeline, candidate portal, document requests and reminders.
- The AWS foundation:
  - Cognito;
  - the JWT authorizer;
  - KMS-encrypted private S3 evidence;
  - private RDS;
  - alarms;
  - CloudTrail.

## 10. Recommended next implementation sequence

1. **Decide the Twilio / PHI question (owner decision)**, and remove phone and body from logs. This is live production exposure.
2. **Merge the CareScore stack #53 → #54 → #55 → #56 → #58, plus #57.**
   - #53 also turns `main` CI green.
   - Then apply their migrations to production in an approved window, in this order: 010000 → 020000 → 030000 → 040000 → 060000, plus 050000 (independent).
3. **Link visits to shifts** in both start functions: resolve the caregiver's scheduled shift for that client, service and time. Then consume or release the reservation, and report scheduled-vs-worked variance.
4. **Make Care Request assignment grant visit access** (create or extend the caregiver's assignment), and add an agency cancel route.
5. **Fix "remaining" to subtract reserved / scheduled time** in the AWS monthly summary, and show "scheduled" separately.
6. **Add an incomplete / open-visit (missed clock-out) report and alert.**
7. **Decide the AWS merge path:** open PRs for the `phase0`–`phase3` chain into `main`, so #51 and #52 can merge.
8. **Close the AWS data-entry gap** (clients, caregivers, services, authorizations, assignments), or choose an import path, before any cutover.
9. **Caregivers without a login:** add `caregiver_record_id` to assignments and incidents, and to `get_caregiver_hours`.
10. **Add a credential / compliance gate** to matching and scheduling.
11. **Decide whether the manager role should get `membership.update`** (or a narrower availability / skills permission).
12. Housekeeping:
    - RDS log retention;
    - the duplicate RDS instance and log groups;
    - leaked-password protection;
    - remove `anon` grants;
    - pin `search_path`;
    - delete the retired edge-function stubs.

## 11. Ten highest-priority issues blocking a complete operational agency system

1. Client names are sent by SMS to Twilio in production, with BAA status unknown, and phone numbers and message bodies are logged when Twilio is unconfigured.
2. Visits never link to scheduled shifts in either environment, so there is no scheduled-vs-actual reconciliation and AWS reservations stay held.
3. In AWS, a caregiver assigned through a Care Request cannot clock in unless a separate assignment row already exists.
4. Missed clock-outs (open visits) are not reported or alerted anywhere.
5. AWS "remaining" hours overstate what can be scheduled, because reserved time is ignored.
6. The AWS path has no screens for clients, caregivers, services, authorizations, assignments, scheduling, CareScore, incidents or billing approval. It cannot replace production as built.
7. The entire AWS backend and Care Requests (138 commits) have no merge path to `main`.
8. Production CareScore credits missing caregiver data, ignores service type and overnight availability, and reads skills only from login users. The fixes sit in unmerged #53–#58.
9. Caregivers without a login are excluded from assignments, incidents and the hours dashboard.
10. Credentials and compliance status do not gate matching or scheduling, and production managers cannot maintain caregiver availability or skills.

---

## Evidence index

- **AWS smoke:** `infra/aws/slice/smoke.py` (PR #52 branch), run 2026-10-02 ≈22:30 UTC → `105 checks, 104 passed, 1 failed`. The failure was the web check: container proxy 403 to CloudFront.
- **Browser acceptance:**
  - 42/42 at 08:08 UTC on the previous build;
  - three reruns today on the current build stopped on 75-second waits at different steps.
- **CloudWatch:** for the 90 minutes around the tests:
  - Lambda: 177 invocations, 0 errors, 0 throttles, maximum duration 421 ms;
  - API: 78 requests, 0 5xx, 14 4xx (intentional negative tests).
- **Live diagnostics** (synthetic, TEST):
  - assign → 409 "Not enough authorized time remains for this assignment";
  - October summary: TEST-C01 `authorizedMinutes 600, workedMinutes 10, remainingMinutes 590`, with 420 minutes assigned in two shifts.
- **Production metadata:**
  - `list_migrations` (158 names vs `main`);
  - table list;
  - `role_permissions`;
  - storage buckets;
  - `cron.job` names;
  - integration provider presence;
  - edge-function list and source (`process-events`, retired stubs);
  - security advisors.
- **`main` tests:** `turbo run test --force` → auth 10/10, shared 118/118, ui 73/73, web 503/504. The one failure is the date-dependent reports test, matching CI on `de30bd8`.
