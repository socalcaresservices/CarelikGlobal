# Current review

PR #76 is the owner-selected release. The earlier #75-first dependency is superseded: do not merge competing readiness migrations from #75. See [DEPLOYMENT_AND_ROLLBACK.md](DEPLOYMENT_AND_ROLLBACK.md) and [TEST_REPORT.md](TEST_REPORT.md) for the current review and exact handoff. No deployment or live AWS changes. New real administrator screenshots are linked below; synthetic data, real UI/API/PostgreSQL 18, authentication stubbed.

- [Caregiver desktop](screenshots/administrator-caregiver-desktop.png) / [mobile](screenshots/administrator-caregiver-mobile.png)
- [Client desktop](screenshots/administrator-client-desktop.png) / [mobile](screenshots/administrator-client-mobile.png)

The original release notes below describe the baseline; current decisions and gaps are in [DECISIONS_AND_RISKS.md](DECISIONS_AND_RISKS.md).

# Unified caregiver-readiness release: release notes and status

Branch `feature/caregiver-readiness`, based on PR #75 head `111fc7c`. **Depends on PR #75 (not merged by this work).**
Owner brief: [BRIEF.md](BRIEF.md). **Status words are used strictly: proposed, implemented, tested, deployed.
Nothing in this release is deployed. No AWS resource was touched. No production deployment is authorised.**

## Status by requirement

| Brief | Implemented | Tested (what ran) | Deployed |
|---|---|---|---|
| C Sidebar Option B | Yes (was NOT already implemented; PR #75 only regrouped) | Style-contract unit tests; computed styles read from the real rendered page (below) | No |
| D Availability approval | Yes: DB 0039, API, caregiver + administrator screens | DB (15 tests incl. concurrency, DST, overnight, rollback), API, UI | No |
| E Caregiver service approvals | Yes: DB 0040, API, screens, review list, explicit bulk approval | DB (8), API, UI | No |
| F CPR / TB | Yes: DB 0041 (explicit agency rules, verified-and-current), status screens, setup | DB (8), UI | No |
| G Assignment safety | Yes: one gate (0042) on every commit path; care-request race fixed | DB (17 incl. race tests + path scan), API | No |
| H Enforcement transition | Yes: report-only default, report, audited activation, "Service checks" switch | DB, API, UI | No |
| I Explainable matching | Yes as **provisional** scoring; administrator experience, client preferences and ZIP forms completed in the PR #76 review | DB (12 arithmetic/gate tests), UI (panel) | No |
| J UX | Yes for availability, services, documents, readiness, assignment checks, matches | UI (29 tests), screenshots | No |
| K Delivery | This folder | See [TEST_REPORT.md](TEST_REPORT.md) | n/a |

## What changed for users
* **Availability** is a request. The caregiver sees approved hours (agency time zone, "Not provided" when none) apart from pending changes, and
  confirmation reads "Request sent. Your current hours stay in place until approved." (exact text in `SENT_MESSAGE`). Only an administrator
  approves or declines (decline needs a note). Direct administrator edits need a reason and are audited. A date override **replaces** that day.
  The old direct save (which wiped saved exceptions) is withdrawn.
* **Approved services** per caregiver and service with dates, reason, approver and revocation history; separate from client authorisation,
  assignments and employment. Existing pairs appear only on a review list (nothing preselected); bulk approval is explicit and count-confirmed.
* **CPR and TB** need an administrator-verified, current record covering the whole interval, under an explicit agency rule. No default period
  ships; unset rules are reported as "setup incomplete".
* **Every commit path is checked**, with separate Availability / Approved services / Documents / Conflicts results and exact messages.
* **Enforcement is not automatic**: every agency starts report-only. The administrator reviews the report and activates (audited).
  "Service checks" is a separate On/Off switch (default Off) that never disables CPR/TB or other checks.
* **Matches** are eligibility first, then an advisory, explained, provisional score ("Score incomplete" when inputs are missing).

## Files and commits
`git log --oneline 111fc7c..HEAD` is the authoritative list. Migrations `infra/aws/db/migrations/0039`-`0043` with classified rollbacks in
`.../rollback/`; API in `apps/sv-api/src/routes.ts` (38 routes, listed in `infra/aws/lib/service-verification-api-stack.ts`); screens in
`apps/web/src/aws/readiness/`; sidebar in `apps/web/src/aws/aws-shell.tsx`; shared permission keys in `packages/shared/src/permissions.ts`.

## Defects found and fixed along the way
* `replace_my_availability` deleted every saved exception when a caller sent none (verified in the old UI, which always sent an empty list).
* A date-specific window was **unioned** with weekly hours (widening availability). Now it replaces.
* Care Request assignment could double-book a caregiver under concurrency: the original function double-booked in **10 of 12** concurrent
  races (negative control, run against the original function); fixed by the shared per-caregiver lock; stable across repeated runs.
* My own first migration overwrote a CHECK constraint added by 0035 (caught by existing tests), and a no-change availability request was
  accepted (caught by looking at the real screenshots). Both fixed with tests.

## Screenshots
`screenshots/` (19 images, desktop 1280 and mobile 390): real UI against the real Lambda handler and a real local PostgreSQL, synthetic data,
real API routes used for all seeding. Only authentication is replaced (the harness hands the handler verified-claims for a synthetic user).
Computed styles read from the page: aside `#FAFBFC`, border `#E2E8EC`; headings 12px/700/letter-spacing 0.72px (0.06em)/line-height 18px/`#334155`,
divider `#DCE5E9`; link 14px/500/`#243244`, min-height 40px, radius 6px, icon 18px; selected `#E8F5F4` / `#0F6674` / 600. Contrast: selected text 5.92:1,
links 12.55:1, headings 9.99:1.
