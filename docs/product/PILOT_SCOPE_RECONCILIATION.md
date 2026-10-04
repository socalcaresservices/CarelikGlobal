# Ogevia controlled-pilot scope: status against the consolidated requirements

**Date:** 2026-10-04, about 08:40 Pacific. **Release candidate:** the commit pinned in `infra/aws/slice/increment-bootstrap.sh`. It is `cbdfa3a` plus the Administrator label and the live manager money check.
**Verdict: NOT READY FOR OGEVIA CONTROLLED PILOT (real clients).** The blockers are in the summary at the end.

## Status key

| Status | Meaning | Evidence class |
| --- | --- | --- |
| **LIVE** | Deployed to AWS TEST through migration 0018 (pilot build 87a9be2) | Owner-reported deployment 12/12. Phone results C and part of G passed 2026-10-04. Live check ledger 0018. |
| **THIS DEPLOYMENT** | In the release candidate. Passes the local gate and the rehearsal, but is not yet live. | Verified locally; needs the live run plus phone checks |
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
| Create, view, update and activate/deactivate **clients** from screens | **BUILT, NOT YET DEPLOYED** (migration 0022, 2026-10-04) | Clients list and client page: add, edit details, change status with a reason (refused while a visit is in progress), configurable client types, city. Audited. Tests: DB 12, API 2, web 8, browser 28/28 at 390 px. |
| Same for **caregivers and services** | **BUILT, NOT YET DEPLOYED** (migration 0023, 2026-10-04) | Care Team: add (random code), rename, status with a reason. Making a caregiver **inactive ends their active assignments and suspends their sign-in for the agency at once** (refused while a visit is in progress); reactivation restores the sign-in only. Services (Administrator only): add (code fixed, unique per agency), rename, deactivate/reactivate with a reason; deactivation refused while current authorizations use the service. Audited. Tests: DB 7, API 2, web 5, browser 20/20 at 390 px, including a signed-in caregiver losing access. **Not included:** inviting a caregiver to sign in (needs the API to create Cognito users, a security decision). | The AWS database API has no create or update function for clients, caregivers or services (full list of `ogevia_api` functions checked 2026-10-04). Records come from SQL seeds. |
| Administrator and manager see client names | THIS DEPLOYMENT | 0020 `client_private_names`, `clients.names.read` |
| Caregiver restrictions; payer identifiers protected | LIVE | Caregivers see codes only. Payer and authorization numbers are not returned to caregivers. |
| Location/city and configurable client type | BUILT, NOT YET DEPLOYED (0022) | `clients.city`, per-agency `client_types`; names and city returned only with `clients.names.read` |
| **Ordinary administration without database commands** | **NOT MET** | Onboarding a real client, caregiver, service or authorization needs SQL today |

## 5. Authorizations and hours

| Requirement | Status | Evidence |
| --- | --- | --- |
| Service-specific monthly minutes, period start and end, remaining balance | LIVE (data and calculations) | `client_authorizations`, reconciliation and summary reports |
| Amendments keep history (versioned lineage) | LIVE (database) | `amend_client_authorization`; `06_authorization_invariants.sql` |
| No double allowance or double counting; calculated per client, service and period | LIVE | `no_overlapping_current_authorizations`; reservations; tests |
| **Create or amend authorizations from a screen** | **BUILT, NOT YET DEPLOYED** (0022) | Add (version 1); overlapping coverage for the same client and service is refused with "amend that one instead"; minutes 1–44,640 (catches hours typed as minutes); amend creates a new version with a reason, keeps history, carries the rate forward and lists visits to review. Balances come from the existing `list_monthly_service_summary`, so there is one calculation. Only the Administrator can set a rate (`authorizations.rates.manage`), and only `billing.read` sees it. Concurrent overlapping creations: exactly one succeeds (test). |
| Warnings for approaching limits, overages and expiry | PARTIAL | NEEDS ATTENTION counts review and overage visits; there is no expiry warning |
| Worked hours kept when not billable | LIVE | `worked_minutes` versus `billable_minutes`; administrator review |

## 6. Scheduling and coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| Availability; shifts created through Care Requests with authorization checks | LIVE | Pilot section B (pre-deployment result; B4 refusal not re-reported) |
| Visits linked to scheduled shifts; unscheduled visits flagged for review; overlaps prevented | LIVE | 0016/0017 shift link; `start_ad_hoc_service_visit`; one open visit per caregiver; overlap check in close-out |
| **Call-outs, replacement caregivers, uncovered-shift view, coverage history screens** | **NEEDS IMPLEMENTATION** | `shift_coverage_events` table exists, but there is no API or screen for it |
| Assignment management screens | **BUILT, NOT YET DEPLOYED** (migration 0024, 2026-10-04) | On the client page ("Caregivers assigned") and the caregiver page ("Clients assigned"): assign with a first day (defaults to the agency's local today) and an optional last day. The caregiver must have a sign-in; overlapping assignments for the same caregiver, client and service are refused (two simultaneous attempts: exactly one succeeds); a missing authorization is flagged in red, not hidden. End with a reason: a future assignment is cancelled; a running one gets a last day (shortening only); ending before today is refused while a visit is in progress. Audited. Tests: DB 7, API 1, web 2, browser 19/19 at 390 px (a caregiver gains the client on Verify visit once assigned). |

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
| Pinned release with backup, rollback that keeps later records and uploads, strict scope check, 9 live checks | Ready (rehearsed); waiting for the owner's DEPLOY |
| Full workflow on real AWS (authorization and scheduling through confirmation, approval and reports), with two-agency isolation | After deployment. Authorizations and schedules still come from seeds, so only the seeded part can be tested. |
| Phone retest of changed workflows | After deployment (plan section 6) |
| Production correction fix | Kept separate; needs its own approval |

## Summary: why NOT READY for real clients, and what clears it

| # | Blocker | Owner of the next step | Next action | Fits today's 13:20 target? |
| --- | --- | --- | --- | --- |
| 1 | Clients and authorizations: **built, needs a reviewed deployment** (0022 plus 10 API routes). Caregivers and services: **built, needs a reviewed deployment** (0023 plus 7 routes). Assignments: **built, needs a reviewed deployment** (0024 plus 3 routes). Still missing: caregiver sign-in invitations and shift scheduling with call-outs (sections 4–6). | Claude (build) | Port the Supabase screens to the AWS API, starting with authorizations, then clients, team and schedule (inventory order), with permission, versioning and double-count tests | **No.** Several days. |
| 2 | Utilisation dashboard beyond monthly per service (section 9) | Claude (build) | Periods, breakdowns, coverage and expiry warnings, projections | **No** |
| 3 | G1 and D2 not applied | Owner | Run `phase7-remediate.sh`, type APPLY, confirm the alarm email | Yes, about 10 minutes |
| 4 | HIPAA operating policies not confirmed | Owner | Confirm in writing | Owner decision |
| 5 | Release not yet deployed or phone-tested | Owner | Paste the pinned block; run the phone checks | Yes |

What can be finished today: deploy the release, create the manager, apply G1 and D2, and run the phone checks on **synthetic** data. That makes Ogevia ready for a **synthetic-data dress rehearsal**, not for real clients.
