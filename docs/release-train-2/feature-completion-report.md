# Release Train 2 — Feature completion report

Branch `feature-completion-phase-2` (from `main` 698ae23b, the merge of PR #123). **Implemented and tested locally; nothing deployed, nothing applied to any AWS environment, not merged.** Every new capability is behind a release switch that is OFF in TEST and production (CDK tests assert the exact route sets and that the synthesized production template is unchanged when the switches are off).

Status words: IMPLEMENTED + TESTED = code and automated tests pass locally; NOT VERIFIED = needs a real environment (TEST) or real device/inbox.

## Summary by priority
| Pri | Objective | Status |
|---|---|---|
| A | Cover-shift notifications (in-app, SES email, preferences, history, delivery audit, retry, flag) | IMPLEMENTED + TESTED. SES delivery NOT VERIFIED (no verified identity yet) |
| A | Notification centre (unread counts, archive, filter, preferences, bell + nav integration) | IMPLEMENTED + TESTED |
| B | Branded invitations: Cognito custom-message trigger, invitation + resend + password reset templates, office branding, logo support, previews, flag | IMPLEMENTED + TESTED. Live Cognito behavior NOT VERIFIED |
| C | Bulk import: CSV + XLSX, validation, dry run, error report, audit history, rollback, flag | IMPLEMENTED + TESTED. TEST run NOT VERIFIED |
| D | Duplicate staff merge: conflict review, wizard, audit, guarded undo, history, flag | IMPLEMENTED + TESTED. TEST run NOT VERIFIED |
| E | Remaining sorting (tables and legacy pages) | DONE for every list table; named exceptions below |
| — | Operations readiness (authorization expiry, document expiry, open shifts, compliance) | IMPLEMENTED + TESTED (behind its own switch) |
| — | Dependencies and security | Production dependency advisories **0**; dev-only advisories remain (below) |

## What was built
### A. Notifications (migration 0113; routes behind `notifications`; email Lambda + 5-minute schedule only when configured)
- **Recipients (one rule, reusing existing checks):** active, linked caregivers assigned to the shift's client and service, not the caregiver who called out, who pass the same `check_shift_caregiver` gate the office uses (status, overlaps, readiness, hour limits). Nothing is assigned: a caregiver still asks and the office confirms. Defaults per agency (all OFF): enabled, email, auto-notify, window 48 h, at most 25 recipients; the agency owner changes them with a reason (audited).
- **Content:** title "A shift needs cover" and service, local date and time. **Never a client name or code** (tested). Link back to Schedule.
- **Preferences:** per person, in-app and email (cover shift). Both off = told nothing (the page warns).
- **Notification centre:** `/notifications` (list, Inbox/Unread/Archived/All, type filter, unread count, mark read, mark all, archive/restore), bell link with unread count, caregiver nav item under My Work, staff nav item under Dashboard. History is kept: a notification can only be marked read or archived; never deleted.
- **Email path:** outbox table with statuses queued → sending → sent / retry / failed / skipped; one non-VPC Lambda (no database, S3, KMS or secrets) with `ses:SendEmail` on one verified identity; API Lambda reaches it through the existing Lambda VPC endpoint (no NAT). **Retry:** up to 5 attempts, delays 5, 15, 45, 135 minutes; a crashed claim is re-offered after 10 minutes (at-least-once, never silently lost); a person without an address is "skipped". The address is resolved server-side at send time only and never logged. Delivery audit: append-only per-attempt events plus an audit event on final failure (counts and codes only).
- **Office view:** "What was sent" (sortable) by caregiver code: in-app read state, email status, attempts, error code. "Notify caregivers" on any future shift needing cover (shift menu), idempotent per shift.
### B. Branded invitations (migration 0114; routes behind `invitationBranding`; Cognito trigger only when `auth.invitationEmail` is set)
- **Cognito custom-message trigger** (pure function, no VPC/DB/secrets, 3 s, **fails open** to Cognito's message): invitation (first send and resend) and password reset; keeps Cognito's `{username}`/`{####}` placeholders exactly once; validates and escapes every brand value.
- **Office branding:** per office accent colour, https logo address, help address (Administrator only, audited); the API passes the caregiver's **primary office** look to Cognito as ClientMetadata. Without a look: company look from CDK config.
- **Previews** in Settings → Offices (invitation and password reset, sandboxed iframe, sample values, nothing sent) from the same renderer the trigger uses.
### C. Bulk import (migration 0115; routes behind `importRollback`; import itself behind the existing `bulkImport`)
- **XLSX:** defensive reader (first worksheet only; cells never evaluated; zip-bomb refused before inflating from declared sizes; ≤ 60 parts, ≤ 8 MB inflated, ≤ 2,000 rows, ≤ 40 columns); `fflate` 0.8.3 (the 0.8.2 `unzipSync` infinite-loop advisory is fixed in 0.8.3). Same mapping, validation and duplicate rules as CSV.
- **Dry run** = "Check the file" (nothing created). **Error report:** row messages on screen plus a CSV of problem rows (row number, status, message only). **History:** who, when, file, counts. **Rollback:** one import at a time, all-or-nothing, only while every created record is untouched; records become Inactive through the existing functions (nothing deleted); reason and audit kept; a repeat is a no-op. Imports made before 0115 cannot be rolled back (listed as such).
### D. Duplicate staff merge hardening (migration 0116; routes behind the existing `staffDuplicates`)
- **Wizard** per extra record: both records side by side; **conflicts** (both filled, different) need an explicit choice per field; blanks on the kept record are filled; reason; confirm. Before/after of both records stored (append-only snapshot) in the same transaction.
- **Rollback protection:** Undo only while the kept record is exactly as the merge left it and the merged record is still an inactive record with no sign-in or invitation; otherwise refused with the reason. Reversal recorded (append-only); the same pair can be merged again. History list with "can be undone now". Old 0106 entry point delegates to the same code path; the route's `result` stays the state string (link id added).
### E. Sorting, operations readiness, dependencies
- **Sorting added** (shared `SortTh`): Care Team (legacy), Organizations, Platform plans, Settings key list, Billing (ready-to-bill and approved), plus every new table. With the earlier phase, every list table in the app sorts.
  **Not sorted, on purpose:** two-row record comparison (merge wizard), single-record sub-lists on candidate and care-team detail pages (a handful of rows inside a record), the calendar grid summary, the chart's screen-reader table. (INFERRED: the `pages/*` legacy tree is not served by the AWS build; sorted anyway as requested.)
- **Operations readiness** (`/operations-readiness`, behind `operationsReadiness`, no migration): one route composes the existing attention overview, expiring-authorization hours and compliance summary, each under its own permission; a part the caller may not see is named "Not available to your role", never zero; a caregiver gets 403. Tables sort; every section links to the page that owns it.
- **Dependencies:** `pnpm audit --prod` = **0** (fflate 0.8.3; earlier react-router/zod/qs fixes). Dev tooling: vitest 3.2.7 (was 2.1.9; test config unchanged) and overrides for vite, browserslist, js-yaml, nanoid, postcss, source-map-js, brace-expansion. Total advisories 53 → 24 (2 critical, 11 high, 11 moderate), all dev-only: `tinypool` inside vitest (critical; fix needs vitest 4+, not available on the registry line we can resolve), `@vitest/mocker`, and the legacy Netlify packager (`toml`, `extract-zip`, `glob`, `minimatch`, `@fastify/busboy`, `zod` inside it). Not deployed code.

## Verification (local PostgreSQL 16, synthetic data)
| Gate | Result |
|---|---|
| `pnpm run lint --force`, `typecheck --force`, `build --force` | 6/6, 7/7, 6/6 tasks successful |
| `pnpm test:all` (unit, infra database, sv-api database) | **PASS — all suites ran, none skipped** (infra database suite included the four new migrations; sv-api database suite 200 tests) |
| Infra unit suite | 69 files / 920 tests |
| Web suite | 160 files / 1,444 tests |
| New tests | database: notifications 16, office branding 4, import rollback 7, staff merge 10; API: notifications 6, email handler 3, custom message 9, XLSX 6 (+ import-file updates), operations readiness 3; CDK: notifications/branding/rollback/readiness switches 8, invitation email 8; web: notification centre 9, invitation look 3, import drawer +3, staff duplicates +5, operations readiness 5, care-team sorting +1, hours sorting 1 |
| Existing sweeps | extended (tenant isolation and role sweeps now include the new routes: a caregiver's only new writes are her own notification centre and preferences; a scheduler's are those plus "Notify caregivers") |
Fixes found by the gates: sweeps needed values for the new routes; the merge route's `result` had changed shape (restored); CDK tests timed out at the default 5 s under load (60 s limit added); the release-pin guard re-pinned twice (expected).

## Not verified / limits (be explicit)
- **No TEST run of any feature.** No real SES send, no real inbox, no live Cognito trigger, no real phone or email-client rendering of the branded templates (a Chromium file check was done for the earlier renderer only).
- The TEST Cognito pool is not CDK-managed: the branded template can only be tried there by a hand change, then production.
- Notifications use a recipient rule I chose from the earlier recommendation (eligible, assigned caregivers); the owner has not confirmed it. SMS is not built.
- Logo must be a public https address the agency hosts (no upload; the evidence bucket stays private).
- XLSX: first sheet only; no XLSX template download (CSV template only).
- Merge does not move related records because a staff profile has none (INFERRED from the schema); caregivers are resolved in Care Team, never here.
- Ops readiness depends on the existing functions' permission rules; it adds no new data.
- Migrations 0113–0116 are **pending** (not in any ledger). Applying them is a production change needing the owner's approval and a snapshot (see `deployment-plan.md`).
