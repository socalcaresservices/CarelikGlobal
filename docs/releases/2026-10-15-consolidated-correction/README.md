# Consolidated Application Correction — release candidate for owner acceptance

**Branch:** `claude/determined-goodall-syvv7s` (based on `origin/main` d82fefc, the Release 0052 commit)
**Date:** 2026-10-15 · **Environment:** development / test only · **Data:** synthetic only
**Status:** IMPLEMENTED and TESTED locally. **NOT deployed.** Not merged. No pull request opened. No AWS, Netlify or Supabase setting was changed.

This is one coordinated change set for the owner's request "OGEVIA — CONSOLIDATED APPLICATION CORRECTION": navigation, scheduling,
recruiting/onboarding, wired through the web app, API, database, permissions and audit log. It reuses the existing scheduling,
readiness and Care Team code; nothing was rebuilt.

## 1. What changed (one line each)

| Area | Change | Where |
|---|---|---|
| Navigation | Collapsible **right-side** menu. WORK: Clients, Caregivers, Scheduling, Approvals, Reports (related pages beneath each). SETUP pinned to the bottom. Colour per workflow area; amber/red badges from the same server summary as ACTION NEEDED. Mobile drawer opens from the right. | `apps/web/src/aws/aws-shell.tsx`, `nav-model.ts` |
| Scheduling | Repeat patterns: every week / every 2nd–4th week (with "start with this week or the next"), only or all-but the 1st–5th occurrence in the month ("every Saturday except the first"), excluded dates (holidays). Several caregivers per client (several series). Caregiver **hour limits** (agency default and per caregiver; *warn only* or *stop*), weekly load view, **make-up visits** for lost time. | migration `0053`, `apps/sv-api/src/routes.ts`, `recurring-schedule.tsx`, `scheduling-extras.tsx` |
| Recruiting / onboarding | Stages Applicant → Interview → Offer → Onboarding → Pending documents → **Approved** (stored as `ready`) → Active → Inactive. Checklist per caregiver (background check, training, CPR, TB, compliance clearance) with progress. Approval and assignment are blocked until complete; an expired item blocks new scheduling. Recruiting board shows exactly what is outstanding. | migration `0054`, `recruiting.tsx`, `care-team-page.tsx` |
| Wording | Status label "Ready to work" → **Approved** (database value unchanged). Page title "Schedule" → **Scheduling**; "Billing review" link → **Approvals**; "Repeat weekly" → "Repeat visits". | web only |

Screenshots (real browser, local harness, synthetic data): `screenshots/`.

## 2. Requirements recovery — requested vs approved vs implemented vs deployed

Evidence searched: this repository (code, migrations, `docs/`), the Release 0052 records, the earlier sessions of this working
session, the Supabase-build candidate-hiring documents, the PR list, and the "Ogevia Connected Demo" artifact.

| Requirement | Requested | Earlier owner approval found | Implemented here | Deployed |
|---|---|---|---|---|
| Right-side collapsible nav | 2026-10-15 | **None** (new request) | Yes | No |
| Labels Clients / Caregivers / Scheduling / Approvals / Reports | 2026-10-15 | **Conflicts** with an earlier owner position, "no wholesale renaming" | Yes, as requested now | No |
| Apple / Epic-style clean design | 2026-10-15 | Earlier: do not copy Apple/Epic visuals; keep own style | Own style, less clutter; no Apple/Epic assets or layout copied | No |
| Recurring / alternating / weekday / monthly patterns | 2026-10-15 | Weekly series approved and built earlier (0034/0035) | Extended (0053) | No |
| Different schedules for different weeks | 2026-10-15 | — | Yes: week A / week B as two series (tested) | No |
| Multiple caregivers for one client | 2026-10-15 | Partly existed | Yes (tested, same time allowed) | No |
| Daily / weekly hour limits | 2026-10-15 | **Proposed only** (8 h / 40 h, report-first); values never approved | Mechanism built; **no limit is set by default** | No |
| Cancel, reschedule | existing | Approved, built (0026/0034) | Unchanged | Pilot only for ≤0052 |
| Make-up visits in the authorization month | 2026-10-15 | — | Yes (cancelled / called out; see §5 for the shortfall path) | No |
| Partial visits | 2026-10-15 | Variance rule approved (0050) | Existing rule; make-up counts the unmade minutes | Pilot only for ≤0052 |
| Authorized/used/reserved/remaining, no double counting | 2026-10-15 | Approved (0049, 0052) | Unchanged and re-tested through make-ups and series | Pilot only for ≤0052 |
| Recruiting stages and onboarding checklist | 2026-10-15 | Earlier: candidates/applicants **not** on the launch path; exists only in the Supabase build | Built in the AWS build (internal tracking only) | No |
| Block assignment until onboarding is satisfied | 2026-10-15 | Readiness enforcement was approved as **report-only**; activation is a separate decision | Onboarding gate is enforced (new feature, owner-requested now) | No |

### Evidence I could not access
GitHub issues, review threads and PR discussion beyond the PR list; other Claude sessions' full transcripts beyond what this
session recovered; Google Drive / email; any production or pilot database; the live pilot application. Where a prior owner
decision could not be confirmed, it is listed in §6 instead of being assumed.

### Deployed state (VERIFIED from the release records, not from AWS)
Release 0052 (migrations 0037–0052 and the `Ogevia-prod-ServiceVerificationApi` stack) was approved for the pilot/test environment
only; the operator's `step7.log` / `step8.log` had not been received at the time of writing, so **whether 0052 is applied in the pilot is
NOT VERIFIED**. This branch adds migrations **0053 and 0054** on top; neither is approved or applied anywhere. Production is untouched.

## 3. Test report (this machine, local PostgreSQL 16, synthetic data)

| Suite | Result |
|---|---|
| `pnpm -r typecheck`, `pnpm -r lint` | pass |
| `pnpm -r test` (shared 118, auth 138, ui 73, sv-api 67, **web 801**, infra 134) | all pass |
| `pnpm build` | pass |
| Database suite `infra/aws` `test:db` (**577 tests**) | 575 pass, **2 fail** — both in `prd-deploy-scripts.db.test.ts` ("password authentication failed" for roles that script creates). Reproduced identically on the untouched base commit d82fefc, so they are environmental, not caused by this work. |
| API database suite `apps/sv-api` `test:db` (**78 tests**) | all pass |
| `harness:smoke` | 45 / 45 pass |
| Real-browser workflow run (Chromium against the local harness: real web build, real API handler, real database) | all steps pass, listed below |

New tests: `infra/aws/db/test/scheduling-patterns.db.test.ts` (8), `onboarding.db.test.ts` (8),
`apps/sv-api/test/scheduling-onboarding.db.test.ts` (3), `apps/web/src/aws/scheduling-patterns.test.tsx` (5), `recruiting.test.tsx` (4).
Existing tests that pinned the migration tail, table list, nav labels and "Ready to work" were updated.

Browser workflow run (synthetic data): approving a person with clearance outstanding is refused with the server's reason; recording
clearance completes the checklist; the person then moves to Approved and leaves the pipeline; another person's page lists exactly
what is outstanding; a pattern preview for "every Saturday except the first" omits the first Saturday of November; a make-up into the
next month is refused ("same calendar month") and a make-up in the same month is scheduled with 1 hr reserved and 2 hr still owed.
No horizontal scrolling at 1366 px or 390 px on the pages captured.

### Scenarios covered by automated tests
Recurrence exceptions (alternating weeks, nth / except-nth, excluded dates, malformed patterns); multiple caregivers and week A/B
sharing one authorization with the reservation total exact; hour limit report vs block, a series counted against its own earlier
dates, agency default vs caregiver override; make-up same month / longer than owed / second make-up / make-up of a make-up / other
agency; onboarding eligibility (stage moves, approval gate, assignment gate, documents from real records, clearance last, expiry
blocking shift and series but not an in-progress visit, waive/reopen rules, start-checklist once); permissions (caregiver refused,
other agency refused) and audit entries; rollback scripts and migration ledger.

## 4. How to see the working build

Everything below runs on **your computer**; nothing is deployed. From the repository root on this branch:

```bash
pnpm install --frozen-lockfile
pnpm --filter @carelik/infra-aws harness:setup   # local database + synthetic demo data (now includes the new scenarios)
pnpm --filter @carelik/infra-aws harness:build
pnpm --filter @carelik/infra-aws harness:serve   # https://localhost
```
Sign in as **Olivia Owner**. Seeded to try: Scheduling → *Manage repeating shifts* (a Saturday-except-first series, a week A/week B
pair for one client, two caregivers at the same time on Fridays), *Hours and limits*, a cancelled shift with *Schedule make-up*;
Caregivers → *Recruiting* (four people at different stages; Avery needs only compliance clearance). Details: `infra/aws/local-harness/README.md`.

Pushing this branch may make Netlify build a **branch deploy preview**. A preview is not production. Whether it is configured to reach any
backend (and so whether these features would work in it) is NOT VERIFIED; the local harness above is the verified way to see them.

## 5. Known gaps — what is NOT done

- **Visit types.** No separate "one-time / recurring / on-demand / hybrid" field. One-time = a single shift; recurring = a series;
  on-demand = care requests and open-shift pickup (existing); hybrid = a series plus extra shifts. They work, but are not labelled as types.
- **Monthly patterns** are limited to "the Nth (or all but the Nth) matching weekday of the month". Not built: "last Saturday",
  "the 15th of each month", "every N days".
- **Make-up after a short (partial) visit.** The database function supports it (owed = scheduled − worked), but only the cancelled /
  called-out path is covered by a test. **NOT VERIFIED** for a completed-short shift.
- **Hour limits** apply per shift, per day and per Monday–Sunday week of **scheduled** minutes; they do not read worked time or
  payroll overtime rules. No default limit is set (see §6).
- **Onboarding** stores status and dates only: no vendor background-check integration, no automatic expiry reminders for
  background check or training (existing document reminders cover documents only), no candidate self-service portal, interview
  scheduling or offer letters (the Supabase build's candidate module was not migrated). Requirement management exists in the API
  but has **no screen** yet.
- **Quick-add bypass.** *Add caregiver* can still create a person directly as Approved or Active (needed for existing staff), which
  skips the checklist. Existing caregivers are not on the checklist unless an administrator presses *Start the checklist*.
- **Navigation.** On a short screen the SETUP group is reached by scrolling the menu (a fade marks the edge). Not checked with a screen reader.
- Mobile checks were made at 390 px width in Chromium only; no physical device, no slow-network test.

## 6. Decisions needed from the owner

| # | Decision | Known | Unknown | Recommended | If chosen |
|---|---|---|---|---|---|
| 1 | Default hour limits | Mechanism is ready; nothing preset | Agency policy, overtime rules | 8 h/day, 40 h/week, **warn only** until a month of data is reviewed | Block mode later stops assignments over the limit |
| 2 | Keep the new nav labels and right-side placement | Conflicts with the earlier "no renaming" position | Whether staff accept right-side placement | Keep for the pilot, review after owner acceptance | Reverting is a web-only change |
| 3 | Put existing active caregivers on the onboarding checklist | Today they are unaffected | Their records (background check, training dates) | Do **not** bulk-enrol; enrol individually or on re-hire | Bulk enrolment would block scheduling for anyone missing a recorded item |
| 4 | Disable "add caregiver directly as Approved/Active" once recruiting is in use | It bypasses the checklist | Whether existing staff still need it | Restrict it to administrators after cut-over | Closes the bypass |
| 5 | Onboarding enforcement vs the report-only readiness rollout | Onboarding is enforced now; document checks remain report-only until the agency activates them | — | Approve the onboarding gate as built; it affects only people in the pipeline | Alternative: report-only, which breaks "block assignment" |

## 7. Migrations, rollback and API surface

- `0053_scheduling_patterns_hour_limits_makeup.sql` — new columns `shift_series.pattern`, `shifts.makeup_for_shift_id`; table
  `caregiver_hour_limits`; new/replaced functions; `hours` readiness check. Rollback `0053…down.sql` refuses while any pattern,
  limit, make-up or hour-limit skip exists (export first), otherwise restores the previous functions verbatim.
- `0054_recruiting_onboarding_checklist.sql` — four new stages, `caregiver_records.onboarding_required` (default false; no row
  changed), `onboarding_requirements`, `caregiver_onboarding_items`, the `onboarding` readiness check, the approval gate in
  `set_caregiver_status`, a before-insert gate on `caregiver_assignments`. Rollback `0054…down.sql` refuses while anyone is in a new
  stage or on the checklist or any item is recorded.
- New API routes (all behind the existing JWT authorizer; also added to the CDK route list): `GET/POST /v1/hour-limits`,
  `GET /v1/caregiver-load`, `POST /v1/shifts/{shiftId}/makeup`, `GET /v1/onboarding/overview`, `GET/POST /v1/onboarding/requirements`,
  `GET /v1/caregivers/{id}/onboarding`, `POST …/onboarding/start`, `POST …/onboarding/items`. Existing routes gained an optional
  `pattern` (series preview/create/change) and the extra caregiver statuses.
- Permissions: scheduling uses `shifts.manage`; onboarding uses `caregivers.manage` (write) and `caregivers.manage` or `readiness.read`
  (read). Every function checks the agency membership first; cross-agency calls are refused (tested).
- Privacy: onboarding stores a status, dates and a 200-character note with a warning not to enter results or personal details. No
  background-check report or identifier is stored.

## 8. Before any deployment (CLAUDE.md §0, `docs/TESTING_AND_RELEASE_PROCESS.md`)

Not done and not claimed: the release checklist, a CDK `diff`, pilot validation of 0053/0054, and the owner's explicit GO. This
branch assumes Release 0052 is applied first. Deploying it needs a new owner instruction naming migrations 0053–0054 and the API stack change.
