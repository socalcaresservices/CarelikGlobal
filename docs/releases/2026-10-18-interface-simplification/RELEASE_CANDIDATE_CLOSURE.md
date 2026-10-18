# Release candidate closure checklist (one list: five-board handoff, owner directives, 88-row matrix, known defects)

Branch `integration/compliance-attention-onto-scheduling-recruiting`. Code commit `5d836fa` plus documentation and screenshots in the final commit named in the review package. **Implemented and tested locally on synthetic data. Not pushed, merged, deployed, activated or run on TEST. No AWS call was made.** Later explicit owner decisions govern; White, Minimal and the simplified four-stream Home are preserved.

Evidence classes: VERIFIED = executed here this session (section 1). Rows below say "COMPLETE" only where code exists and a named test or browser check exercises it. Where the only proof is a real device, a person, TEST or an owner policy, the row says so and is not called complete.

## 1. Final test results (run on this commit, local Postgres 16, synthetic data)

| Gate | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | pass |
| Web (apps/web, jsdom) | 113 files, 1082 tests passed |
| sv-api unit | 3 files, 73 passed |
| sv-api against PostgreSQL | 13 files, 113 passed |
| infra static (CDK assertions, handler checks) | 13 files, 195 passed |
| Database suite (infra/aws, includes populated upgrade 0052 to 0076 and back, rollback chain, enforcement-enabled fixture) | 83 files, 828 passed |
| Browser, desktop 1280 px, freshly reset database | 102 / 102 checks |
| Browser, phone 390 px, freshly reset database | 102 / 102 checks |
| Unresolved failures | none known. `it.fails` F2 in authorization-accounting-risks.db.test intentionally pins the legacy sidebar-badge total mismatch (B4-D1 note) |

Not run (cannot be from here): real phone, screen reader, TEST, performance on realistic volume, scheduled compliance sweep.

## 2. Row-by-row closure (all 88)

Counts: {'Complete locally, no open item': 64, 'Superseded by owner decision': 1, 'Complete locally with a stated limit, decision or external/activation step': 18, 'External check only': 2, 'Open owner decision': 1, 'Deferred pending owner decision (not built)': 2}.

| ID | Closure status | Evidence / limit |
|---|---|---|
| B1-R1 | COMPLETE | Home order: refresh status, four streams, quick actions, top-issues panel, today's visits; home-closure.test, attention-severity.test |
| B1-R2 | SUPERSEDED | Owner decision 2026-10-17: simplified four-stream Home governs (README s16.1) |
| B1-R3 | COMPLETE | TodaysVisits highlights uncovered, held and credential-blocked shifts; home-closure.test |
| B1-R4 | COMPLETE | Three permission-aware quick actions; home-today.test |
| B1-R5 | COMPLETE | Authorization alert on Home links to affected clients; 0057 tiers; home-closure.test, authorization-tiers.db.test |
| B1-R6 | COMPLETE | TopIssues panel (Critical then Urgent, deadline, direct action, View all) fed by list_action_issues (0073); home-closure.test, action-issues.db.test |
| B1-R7 | COMPLETE | Refresh status + manual refresh; any successful write invalidates attention/overview/issues (tracked-api.ts); tracked-api.test |
| B1-R8 | COMPLETE LOCALLY; EXTERNAL CHECK | Desktop 1280 and phone 390 browser passes 102/102 each; real-device run still required (device script) |
| B1-R9 | COMPLETE | Optional sections (hours, finance) collapse, remembered per agency in the browser; mandatory alerts cannot be hidden; home-closure.test. A saved default-view setting beyond collapse is not built (consequence: none for the pilot) |
| B1-R10 | COMPLETE | Empty/loading/error states with Retry; curated error text; no false zero; home-closure.test |
| B1-R11 | COMPLETE | Role/permission-filtered Home; server permission checks; tenant tests (rls/tenant db tests) |
| B1-R12 | COMPLETE LOCALLY; EXTERNAL CHECK | Labels, severity names (not colour alone), touch targets tested in jsdom/browser; screen-reader run is an external check |
| B1-C1 | EXTERNAL CHECK | Performance needs measurement on TEST with realistic volume; bounded pages (limit/offset) are implemented |
| B1-C2 | COMPLETE | Partial/stale/failed sources reported, never shown as zero; home-closure.test |
| B1-C3 | COMPLETE | Server-side scope; actions go through audited source modules |
| B1-C4 | OWNER DECISION | Hours, Financial impact, Continuity and Outage cards remain below the new sections (folded by default option). Owner has not said remove or keep |
| B1-C5 | COMPLETE | One issue key <kind>:<reason>:<entity> shared by Home, Schedule, Action needed (0073); action-issues.db.test |
| B2-D1 | COMPLETE | Consolidated authorization summary; authorization-display.test |
| B2-D2 | COMPLETE | Tiers and 30-day expiry (0057) |
| B2-D3 | COMPLETE | Client page order: alerts, quick actions, authorization first, then visits, caregivers; client-closure.test; phone screenshot |
| B2-D4 | COMPLETE | Server-side reservation refuses over-authorization with shortage text |
| B2-D5 | COMPLETE | Versioned amendments with impact list (0066-0070); authorization-amendment tests |
| B2-D6 | COMPLETE | Alerts are open issues only; history kept as OBSERVED events (action_issue_events); action-issues.db.test |
| B2-D7 | COMPLETE | Each alert deep-links with client and issue context; client-closure.test |
| B2-D8 | COMPLETE | Schedule Visit, View Authorization, Verify Visit primary; others under More; client-closure.test |
| B2-D9 | COMPLETE | Compact caregiver summary (name, status, next visit); client-closure.test |
| B2-D10 | COMPLETE | Next three visits with full-schedule link; client-closure.test |
| B2-D11 | COMPLETE; OWNER DECISION on payment rules | Release of unused hours and linked same-month make-up implemented (0070/0072). Whether a late cancellation by the client or agency is payable is not decided; no payment rule is coded |
| B2-D12 | COMPLETE | Current authorization, expandable version history, audit; client-closure.test |
| B2-D13 | COMPLETE | Read-only details, focused edit, duplicate warning (find_possible_duplicate_clients), audit by field name only; client-readiness.db.test, client-closure.test |
| B2-D14 | COMPLETE | Document types, per-client versions, Missing/Pending Review/Approved/Expired/Rejected, private upload, review with no self-review (0074); client-readiness.db.test, client-documents.db.test |
| B2-D15 | COMPLETE | Draft/Pending preparation, service-specific requirements, activation refused unless ready; scheduling refused for clients in preparation or held service (trigger); client-readiness.db.test, final-enforcement.db.test |
| B2-D16 | COMPLETE WITH NOTED LIMIT | Expired authorization yields a derived expired state that blocks new scheduling and flags (never deletes) future shifts; manual service holds are stored. Lapse itself is not a stored hold row |
| B2-D17 | COMPLETE | Guided renewal in client page over the existing amend + impact flow; client-closure.test |
| B2-D18 | COMPLETE | Permissions, tenant isolation, audit (RLS and permission DB tests) |
| B2-D19 | COMPLETE LOCALLY; EXTERNAL CHECK | Authorization-first, alerts, mobile layout verified at 390 px; real device pending |
| B2-D20 | COMPLETE | Committed = billable + approved rounding + reserved; over-limit shown, not clamped |
| B3-R1 | COMPLETE | Day, Week (default), Month views; schedule-closure.test, browser |
| B3-R2 | COMPLETE | Overview strip: today, upcoming, uncovered, urgent; schedule-closure.test |
| B3-R3 | COMPLETE | Guided creation prefilled from client (?client, service, authorization); schedule-closure.test |
| B3-R4 | COMPLETE | Recurring series with end date and per-date exceptions |
| B3-R5 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | Filters by caregiver, client, service, status. Location/team filter not built: the data model has no location or team |
| B3-R6 | COMPLETE | Server-side reservation, concurrency-safe |
| B3-R7 | COMPLETE LOCALLY; ACTIVATION REQUIRED | Overlap is always refused; availability/readiness refusal applies only when the owner activates enforcement (enforcement-matrix.db.test, final-enforcement.db.test with enforcement enabled). Administrator availability override exists (0047) |
| B3-R8 | COMPLETE | Configurable daily/weekly limits (SoCal 8 h/40 h) |
| B3-R9 | COMPLETE LOCALLY; ACTIVATION REQUIRED | Credential gating and per-shift risk list built; the gate refuses new work only after the owner activates enforcement on TEST (one-way, after read-only preview). Enabled-enforcement fixture passes (final-enforcement.db.test) |
| B3-R10 | COMPLETE | Overlap detection |
| B3-R11 | COMPLETE | Cancellation releases unused hours, keeps delivered |
| B3-R12 | COMPLETE | Linked same-month make-up |
| B3-R13 | COMPLETE | Uncovered shifts prioritized |
| B3-R14 | COMPLETE | Replacement suggestions from the existing scoring rule via POST /v1/matching/candidates; reassignment history kept; replacement-model tests |
| B3-R15 | COMPLETE | display_state: cancelled, no_show, in_progress, verification_pending, in_review, partial, completed, missed, not_delivered, delivered_not_verified, awaiting_record, covered, needs_coverage (0075); shift-display-states.db.test |
| B3-R16 | DEFERRED - OWNER DECISION | Notifications need a channel and a PHI-handling decision (CLAUDE.md: email tooling is non-PHI only). In-app issue queues exist; no push/email/SMS built. Consequence: staff must open the app to see items |
| B3-R17 | COMPLETE | Scheduling changes audited |
| B3-R18 | COMPLETE LOCALLY; EXTERNAL CHECK | Phone pass 102/102; real device pending |
| B3-E1 | COMPLETE | No override of hard limits |
| B3-E2 | COMPLETE | Valid dates saved, rejected dates listed with reason |
| B3-E3 | COMPLETE | Suggestions plus administrator confirmation and history |
| B3-E4 | COMPLETE; OWNER DECISION on payment rules | Verified hours kept, unused released, timing recorded. Late-cancellation payment rule/cancelling party not decided |
| B3-E5 | COMPLETE | No carryover without authorization allowance |
| B3-E6 | COMPLETE | Ranked eligible caregivers for urgent coverage; administrator confirms; no automatic assignment |
| B4-D1 | COMPLETE WITH NOTED LIMIT | list_action_issues returns server counts and limit/offset pages (0073). The legacy sidebar-badge summary get_attention_summary is separate and the it.fails F2 in authorization-accounting-risks.db.test still pins its known total mismatch |
| B4-D2 | COMPLETE | Pending Confirmation separate until overdue |
| B4-D3 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | 48 h default, agency may set shorter (attention_rule_hours). Stricter payer/regulatory deadlines unspecified |
| B4-D4 | COMPLETE | Administrator review immediate; Urgent after 24 h (agency may shorten) |
| B4-D5 | COMPLETE WITH NOTED LIMIT | Risk-based review; 'blocks required work' is approximated as a caregiver flagged on an upcoming shift |
| B4-D6 | COMPLETE WITH NOTED LIMIT; OWNER DECISION | 48 h default, shorter allowed; payer-specific rules unspecified |
| B4-D7 | COMPLETE | Critical/Urgent/Routine ordering and filters by category, client, caregiver, service; action-needed-page.test, action-issues.db.test |
| B4-D8 | COMPLETE WITH NOTED LIMIT | Tiers reclassify on read (not as a stored transition) |
| B4-D9 | COMPLETE | Reason, urgency, deadline, recommended action, prefilled link; action-needed-page.test |
| B4-D10 | COMPLETE | Stable issue identity and history across Home, Schedule, Action needed |
| B4-D11 | DEFERRED - OWNER DECISION | Same as B3-R16 |
| B4-D12 | COMPLETE LOCALLY; EXTERNAL CHECK | Compact action cards at 390 px; real device pending |
| B4-D13 | COMPLETE | Server permissions, tenant isolation, audit history |
| B5-R1 | COMPLETE | Reporting & billing hub page with the five sections; reporting-closure.test |
| B5-R2 | COMPLETE | Human billing approval; Already Billed/G11 stays deferred |
| B5-R3 | COMPLETE | Billing states and words |
| B5-R4 | COMPLETE | Pending signatures stay in the reminder workflow |
| B5-R5 | COMPLETE | Worked/verified/billable/reserved distinguished |
| B5-R6 | COMPLETE (by rule) | Missed-visits metric intentionally not published (null + "Not published"); definition needs owner |
| B5-R7 | COMPLETE | Unresolved balances and rounding shown as dependencies |
| B5-R8 | COMPLETE | Server-generated exports, role-limited figures, audit |
| B5-R9 | EXTERNAL CHECK | Owner review of the mobile mockup is outside code |
| B5-R10 | COMPLETE | Billing Readiness section |
| B5-R11 | COMPLETE | Authorized vs Delivered section |
| B5-R12 | COMPLETE WITH NOTED LIMIT | get_agency_performance (0076): uncovered shifts, cancellations, utilization; missed visits not published; agency-performance-audit.db.test |
| B5-R13 | COMPLETE | Billing-review CSV added (0076); exports capped at 4 MB; reporting-closure tests |
| B5-R14 | COMPLETE | Owner-only audit report with field names only, no values (0076); agency-performance-audit.db.test |

## 3. Proposed deferrals and their consequences

None of these is silently dropped. Each is either a business policy the owner has not set, an external dependency, or an item that cannot be finished in code.

| Item | Why it is not finished | Consequence if left as is |
|---|---|---|
| B3-R16 / B4-D11 notifications | The channel (email, SMS, push) and whether PHI may travel through it are undecided. CLAUDE.md allows email tooling for non-PHI only. | People see issues only when they open Ogevia (Home, Action needed). No message is ever sent. Nothing is duplicated or lost. |
| B2-D11 / B3-E4 late-cancellation payment | Who cancelled and whether the visit is payable are payer/policy rules. | Hours are released and delivered hours kept exactly as built; no payment or penalty is calculated. |
| B3-R5 location/team filter | There is no location or team in the data model; adding it is a schema and product decision. | Schedule filters are caregiver, client, service, status. |
| B4-D3 / B4-D6 payer or regulatory deadlines | No payer/regulatory deadline has been supplied. | Defaults are 48 h (confirmation, document review) and 24 h (review); an agency may only set them shorter. |
| B1-C4 extra Home cards | Owner has not said whether Hours, Financial impact, Continuity and Outage cards stay. | They remain below the four streams; hours and finance can be folded. |
| B5-R6 / B5-R12 missed visits | The definition is undecided; Board 5 rule 6 forbids publishing an undefined metric. | Report shows "Not published". The schedule's per-shift "Missed" state is separate and unaffected. |
| Export access | Owner and manager only (scheduler lost export in 0069). Pending final confirmation, as instructed. | Unchanged until confirmed. |
| Authorization decrease rule | Existing behaviour: worked service preserved, impacts flagged for human review, no history rewritten. Awaiting owner confirmation of that rule. | Unchanged. |
| B2-D16 lapse as stored hold | Expired state is derived at read time; only manual holds are stored. | Behaviour is identical for scheduling; there is no "lapse" row in the hold history. |
| G11 / Already Billed | Deferred by instruction. | Not built. |
| B5-R9 mobile mockup review | Owner visual review. | No code effect. |

## 4. External checks (cannot be completed locally)

| Check | Needs |
|---|---|
| Real phone and tablet run (B1-R8, B2-D19, B3-R18, B4-D12) | A person with a device; script in section 7 |
| Screen reader (B1-R12) | A person with VoiceOver/TalkBack/NVDA |
| Performance measurement (B1-C1) | TEST with realistic volume |
| Compliance sweep on a schedule (B3-R7, B3-R9) | EventBridge `ComplianceSweep` deployed to TEST (CDK change prepared, not deployed) |
| Enforcement activation (B3-R7, B3-R9) | Owner action on TEST after the read-only preview |
| Everything on TEST/AWS | Written owner approval (yellow actions, CLAUDE.md section 13). No AWS call was made in this work. |

## 5. TEST deployment, activation, smoke test and recovery runbook

**Status: PROPOSED. Nothing has been run on TEST. All steps below are yellow actions; none is executed without the owner's explicit GO and the release checklist (`docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`).**

Starting point: the TEST database at migration 0052 (baseline) with the previous API/web build. Target: migration 0076, this commit's API and web build.

### 5.1 Before anything

1. Confirm the TEST database is at 0052: `OGEVIA_DATABASE_URL=<test, read-only> pnpm --filter @carelik/infra-aws db:verify` (read-only transaction). Stop if the version is not 0052/52.
2. Take and record a snapshot of the TEST RDS instance. Required: migrations 0055, 0056, 0060, 0063, 0064, 0067, 0068, 0069, 0071, 0072, 0073 and 0074 have BACKUP REQUIRED rollbacks.
3. Check out the exact release commit, run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, and `pnpm --filter @carelik/infra-aws synth`.
4. Run `cdk diff` (read-only) and confirm the only API-stack changes are the new routes (action-issues, attention-settings, client documents/readiness/holds/audit/duplicates, agency-performance and audit reports) and the `ComplianceSweep` rule.
5. Follow `TEMP_DB_ACCESS_PROCEDURE.md` for temporary database access.

### 5.2 Deploy

1. Apply migrations 0053 to 0076 in order with the repository runner, against TEST only, with the owner approval variable set for that run: `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner OGEVIA_DATABASE_URL=<test> pnpm --filter @carelik/infra-aws db:migrate`. Migrations contain no BEGIN/COMMIT; the runner wraps each.
2. `db:verify` must report schema version 0076/76.
3. `cdk deploy` the API stack (new routes plus `ComplianceSweep`); then publish the web build to the TEST host.
4. Do not activate enforcement yet.

### 5.3 Smoke test (about 20 minutes, synthetic or TEST-only data)

| # | Action | Expected |
|---|---|---|
| 1 | Sign in as owner. Home loads with four streams, top-issues panel, refresh status | No false zeros; last-updated shown |
| 2 | Open Action needed | Counts per queue; open an item and land on its page with context |
| 3 | Open a client: documents card, readiness, authorization first | Missing document listed; activation refused until requirements met |
| 4 | Upload a document (synthetic file), approve as a second user | Status Approved; the uploader cannot approve their own |
| 5 | Schedule a visit beyond remaining authorization | Refused with the shortage reason |
| 6 | Schedule in week view; switch Day/Month; filter by caregiver | Same shifts in each view |
| 7 | Cancel a shift; make-up linked | Hours released; delivered hours kept |
| 8 | Open Reporting & billing; export billing review as owner; as scheduler | Owner downloads CSV; scheduler is refused |
| 9 | Owner audit report | Field names only, no values |
| 10 | Caregiver login on a phone: start and end a visit | Server times; locked after confirmation |

### 5.4 Enforcement activation (separate GO; one-way)

Follow `ACTIVATION_CHECKLIST_SOCAL_CARE_SERVICES.md`: run `infra/aws/db/preview/enforcement_activation_preview.sql` read-only, owner reviews sections B to H, then one `activate_readiness_enforcement` call with the matching expected count. Do not do this in the same window as the deploy.

### 5.5 Recovery

| Situation | Action |
|---|---|
| A route or the web build misbehaves, schema fine | Redeploy the previous API stack and web build (the new migrations are additive; old API works against them). |
| A migration fails | The runner stops at the failing file; fix forward or restore the snapshot. Do not edit applied migrations. |
| Need to return the schema to 0052 | Restore the snapshot (preferred), or apply `db/rollback/0076...0053*.down.sql` in reverse order with `psql -v ON_ERROR_STOP=1 --single-transaction -f <file>` per file. Rehearsed on a populated local database by `upgrade-0052-to-final.db.test.ts` (data preserved, applied again). BACKUP REQUIRED files drop their own tables' history. |
| Enforcement activated and wrong | It is one-way by design; use the Caregiver holds page to resolve holds individually, or restore the snapshot. |
| Export stuck or too large | Exports are capped at 4 MB; narrow the filter. Ledger rows are append-only. |

Known behavioural note for rollback: the export ledger's list of report keys stays widened after rolling back 0076, because the ledger is append-only.

## 6. Verification evidence for the whole candidate

See section 1 for command results. Areas and where each is exercised:

| Area | Evidence |
|---|---|
| Accounting, buckets, reconciliation races | authorization-accounting, reservation-buckets, reconciliation DB tests |
| Authorization amendments and impacts | authorization-amendment DB tests, upgrade test |
| Recurring shifts, scheduling limits | scheduling-rules.db.test (sv-api), work-hour DB tests |
| Administrator-confirmed pickup | pickup DB/API tests |
| Compliance holds, enforcement enabled | final-enforcement.db.test (synthetic, enforcement on) |
| Billing states, exports | billing-state and export DB tests; reporting-closure (sv-api, web) |
| Permissions, tenant isolation | tenant/RLS DB tests; sv-api route permission tests |
| Retries / idempotency | idempotency DB and API tests |
| Audit history | audit assertions in each DB suite; agency-performance-audit.db.test |
| Populated upgrade 0052 to 0076 and back | upgrade-0052-to-final.db.test |
| Browser | Desktop 1280 and phone 390, independently reset databases |

## 7. Short real-device test script (phone, 10 minutes)

Use the TEST site with a synthetic caregiver account and a synthetic office account on a second device or browser.

1. Caregiver: sign in. Check no sideways scrolling and the main button is visible.
2. Start a visit. Lock the screen for one minute, reopen. The timer is still correct.
3. Turn on airplane mode, tap End visit, turn it off, retry. One visit, one end time.
4. Confirm with a drawn signature using your finger. The visit shows locked.
5. Office on phone: open Home. The four streams and top issues fit without sideways scrolling.
6. Open Action needed, tap an item, return with the back button.
7. Open a client: authorization is the first card; the document upload button works with the phone camera/file picker.
8. Open Schedule: switch Day, Week, Month; open the Filters button; the keyboard does not hide the Apply control.
9. Rotate to landscape and back. Nothing is cut off.
10. Write down anything that looks wrong with the screen name. Do not include real client names.

## 8. Questions for the owner (asked once)

| # | Decision | Recommended answer | If chosen differently |
|---|---|---|---|
| 1 | Notification channel and whether PHI may be in messages | In-app only until a BAA-covered channel is approved; messages carry no client names | Needs a vendor/BAA decision and new build |
| 2 | Late cancellation: payable? by whom cancelled? | Record cancelling party first; defer payment rule to payer contract | Payment rules would be coded from your answer |
| 3 | Definition of a missed visit | Scheduled shift ended with no visit and no cancellation, after review window | Metric stays "Not published" |
| 4 | Stricter payer deadlines | Keep 48 h defaults; agency may shorten | Provide payer rule and it is added as a floor |
| 5 | Location/team filter | Not needed for pilot | Requires adding location/team to the data model |
| 6 | Extra Home cards (Hours, Financial impact, Continuity, Outage) | Keep folded below streams for pilot | Removing them is a small UI change |
| 7 | Export access | Owner and manager only | Add roles by permission grant |
| 8 | Authorization decrease rule | Keep: preserve worked service, flag for human review | Different rule needs payer guidance |
| 9 | B5-R9 mobile mockup | Review screenshots in the package | Comments become tickets |
