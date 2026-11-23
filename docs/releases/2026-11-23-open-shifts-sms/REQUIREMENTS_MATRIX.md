# Requirements matrix: Open Shifts board and automatic SMS (brief 2026-11-22)

Legend: ✅ implemented and tested here · ⚠️ implemented with a stated limit · 🔒 needs an external step (AWS, sender registration, credentials, owner approval) · ❌ missing (none remain).
Evidence names: **DB** = `infra/aws/db/test/open-shifts-board.db.test.ts`, **LOAD** = `open-shifts-load.db.test.ts`, **RB** = `open-shifts-rollback.db.test.ts`, **API** = `apps/sv-api/test/open-shifts.db.test.ts`, **SWEEP** = `tenant-isolation-sweep.db.test.ts`, **WEB** = `apps/web/src/aws/coverage.test.tsx`, **A11Y** = `open-shifts-a11y.test.tsx`, **E2E** = `infra/aws/local-harness/open-shifts-e2e.mjs` (real Chromium, phone 390x844, real API and PostgreSQL), **CDK** = `infra/aws/test/*stack*.test.ts`.

## 1. Product requirements
| Requirement | Status | Evidence / note |
|---|---|---|
| Open Shifts board, caregiver sees city, date, start, end, status only; opaque reference; no client name/id/code/address | ✅ | DB "board visibility", API "privacy", E2E E3 |
| Board pagination, sorted by start time; not limited to 14 days; replaces fixed 14-day filter | ✅ | `list_open_shift_board` (limit/offset, total); DB "20 days out" |
| Caregiver Home entry with requestable count; mobile; loading, empty, error states | ✅ | `OpenShiftsEntry` on My shifts and nav link; E2E E3; WEB/A11Y. (Caregivers have no separate "Home" page in this app; My shifts is their landing.) |
| Request more than one shift; pending does not reserve hours; Requested vs Confirmed visually distinct; withdraw | ✅ | DB, API, E2E E4/E6 |
| City-based matching on the shift's service city; canonical key distinguishes same-name cities; missing city suppresses exposure and texts, shows in queue | ✅ | DB "same name different states", "no city" |
| Agency-managed coverage cities per caregiver (no existing record to reuse) | ✅ | `caregiver_coverage_cities`, settings screen, E2E E1 |
| Never match on the managing office's address | ✅ | matching uses `shift_city()` only |
| Eligibility: active, same agency, city, service, client requirements, availability, compliance/readiness, overlap, 8h/40h, onboarding, holds; checked at list, count, request, SMS selection, send, confirm | ✅ | one function `coverage_blockers`; DB; LOAD |
| Backups who never served the client may request; genuine client restrictions preserved | ✅ | legacy assignment gate not required for board requests; readiness gate with client id still enforced (client requirements) |
| Caregiver call-out (self-service or staff) reposts the SAME shift; keeps reservation, authorization, former caregiver and reason; excludes the caller-out | ✅ | DB, E2E E7 |
| Other occurrences of a series keep their assignments | ✅ | call-out is per shift record |
| Staff Post for Coverage / Unpost; Needs Coverage is not auto-posted; preexisting unfilled shifts reviewable and postable, no historical blast | ✅ | Coverage queue lists them; rounds only created on post/call-out after 0086 |
| Edits do not trigger a second text; changed city/date/time invalidates waiting requests | ✅ | DB "editing a posted shift" |
| Client cancellation closes posting and requests, releases reservation by existing rules, stops unsent recruitment, texts the assigned caregiver | ✅ | DB, E2E E8 |
| Coverage rounds: new round on replacement call-out; prior round closed; previously contacted caregivers may be contacted once in the new round; excluded caller-out | ✅ | DB |
| Office approval (Option A): submission order by server sequence, earliest eligible pre-selected, next eligible moves up with reason, skip requires reason, order position and reason recorded, nothing auto-assigned | ✅ | DB, API, WEB, E2E E5 |
| Exactly one caregiver confirmed under concurrency; one reservation; competing requests resolved | ✅ | DB race, LOAD (3 racing approvals) |
| Office coverage queue: city, time, urgency, posting state, request count, delivery summary, escalation reason; zero requests vs pending distinguished | ✅ | `list_coverage_queue`, WEB |
| Shift details show assignment and posting independently, with what an action will do before submit | ✅ | `ShiftCoveragePanel`, call-out/cancel effect text; E2E E8 |
| Offices: scoping by assigned office | ⚠️ | schema has no office entity; scoping follows `shifts.manage` (agency-wide) |
| Existing client-cancellation action reused; staff distinguish caregiver call-out from client cancellation | ✅ | `cancel_shift` vs `record_shift_callout` |

## 2. SMS and notifications
| Requirement | Status | Evidence / note |
|---|---|---|
| Automatic opt-in SMS, no staff copy/send; 14-day alert window, entering the window sends once | ✅ | DB "20 days out"; API worker |
| Recheck live shift, eligibility, phone, consent just before send | ✅ | `sms_evaluate_job` |
| Opt-in with timestamp and source; opt-out; STOP handling attributed by sender number | ✅ | DB two agencies; E2E E9 |
| Provider-required opt-out wording | ⚠️🔒 | "Reply STOP to opt out." appended to the first message to a number; confirm against the provider's registration wording |
| Persist jobs transactionally with the event; one text per tenant, round, purpose, recipient; edits/retries/unpost-repost reuse the round | ✅ | unique key; DB; LOAD |
| Atomic claim, bounded retries for transient failures, ambiguous outcomes reconciled, never re-sent automatically | ✅ | `system_sms_claim` (skip locked), `system_sms_record`; API worker tests |
| Statuses queued/accepted/delivered/failed/suppressed/unknown; provider id, segments, cost recorded | ✅ | `notification_jobs`; receipts by sender number |
| Provider failure leaves the opening on the board | ✅ | API |
| Phone numbers masked in logs, API and UI; restricted tables | ✅ | masked everywhere; no reporting-role access; worker logs counts only (API test) |
| Quiet hours 9 PM–7 AM agency time, rechecked when delayed; bypass off by default | ✅ | DB |
| Monthly send limit enforced atomically, blocked sends counted and shown | ✅ | DB, report |
| SMS enable switch per agency; Open Shifts and SMS are separate capabilities; board works with SMS off or suspended | ✅ | settings; DB two agencies |
| Reactivation does not blast history | ✅ | rounds are planned once |
| Caregiver cancels in Ogevia / by phone: on-screen confirmation + one text to them; office alerted immediately for any date, on-call outside office hours | ✅ | DB, E2E E7 |
| Client cancels: assigned caregiver text and in-app; office queue alert | ✅ | text job; office sees it in "Recent call-outs, cancellations" |
| Approval: approved caregiver text + in-app; others in-app Filled, no text | ✅ | DB, E2E E6 |
| Unfilled near start: office urgent alert (48 h) and escalation (24 h), once per round | ✅ | DB |
| Assigned shift changed: caregiver notified (once per exact details) | ✅ | `schedule_change` job |
| Pending confirmation suppressed if assignment cancelled before dispatch | ✅ | `assignment_changed` suppression |
| Office contacts managed in Ogevia, per-contact text and/or email | ⚠️🔒 | text works; email is stored but not sent (no email transport exists; SES needs owner approval and domain verification) |
| Failed/blocked notifications shown in the office queue, never block the cancellation, posting or approval | ✅ | alerts panel, requeue; triggers run independently of delivery |
| One active escalation item per round | ✅ | one queue row per round; one alert per round |
| Alert wording per brief; agency display name; both dates for overnight; link resumes after sign-in | ✅ | `fmt_sms_when`; DB; E2E E4 (link) |
| Real AWS End User Messaging transport | 🔒 | coded against an injected client (tested with mapped errors); needs the AWS SDK package approval and wiring |

## 3. Tenancy, subscription, cost, audit
| Requirement | Status | Evidence |
|---|---|---|
| Per-agency settings, sender, consent, quota, templates name, usage | ✅ | tables keyed by organization; sender number unique to one agency |
| Same caregiver and phone at two agencies: separate sender, branding, consent, link, quota, callbacks | ✅ | DB two agencies |
| Tenant isolation on board, requests, jobs, callbacks, logs, exports; fail-closed foreign ids | ✅ | DB "foreign tenant ids" (every new function, both org ids), SWEEP (every route), API |
| Entitlement rechecked at send time; works without a paid plan | ✅ | `sms_entitled`; board independent |
| Meter outbound segments, inbound STOP, provider failures, number rental per agency/period; usage visible to admins | ✅ | `agency_sms_usage` (rental set by platform), report |
| Audit: posted, unposted, requested, withdrawn, approved, declined, filled (round closed), cancelled, called out, escalated, invalidated, requeued, settings, contacts, cities | ✅ | DB "audit logging"; audit screen |

## 4. TEST acceptance criteria (brief)
| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Winchester shift under a Temecula office visible to qualified Winchester caregivers incl. never-served backup; Temecula-only cannot list or request (direct API); other agency cannot access | ✅ | DB test 1; API privacy; E2E E3 |
| 2 | Request/withdraw; overlap, hours, hold, restriction, authorization block with message; change after request caught at approval | ✅ | DB "requests", "earliest fails recheck"; existing readiness suites |
| 3 | Saved unassigned shift off board until posted; call-out posts same record; client cancel closes and releases | ✅ | DB; E2E E2/E7/E8 |
| 4 | 20 days out posted now, one alert on entering window; filled/cancelled/unposted before dispatch sends nothing; agency-time boundaries and cross-midnight | ✅ | DB "alert window", "quiet hours" |
| 5 | Opted-out, unavailable, ineligible, called-out get zero recruitment texts; caller-out still gets own receipt; timeout/duplicate/repeat/edit no duplicates; late opt-out, missing city, limit, provider failure | ✅ | DB "who is texted", API worker |
| 6 | Simultaneous approvals → one assignment, no duplicate reservation; approved caregiver has normal access only; API/errors/logs/SMS omit client details | ✅ | DB, LOAD, API privacy, worker log test |
| 7 | Mobile home entry, count, empty state, request status, office queue; SMS link after sign-in lands on correct board with current state | ✅ | E2E E3/E4/E6 (emulated phone); WEB. Real devices: see blockers |
| 8 | Three eligible requests: earliest pre-selected; failed recheck moves next up with reason; skipped earliest recorded with reason | ✅ | DB, WEB, E2E E5 |
| 9 | Caregiver cancellation (self or staff) immediately confirms and alerts office incl. beyond 14 days and after hours (on-call); client cancel notifies assigned caregiver | ✅ | DB "cancellation alerts office… on-call", client_cancel |
| 10 | Approval: only approved caregiver texted, others Filled and zero texts; opted-out get in-app only; retries send no repeat | ✅ | DB |
| Additional | Replacement call-out fresh round; edits do not; duplicates do not repeat | ✅ | DB |
| Additional | Zero eligible, complete failure, 24-h escalation, overnight urgent, filled before delayed send | ✅ | DB |
| Additional | Changed requests, cancel after approval, stale links, full outcome wording, agency-local overnight dates | ✅ | DB, WEB, E2E |
| Additional | Two agencies sharing a caregiver/phone; suspend one, both boards work, other still sends | ✅ | DB |

## 5. Build sequence and activation safeguards
| Requirement | Status | Evidence |
|---|---|---|
| Inspect checkout, migrations, permissions, conventions; record baseline vs verified | ✅ | README "Baseline" |
| Additive tenant-scoped data and transitions first; locks; dedupe; reconcile unknown before retry | ✅ | 0086 |
| Board, queue, settings using existing navigation and permissions | ✅ | web |
| Mock transport for TEST; no bulk send on activation; fail-closed foreign tenant test; cancelled-after-queued test | ✅ | API, DB |
| Draft PR, rollback notes, operator walkthrough, cost assumptions, dependencies | ✅ | PR #122, this folder |
| Production activation: off by default, kill switches (agency, platform table, environment variable, disabled schedule), allowlist for TEST, worker fails closed without transport | ✅ | DB, API worker tests |

## 6. Go-live additions (beyond the brief)
| Item | Status | Evidence |
|---|---|---|
| Feature flag per agency (Open Shifts, SMS) | ✅ | `open_shifts_enabled`, `sms_enabled`, `sms_entitled` |
| CloudWatch alarms for failed/unknown jobs, missing receipts, unfilled urgent shifts | ✅ coded, 🔒 not deployed | CDK observability test (3 metric filters + 3 alarms) |
| Dead-letter handling | ⚠️ | no queue exists; jobs that cannot be sent stay in `failed`/`unknown` with reasons, are alarmed, shown to the office, and can be re-queued (unknown only with explicit confirmation). The scheduled invocation has no DLQ (an extra SQS resource; owner decision) |
| Daily reconciliation of delivery status | ✅ | `system_sms_reconcile` runs each sweep; flags accepted-without-receipt after 24 h once |
| Audit on every transition | ✅ | DB |
| Idempotency on all worker jobs | ✅ | dedupe key, claim token, concurrent-worker test |
| Cross-tenant security test | ✅ | DB, SWEEP |
| Load test, hundreds of concurrent requests | ✅ | LOAD: 300 concurrent requests in about 2 s, 200 board reads + 3 racing approvals |
| Mobile testing of caregiver workflow | ⚠️🔒 | automated in real Chromium with phone emulation; real-device test is a human step |
| Production runbook for office staff | ✅ | OFFICE_RUNBOOK.md |
| Emergency disable | ✅ | platform table, `SMS_EMERGENCY_DISABLE`, agency switch, disabled schedule |
| Dashboard/reporting: sent, failed, open, filled, escalations, quota | ✅ | `get_open_shift_report` and Coverage screen. No CloudWatch dashboard (the repo forbids paid monitoring) |
| Migration rollback tested before production | ✅ | RB (populated data), range rollback and upgrade rehearsals; to be repeated on TEST before production |
| End-to-end browser tests caregiver → office | ✅ | E2E, 31 checks |
| Monitoring of unfilled urgent shifts with alerts to office contacts | ✅ | urgent (48 h) text + alarm on `urgentUnfilled` |
| Rate limiting | ✅ | existing API stage throttle (20 rps, burst 50); idempotent request path; DB claim is bounded per run |
| Accessibility | ⚠️🔒 | structural checks (A11Y); no screen-reader or manual keyboard pass |
| Performance | ✅ | LOAD |
