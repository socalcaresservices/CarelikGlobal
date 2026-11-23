# Open Shifts board and automatic SMS (migration 0086)

Status: **implemented and tested locally. Not deployed. SMS is off and cannot send** (no transport is wired; the agency switch, entitlement and verified sender all default off). Brief: `BRIEF.md` (owner, 2026-11-22; Option A, first come, office approves).

## Baseline (verified from code, `main` 466f8ac, 2026-11-23)
- Migrations 0001-0085. Pickup *requests* already existed (0063: `shift_pickup_requests`, `confirm_shift_pickup`); the old board (0051/0063) showed client codes and required an assignment to the client and service.
- Existing notifications (`care_notifications`, `issue_notifications`) are in-app only: no outbound channel, retry, dedupe by round, or quota. A job table was therefore added; nothing was replaced.
- Not verified here: what is deployed in TEST or production.

## What changed
| Area | Change |
|---|---|
| DB 0086 (additive) | `shifts.public_ref / service_city / service_state`; `caregiver_coverage_cities`; `shift_coverage_rounds` (unposted/posted/closed, one open per shift); request statuses `invalidated`, `closed`; `notification_jobs` (unique per agency + purpose|round|recipient); per-agency `agency_open_shift_settings`, `agency_sms_usage`, `caregiver_sms_consent(+events)`, `office_notification_contacts`. |
| Transitions | Call-out (staff or self-service) now opens a new posted round on the same shift, keeps the reservation, queues the caller-out receipt and office notice. Client cancellation closes the round, releases per existing rules, texts the assigned caregiver. Fill, unpost, expiry and edits of date/time/city close or invalidate requests. Triggers run in the same transaction as the event. |
| Eligibility | One function (`coverage_blockers`) for list, count, request, recipient selection, dispatch and confirmation: city, readiness gate (holds, background, CPR/TB, availability, overlap, 8h/40h, service approval, client requirements), call-out exclusion. The legacy client-assignment gate is not required for board requests. |
| Office approval | `confirm_coverage_request`: earliest eligible pre-selected; choosing another needs a reason; order position and reason recorded; delegates to the existing locked confirmation (patched to skip the assignment gate for board requests only). |
| API | 20 routes (`/v1/open-shift-board*`, `/v1/coverage-*`, settings, contacts, cities, consent). Legacy `/v1/open-shifts` and `/pickup` routes remain for compatibility; the web no longer uses them. |
| Worker | `apps/sv-api/src/sms.ts`: sweep, claim, send, record. Mock transport only; AWS transport is written against an injected client (no new package). Task event `{ "ogevia-task": "coverage-sms" }`. |
| Web | Caregiver Open Shifts page and entry (count), request outcomes (Requested/Confirmed/Filled/Changed distinct), consent card; office Coverage queue; Open shifts and text settings (cities, contacts, limits). |

## Evidence (TEST, local PostgreSQL 16, synthetic data)
- `open-shifts-board.db.test.ts` 24 tests; `sv-api/test/open-shifts.db.test.ts` 8 tests; `web/src/aws/coverage.test.tsx` 5 tests. They cover acceptance 1-10 at database/API level, two-agency isolation, concurrent approvals, duplicate-worker claims, quota, late opt-out, unknown/transient outcomes, cancelled-after-queued, agency-local and overnight rendering.
- Existing suites updated only where they pin the migration range or legacy UI (rollback range, upgrade rehearsals, schema table list, nav lists, legacy open-shift UI tests, isolation sweep inputs).
- Failures that also occur on `main` without this change (not caused by it): `prd-rehearsal` (8), `prd-release-exec` (13), `prd-deploy-scripts` (2), `scheduling-patterns` (1), `recurring-rejections` (1), `operator-tarball` / `rehearsal-operator-scripts` (6), `calendar-authorised-hours` (1), CDK `custom-domains` (esbuild not on PATH here).
- Release-package pins (operator tarball and rehearsal scripts name migrations 0047-0085) were **not** regenerated: that is release packaging for the owner's go decision.
- NOT VERIFIED: real phone widths and mobile interaction, accessibility pass, deployed behavior, any AWS call, sender registration, real delivery receipts, segment counts of real messages beyond the unit estimate (the first text to a number adds "Reply STOP to opt out." and is about 2 segments; later ones about 1-2 depending on city and link).

## Migration and rollback
- Apply 0086 after 0085 (YELLOW: needs the owner's written approval; backup first). Backfills one settings row per agency; no existing row changes; no message is queued at activation (rounds are planned only when posted or called out *after* 0086; existing open shifts are not posted, so no historical batch).
- Rollback `0086_open_shifts_board_and_sms.down.sql` (BACKUP REQUIRED: drops the new tables and columns; restores 0063 confirmation and trigger). Tested in the range-rollback and upgrade rehearsals.

## Cost (estimates, not a quote; confirm on the AWS pricing page before provisioning)
Toll-free lease about $2/month per sending agency plus about $0.03 per segment. 100 texts about $5/month; the cancellation notices add roughly 60-80 texts. EventBridge and Lambda are far below any charge. The `CoverageSms` schedule is defined in the CDK stack **disabled**; deploying the stack is a separate YELLOW approval.

## Dependencies and owner decisions before any live text
1. Approve applying 0086 to TEST, then production.
2. Per agency: verified toll-free sender, opt-in evidence, message samples, public privacy and terms links; platform sets `sms_entitled`, `sender_status`, `sender_number`.
3. Approve adding `@aws-sdk/client-pinpoint-sms-voice-v2` and wiring the transport; enable the (already defined, disabled) 5-minute rule and set env `APP_ORIGIN`, `SMS_TRANSPORT`, optional `SMS_ALLOWLIST` for TEST.
4. Confirm defaults: 14-day window, urgent 48 h, escalation 24 h, quiet hours 9 PM-7 AM, office hours 8-18 (my default for the on-call rule), monthly limit 100 per agency, on-call routing, wording.
5. Confirm the first-message "Reply STOP" suffix against the provider's requirement.

## Added in the completion pass
Requirements matrix (`REQUIREMENTS_MATRIX.md`), office runbook, deployment and rollback sequence, audit on every transition, platform/environment emergency switches, urgent (48 h) alert and escalation (24 h), schedule-change notice, daily receipt reconciliation, 30-day report, recent-alerts panel with re-queue, audit view, schedule posting panel, CloudWatch metric filters and alarms, disabled `CoverageSms` schedule, load test (300 concurrent), populated-data rollback test, accessibility checks, and a 31-check real-browser run on the local harness (phone 390x844).

## Known limits (stated, not hidden)
- Office email alerts: the contact stores the email preference but no email is sent (no email transport exists).
- Client-cancellation alert to the office is the queue/audit only (per the brief table); no text.
- Per-shift service city defaults to the client's city and is snapshotted when posted; no separate service-location model exists. "Office" scoping of the queue follows `shifts.manage`; there is no office entity in the schema.
- Unfilled-near-start escalation texts exist only for shifts that have a coverage round; a never-posted needs-coverage shift shows Urgent / unfilled in the queue without a text.
- Assigned-shift change notices use the existing flow; not changed here.
- Planning is per round at most once: an opening that entered the window while SMS was off will never be texted after SMS is enabled (deliberate: no blast on reactivation).
