> **FINAL (2026-10-18, after CI run 361).** Corrected closure checklist for release candidate `3159e520a7b9bc7006ee82d526a907622d30d97c`. It supersedes the earlier version of this file in the candidate and the first attachment, which said CI had not yet run on the candidate and called the TEST ledger unverified. The 88 requirement rows are unchanged. Deployment procedure: `OPERATOR_PROCEDURE_3159e52.md` (supersedes every earlier runbook).

# Release candidate closure checklist (one list: five-board handoff, owner directives, 88-row matrix, known defects)

Branch `integration/compliance-attention-onto-scheduling-recruiting`. **Candidate commit `3159e520a7b9bc7006ee82d526a907622d30d97c`** (final code commit `64515dd`; the candidate adds only the closure document and screenshots). This copy is the corrected attachment prepared after the candidate was bundled; the in-repository copy at the candidate is the earlier wording. **Implemented and tested locally on synthetic data. Not pushed, merged, deployed, activated or run on TEST. No AWS call was made.** Later explicit owner decisions govern; White, Minimal, the simplified four-stream Home and the authorization-decrease behaviour are preserved. Migrations: 0001 to 0077.

Evidence classes: LOCAL VERIFIED = executed here (section 1). NOT VERIFIED = needs AWS, a real device or an external system (sections 4 and 6). A row says COMPLETE only where code exists and a named test or browser check exercises it; a passing test alone does not make a row complete, so each row also states its limit.

## 0. What changed since the previous package

- 0077 (new): the sidebar and Action-needed totals now agree with the issue list. The two expected-failure markers (F2 total, F4 coverage window) were removed and are ordinary passing tests. A third mismatch found while reconciling every category (an agency's shorter confirmation deadline moved the list but not the summary) is fixed.
- 0077 (new): approved in-app notifications (Board 4 decision 11, in-app part): Critical always, Urgent per agency setting, never Routine, one per person/issue/severity (and per return of the issue), stop when resolved, never deleted, random client code only. Header Notifications button, owner setting on Action needed, four API routes.
- The previous tracker marked "in-app notifications logic" complete; it was not built. Corrected.
- Phone browser pass found the notifications panel overflowing the screen; fixed and re-run.
- `db/verification/08_release_objects.sql` (read-only post-migration check of every table and function added by 0053 to 0077).

## 1. LOCAL VERIFIED: final test results (commit `64515dd`, local PostgreSQL 16, synthetic data)

| Gate | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass |
| Web (apps/web, jsdom) | 114 files, 1086 tests passed |
| sv-api unit | 3 files, 73 passed |
| sv-api against PostgreSQL | 14 files, 115 passed |
| infra static (CDK assertions, handler checks) | 13 files, 195 passed |
| Database suite (includes populated upgrade 0052 to 0077 and back, rollback chain, enforcement-enabled fixture, counts reconciliation, notifications) | 84 files, 840 passed |
| packages/shared, auth, ui | 118, 138, 73 passed |
| Browser, desktop 1280 px, freshly reset database | 106 / 106 checks |
| Browser, phone 390 px, freshly reset database | 106 / 106 checks |
| Fresh database migrated 0001 to 0077, `db:verify` | 369 checks PASS, 0 FAIL |
| Previous API code (origin/main, 0052) on the new schema | 73 of 75 API database tests pass; the 2 failures assert behaviour that 0055 and 0063 intentionally changed |
| CI on the candidate head (GitHub Actions run 361, PR 100): jobs `validate`, `postgres` (postgres:18 image) and `harness` | all success. GitHub's generated merge commit has the identical tree to the candidate, so the content tested is the candidate's |
| PostgreSQL 18.4 (community binary), run locally | database suite 840 of 840, sv-api database 115 of 115, fresh migration 0001 to 0077 then `db:verify` 369 PASS 0 FAIL |
| Unresolved failures | none. No `it.fails` marker remains for these defects. Note: database tests skip silently when `OGEVIA_TEST_DATABASE_URL` is unset; every count above was run with it set |

## 2. Row-by-row closure (all 88; ID, code location, status, evidence and remaining limitation)

Summary: 65 complete locally, no open item; 19 complete locally with a stated limit, owner decision, activation or external step; 2 external check only; 1 open owner decision; 1 superseded by owner decision.

| ID | Status | Code location | Evidence / remaining limitation |
|---|---|---|---|
| B1-R1 | COMPLETE | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Home order: refresh status, four streams, quick actions, top-issues panel, today's visits; home-closure.test, attention-severity.test |
| B1-R2 | SUPERSEDED | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Owner decision 2026-10-17: simplified four-stream Home governs (README s16.1) |
| B1-R3 | COMPLETE | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | TodaysVisits highlights uncovered, held and credential-blocked shifts; home-closure.test |
| B1-R4 | COMPLETE | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Three permission-aware quick actions; home-today.test |
| B1-R5 | COMPLETE | `apps/web/src/aws/home-page.tsx (authorization alert link); 0057` | Authorization alert on Home links to affected clients; 0057 tiers; home-closure.test, authorization-tiers.db.test |
| B1-R6 | COMPLETE | `apps/web/src/aws/home-extras.tsx TopIssues; 0073 list_action_issues` | TopIssues panel (Critical then Urgent, deadline, direct action, View all) fed by list_action_issues (0073); home-closure.test, action-issues.db.test |
| B1-R7 | COMPLETE | `apps/web/src/aws/tracked-api.ts, aws-organization-provider.tsx` | Refresh status + manual refresh; any successful write invalidates attention/overview/issues (tracked-api.ts); tracked-api.test |
| B1-R8 | COMPLETE LOCALLY; EXTERNAL CHECK | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Desktop 1280 and phone 390 browser passes 102/102 each; real-device run still required (device script) |
| B1-R9 | COMPLETE | `apps/web/src/aws/home-data.ts useCollapsed` | Optional sections (hours, finance) collapse, remembered per agency in the browser; mandatory alerts cannot be hidden; home-closure.test. A saved default-view setting beyond collapse is not built (consequence: none for the pilot) |
| B1-R10 | COMPLETE | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Empty/loading/error states with Retry; curated error text; no false zero; home-closure.test |
| B1-R11 | COMPLETE | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Role/permission-filtered Home; server permission checks; tenant tests (rls/tenant db tests) |
| B1-R12 | COMPLETE LOCALLY; EXTERNAL CHECK | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Labels, severity names (not colour alone), touch targets tested in jsdom/browser; screen-reader run is an external check |
| B1-C1 | EXTERNAL CHECK | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Performance needs measurement on TEST with realistic volume; bounded pages (limit/offset) are implemented |
| B1-C2 | COMPLETE | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Partial/stale/failed sources reported, never shown as zero; home-closure.test |
| B1-C3 | COMPLETE | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Server-side scope; actions go through audited source modules |
| B1-C4 | OWNER DECISION | `apps/web/src/aws/home-page.tsx, home-extras.tsx, home-data.ts, tracked-api.ts; 0073` | Hours, Financial impact, Continuity and Outage cards remain below the new sections (folded by default option). Owner has not said remove or keep |
| B1-C5 | COMPLETE | `0073 action_issue_rows (shared issue key)` | One issue key <kind>:<reason>:<entity> shared by Home, Schedule, Action needed (0073); action-issues.db.test |
| B2-D1 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Consolidated authorization summary; authorization-display.test |
| B2-D2 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Tiers and 30-day expiry (0057) |
| B2-D3 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Client page order: alerts, quick actions, authorization first, then visits, caregivers; client-closure.test; phone screenshot |
| B2-D4 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Server-side reservation refuses over-authorization with shortage text |
| B2-D5 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Versioned amendments with impact list (0066-0070); authorization-amendment tests |
| B2-D6 | COMPLETE | `0073 action_issue_state/events; apps/web/src/aws/action-needed-page.tsx` | Alerts are open issues only; history kept as OBSERVED events (action_issue_events); action-issues.db.test |
| B2-D7 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Each alert deep-links with client and issue context; client-closure.test |
| B2-D8 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Schedule Visit, View Authorization, Verify Visit primary; others under More; client-closure.test |
| B2-D9 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Compact caregiver summary (name, status, next visit); client-closure.test |
| B2-D10 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Next three visits with full-schedule link; client-closure.test |
| B2-D11 | COMPLETE; OWNER DECISION on payment rules | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Release of unused hours and linked same-month make-up implemented (0070/0072). Whether a late cancellation by the client or agency is payable is not decided; no payment rule is coded |
| B2-D12 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Current authorization, expandable version history, audit; client-closure.test |
| B2-D13 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, clients-page.tsx; 0074 find_possible_duplicate_clients, list_client_audit` | Read-only details, focused edit, duplicate warning (find_possible_duplicate_clients), audit by field name only; client-readiness.db.test, client-closure.test |
| B2-D14 | COMPLETE | `apps/web/src/aws/client-extras.tsx; 0074 client_document_* tables and functions; sv-api client-document routes` | Document types, per-client versions, Missing/Pending Review/Approved/Expired/Rejected, private upload, review with no self-review (0074); client-readiness.db.test, client-documents.db.test |
| B2-D15 | COMPLETE | `0074 client_gate trigger, set_client_preparation` | Draft/Pending preparation, service-specific requirements, activation refused unless ready; scheduling refused for clients in preparation or held service (trigger); client-readiness.db.test, final-enforcement.db.test |
| B2-D16 | COMPLETE WITH NOTED LIMIT | `0074 client_service_holds; client_gate` | Expired authorization yields a derived expired state that blocks new scheduling and flags (never deletes) future shifts; manual service holds are stored. Lapse itself is not a stored hold row |
| B2-D17 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx (guided renewal over 0068 amend)` | Guided renewal in client page over the existing amend + impact flow; client-closure.test |
| B2-D18 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Permissions, tenant isolation, audit (RLS and permission DB tests) |
| B2-D19 | COMPLETE LOCALLY; EXTERNAL CHECK | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Authorization-first, alerts, mobile layout verified at 390 px; real device pending |
| B2-D20 | COMPLETE | `apps/web/src/aws/client-detail-page.tsx, client-extras.tsx, client-data.ts; 0057, 0066-0070, 0074` | Committed = billable + approved rounding + reserved; over-limit shown, not clamped |
| B3-R1 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Day, Week (default), Month views; schedule-closure.test, browser |
| B3-R2 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Overview strip: today, upcoming, uncovered, urgent; schedule-closure.test |
| B3-R3 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Guided creation prefilled from client (?client, service, authorization); schedule-closure.test |
| B3-R4 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Recurring series with end date and per-date exceptions |
| B3-R5 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Filters by caregiver, client, service, status. Location/team filter not built: the data model has no location or team |
| B3-R6 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Server-side reservation, concurrency-safe |
| B3-R7 | COMPLETE LOCALLY; ACTIVATION REQUIRED | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Overlap is always refused; availability/readiness refusal applies only when the owner activates enforcement (enforcement-matrix.db.test, final-enforcement.db.test with enforcement enabled). Administrator availability override exists (0047) |
| B3-R8 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Configurable daily/weekly limits (SoCal 8 h/40 h) |
| B3-R9 | COMPLETE LOCALLY; ACTIVATION REQUIRED | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Credential gating and per-shift risk list built; the gate refuses new work only after the owner activates enforcement on TEST (one-way, after read-only preview). Enabled-enforcement fixture passes (final-enforcement.db.test) |
| B3-R10 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Overlap detection |
| B3-R11 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Cancellation releases unused hours, keeps delivered |
| B3-R12 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Linked same-month make-up |
| B3-R13 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Uncovered shifts prioritized |
| B3-R14 | COMPLETE | `apps/web/src/aws/replacement-model.ts, schedule-page.tsx ReplacementSuggestions; POST /v1/matching/candidates` | Replacement suggestions from the existing scoring rule via POST /v1/matching/candidates; reassignment history kept; replacement-model tests |
| B3-R15 | COMPLETE | `0075 list_shifts display_state; apps/web/src/aws/schedule-views.tsx` | display_state: cancelled, no_show, in_progress, verification_pending, in_review, partial, completed, missed, not_delivered, delivered_not_verified, awaiting_record, covered, needs_coverage (0075); shift-display-states.db.test |
| B3-R16 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | `0077 issue_notifications, list_my_notifications; apps/web/src/aws/notifications.ts, notifications-bell.tsx, aws-shell.tsx` | In-app notifications built (0077): Critical always, Urgent by agency setting, deduplicated per person/issue/severity, stop when resolved, history kept, random client code only. Outbound email/SMS/push NOT built: channel and PHI decision outstanding. A notification is created when the person (or the app on their behalf) next reads their list, not while nobody is signed in; no scheduled generator is deployed |
| B3-R17 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Scheduling changes audited |
| B3-R18 | COMPLETE LOCALLY; EXTERNAL CHECK | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Phone pass 102/102; real device pending |
| B3-E1 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | No override of hard limits |
| B3-E2 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Valid dates saved, rejected dates listed with reason |
| B3-E3 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Suggestions plus administrator confirmation and history |
| B3-E4 | COMPLETE; OWNER DECISION on payment rules | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Verified hours kept, unused released, timing recorded. Late-cancellation payment rule/cancelling party not decided |
| B3-E5 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | No carryover without authorization allowance |
| B3-E6 | COMPLETE | `apps/web/src/aws/schedule-page.tsx, schedule-views.tsx, schedule-model.ts, replacement-model.ts; 0053, 0060-0063, 0075` | Ranked eligible caregivers for urgent coverage; administrator confirms; no automatic assignment |
| B4-D1 | COMPLETE | `0077 get_attention_summary; 0073 list_action_issues` | list_action_issues returns server counts and limit/offset pages (0073). Sidebar-badge/Action-needed summary defect fixed in 0077: server total equals the displayed sum (F2) and unfilled shifts count only inside 48 h (F4); both former expected-failure tests are now ordinary passing tests; attention-counts-notifications.db.test reconciles summary with the list |
| B4-D2 | COMPLETE | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Pending Confirmation separate until overdue |
| B4-D3 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | `0073 attention_rule_hours, set_attention_settings` | 48 h default, agency may set shorter (attention_rule_hours). Stricter payer/regulatory deadlines unspecified |
| B4-D4 | COMPLETE | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Administrator review immediate; Urgent after 24 h (agency may shorten) |
| B4-D5 | COMPLETE WITH NOTED LIMIT | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Risk-based review; 'blocks required work' is approximated as a caregiver flagged on an upcoming shift |
| B4-D6 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | `0073 attention_rule_hours, set_attention_settings` | 48 h default, shorter allowed; payer-specific rules unspecified |
| B4-D7 | COMPLETE | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Critical/Urgent/Routine ordering and filters by category, client, caregiver, service; action-needed-page.test, action-issues.db.test |
| B4-D8 | COMPLETE WITH NOTED LIMIT | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Tiers reclassify on read (not as a stored transition) |
| B4-D9 | COMPLETE | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Reason, urgency, deadline, recommended action, prefilled link; action-needed-page.test |
| B4-D10 | COMPLETE | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Stable issue identity and history across Home, Schedule, Action needed |
| B4-D11 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | `0077 issue_notifications, agency_notification_settings; apps/web/src/aws/notifications-bell.tsx, action-needed-page.tsx NotificationSettingsCard` | Same as B3-R16 (in-app part of Decision 11 built; delivery channels, reminder intervals and escalation recipients remain separate design details per the decision text; Routine summaries optional, not built) |
| B4-D12 | COMPLETE LOCALLY; EXTERNAL CHECK | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Compact action cards at 390 px; real device pending |
| B4-D13 | COMPLETE | `apps/web/src/aws/action-needed-page.tsx, action-issues.ts; 0073, 0077; apps/sv-api/src/routes.ts` | Server permissions, tenant isolation, audit history |
| B5-R1 | COMPLETE | `apps/web/src/aws/reporting-page.tsx` | Reporting & billing hub page with the five sections; reporting-closure.test |
| B5-R2 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Human billing approval; Already Billed/G11 stays deferred |
| B5-R3 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Billing states and words |
| B5-R4 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Pending signatures stay in the reminder workflow |
| B5-R5 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Worked/verified/billable/reserved distinguished |
| B5-R6 | COMPLETE (by rule) | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Missed-visits metric intentionally not published (null + "Not published"); definition needs owner |
| B5-R7 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Unresolved balances and rounding shown as dependencies |
| B5-R8 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Server-generated exports, role-limited figures, audit |
| B5-R9 | EXTERNAL CHECK | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Owner review of the mobile mockup is outside code |
| B5-R10 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Billing Readiness section |
| B5-R11 | COMPLETE | `apps/web/src/aws/reporting-page.tsx; apps/sv-api/src/exports.ts, routes.ts; 0062, 0069, 0070, 0072, 0076` | Authorized vs Delivered section |
| B5-R12 | COMPLETE WITH NOTED LIMIT | `0076 get_agency_performance` | get_agency_performance (0076): uncovered shifts, cancellations, utilization; missed visits not published; agency-performance-audit.db.test |
| B5-R13 | COMPLETE | `0076 request_report_export billing_review; sv-api exports.ts` | Billing-review CSV added (0076); exports capped at 4 MB; reporting-closure tests |
| B5-R14 | COMPLETE | `0076 list_audit_report` | Owner-only audit report with field names only, no values (0076); agency-performance-audit.db.test |

## 3. Proposed deferrals and their consequences

None is silently dropped. Each is a business policy the owner has not set, an external dependency, or work that cannot be done in code.

| Item | Why it is not finished | Consequence if left as is |
|---|---|---|
| Outbound notifications (email, SMS, push) | Channel and PHI handling undecided (CLAUDE.md: email tooling is non-PHI only). In-app notifications ARE built (0077). | Staff see notifications in the app only, when they open it. Nothing is sent. |
| In-app notification generation while nobody is signed in | A notification is created when that person's list is read. The 15-minute `ComplianceSweep` does not generate them. | A Critical item that appears overnight is notified at the person's next sign-in (its time is when it was first seen by them, not when it began; the issue itself shows its own start time). |
| Routine summaries (optional in decision 11) | Optional; no channel for a digest. | Routine items stay listed in Action needed. |
| Late-cancellation payment, cancelling party (B2-D11, B3-E4) | Payer/policy rule. | Hours released and delivered hours kept; no payment rule coded. |
| Location/team filter (B3-R5) | No location or team in the data model. | Filters: caregiver, client, service, status. |
| Stricter payer/regulatory deadlines (B4-D3, B4-D6) | None supplied. | Defaults 48 h / 24 h; an agency may only shorten. |
| Hours, Financial impact, Continuity, Outage cards (B1-C4) | Owner has not said keep or remove. | Remain below the four streams; hours and finance can be folded. |
| Missed-visits metric (B5-R6, B5-R12) | Undefined; Board 5 rule 6 forbids publishing it. | Report shows "Not published". |
| Export access | Owner and manager only; confirmation pending as instructed. | Unchanged. |
| B2-D16 lapse as a stored hold | Derived at read time; only manual holds are stored. | Same scheduling behaviour; no lapse row in hold history. |
| G11 / Already Billed | Deferred by instruction. | Not built. |
| B5-R9 mobile mockup review | Owner visual review. | No code effect. |

Authorization-decrease behaviour is unchanged (worked service preserved, impacts flagged for human review, no history rewritten); the confirmation question is closed by the owner's instruction to preserve it.

## 4. Local verification versus external checks

| Verified locally (this session, synthetic data, PostgreSQL 16) | NOT verified: needs the real thing |
|---|---|
| Migrations 0001 to 0077 from empty; populated upgrade 0052 to 0077 and rollback in reverse and re-apply (`upgrade-0052-to-final.db.test.ts`) | **The managed RDS engine itself** (parameter group, extensions, collation). PostgreSQL 18 behaviour is covered by CI run 361 (`postgres`, postgres:18 image, success) and by local runs on 18.4. |
| Enforcement enabled on synthetic fixtures (`final-enforcement.db.test.ts`) | Enforcement on the real tenant (owner action, separate GO) |
| The previous API code (origin/main, migration 0052) against the new schema: 73 of 75 API database tests pass; the two that fail assert behaviour 0055 and 0063 intentionally changed (background-check wording; caregiver pickup now needs office confirmation) | The deployed API and web on TEST, CloudFront, Cognito sign-in, API Gateway authorizer, Lambda, VPC reach to RDS |
| Counts reconciled with lists (summary categories vs issue-list rows, shorter agency deadline, 48 h coverage window, total) | Real-device phone and tablet run; screen reader; performance on realistic volume |
| Desktop 1280 px and phone 390 px browser scenarios, each from a freshly reset database | The EventBridge `ComplianceSweep` firing in AWS |
| Roles, tenant isolation, idempotency, concurrent reservation/claim/finalise, exports (4 MB cap), audit history | A restore of the TEST snapshot (never rehearsed from here) |

## 5. Tracker reconciliation and defects

Task tracker against code (corrected): tasks 1 to 4 match code and tests. Task 5 said "in-app notifications logic" was complete; it was not. Only Reporting was built then, and notifications were deferred in the earlier closure. They are built now (0077). The sidebar badge-count defect was recorded as two expected-failure tests (F2, F4); both are fixed in 0077 and are ordinary passing tests. While reconciling every summary category with the list I found and fixed a third mismatch: an agency's shorter confirmation deadline moved a visit in the list but not in the sidebar summary.

## 6. External triggers

Evidence read from GitHub on 2026-10-18: a plain push of a new branch started no GitHub Actions workflow (every one of 146 recorded push-triggered runs is on `main`); a pull request starts CI (PR 99, PR 88 and now PR 100 all ran `validate`, `postgres`, `harness`); a pull request against `main` gets a Netlify deploy preview (PR 99); PR 88 (non-`main` base) and PR 100 (non-`main` base) showed no Netlify status or check. Netlify branch deploys on a plain push, GitHub webhooks and Apps, and AWS-side triggers outside the repository remain UNVERIFIED (settings not readable from here). Nothing in the repository calls AWS on push or pull request.

## 7. Release recommendation, procedure and deployment gates

See `OPERATOR_PROCEDURE_3159e52.md` (supersedes all earlier runbooks): pins, corrected statements, copyable commands with working directories and expected output, the migration-access wrapper, pinned recovery artifacts, database-only recovery, ComplianceSweep state, the Lambda-policy check and stop conditions.

**CONDITIONAL GO for a TEST-only deployment (synthetic data); not a production GO.** CI is green on the candidate. Remaining gates: the owner's authorization to push the operator commit; the owner's approval of the migration database-access method; operator, window and approval reference named; the ledger recheck, snapshot, assembly, live-template and Lambda-policy checks passing at run time.

## 10. Questions for the owner (asked once; none blocks the TEST deployment)

| # | Decision | Recommended answer | If chosen differently |
|---|---|---|---|
| 1 | Outbound notification channel, and whether PHI may be in messages | In-app only until a BAA-covered channel is approved; messages without client names | Needs a vendor/BAA decision and a new build |
| 2 | Late cancellation: payable, and by whom cancelled | Record the cancelling party first; defer payment to the payer contract | Payment rules coded from your answer |
| 3 | Definition of a missed visit | Scheduled shift ended with no visit and no cancellation after the review window | Metric stays "Not published" |
| 4 | Stricter payer deadlines | Keep 48 h / 24 h defaults; agencies may shorten | Supply the payer rule; it becomes a floor |
| 5 | Location/team filter | Not needed for the pilot | Requires a data-model change |
| 6 | Hours, Financial impact, Continuity, Outage cards on Home | Keep folded below the streams | Removal is a small change |
| 7 | Export access | Owner and manager only | Add roles by permission grant |
| 8 | Routine-item summaries (optional in decision 11) | Not needed | Needs a digest channel |
| 9 | Board 5 mobile mockup | Review the screenshots in the package | Comments become tickets |
