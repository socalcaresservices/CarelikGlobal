# Sidebar, Home and UX review: status and evidence

Updated 6 October 2026. **The full UX request is NOT complete.** Presentation only: no query, calculation, count, route, permission or business rule was changed.
Branch `claude/vibrant-sagan-rn9z58`. Not merged, not deployed. All screenshots use synthetic data and are in `docs/product/evidence/2026-10-06/ux/`.

## 1. Base branch and what AWS TEST runs

| Question | Finding | Basis |
| --- | --- | --- |
| Which commit powers AWS TEST? | **Cannot be verified from here.** No AWS access in this session. | The last deployment on record is release 0036 at `7b1236d` (database, API and web), owner-run and verified 14/14 on 2026-10-05 (`PILOT_ACCEPTANCE_RECORD.md`, `DEPLOYMENT_PLAN_0027_0036.md`). That is owner-reported, not live-checked. |
| Is `claude/ogevia-action-needed-filters` (a17eb7c) the right base? | **Yes.** | `7b1236d` is an ancestor. `main` is an ancestor. Every AWS pull request branch (#51, #52, #60 to #68: reporting, care requests, visit-to-shift, missed clock-out, manager close, remaining hours, Cognito) is an ancestor. Nothing newer exists on any branch (tip 2026-10-06 21:33). |
| What changed since the deployed commit? | Web only. | `git diff 7b1236d..a17eb7c`: no migration, no API handler; only the Action needed web code, Billing review filters, two database tests, deploy scripts and docs. The Action needed web code expects fields the deployed API already returns (0033). So the Action needed change and this restyle are **not deployed yet** and need only a web deploy. |
| What would this branch omit? | Eight open Supabase-path branches: #53 CareScore missing-data credit, #54 caregiver skills, #55 overnight availability, #56 month hours by source, #57 incident categories, #58 caregiver services and cities, #43 support access, plus `claude/serene-einstein-1rzi90` (audit docs). | `git cherry` finds none of their commits in the base. They change the Supabase app (`apps/web/src/pages`, `supabase/migrations`). **Whether AWS TEST needs any of them is UNKNOWN.** Owner decision. |

## 2. Completed

| Requirement | Evidence |
| --- | --- |
| Left sidebar 256px / 76px, remembered, drawer below 768px, tooltips, accessible names | Chromium at 1440, 1024, 390. Collapse persists across reload; Escape closes drawer and returns focus; Tab is trapped in the open drawer; tooltips dismiss with Escape. `sidebar-home.test.tsx`. |
| Groups TODAY / VISITS / BILLING / PEOPLE / SETUP; all existing links and permissions kept | Test lists every link and href for manager, Administrator and caregiver. |
| Reports and Client monthly calendar easy to find | Sidebar links to the existing reports route (`?view=overview`, `?view=calendar`); correct one is highlighted. Print / Save as PDF is now a visible button in the page header instead of inside "More actions". |
| Home layout, palette, fonts, 1180px | Screenshots `home-*`. Fonts are bundled npm packages; no font-host request (checked in the browser). |
| Financial split | Administrator sees dollar values; manager sees none (`home-manager-*-no-money.png`, test). Server returns null to managers. |
| Schedule actions | Record call-out, Change caregiver, Change time, Cancel shift and History are now 40px buttons; Cancel shift has a red outline (`page-schedule.png`, test). |
| Visit records actions | Correct visit, Review visit and Correction history are visible 40px buttons, stacked; the table has scroll shadows and is keyboard-scrollable. |
| Client authorisations | The Clients list now says "View authorized hours →" on each row. The client page's first card is Authorized hours (months, balances, versions). |
| Calendar and print | See section 5. |

## 3. Remaining UX work (needs your decision or a later change)

1. **Label changes in section 4**: proposed only; none applied.
2. **Visit records table at 1440px with the sidebar expanded**: the table is wider than the card. Status is visible; the Actions column is partly clipped until you scroll sideways (shadow shows it). Collapsing the sidebar fits it. Option: default-hide the three authorization columns (your change list item 4 asked for them under "Hours balance"). That changes defaults, so not done.
3. **Printed continuation pages** carry no agency, client or page number (section 5).
4. **Visit records, billing review: names wrap to three lines** in narrow columns.
5. **"Hours left" vs "Remaining"**: Home and Visit records say "Hours left"; the client page says "Remaining".
6. **Pages not walked in the browser**: caregiver screens, Care requests (needs unmocked endpoints), Care Team detail, Documents with data, Settings, Billing rounding. Their buttons were only checked in code.
7. **Calendar view shows the general "Filters" card** although the calendar ignores those filters (the page says so in small text).

## 4. Label proposals (for approval; "Action needed" kept)

| Where | Current | Proposed | Reason |
| --- | --- | --- | --- |
| Reports page title and Report dropdown (exceptions view) | Needs attention | **Action needed** | The header badge and Home say Action needed. Needs a test update (`aws-app.test.tsx` asserts the old heading). |
| Visit review, "Get the missing signature" text | "…instead of in Needs attention" | "…instead of in Action needed" | Same. |
| Report dropdown | Visit records (list) | Visit records | "(list)" adds nothing. |
| Report dropdown | Operations overview | Visits overview | "Operations" is vague. |
| Report dropdown | Monthly hours & billing reconciliation | Monthly reconciliation | Home already calls it that. |
| Home heading | Hours this month (utilization) | Hours this month | The definition sentence already explains utilization. |
| Home reminders | Reminders (not in the Action needed total) | Reminders (not counted) | Shorter. |
| Page title vs menu | Outage visit records / Outage records | Outage records | Match the menu. |
| Page title vs menu | Continuity pack / Continuity | Continuity pack (menu too) | Match. |
| Page title vs menu | Availability & opportunities / Availability | Availability | Match. |
| Schedule buttons | Repeat weekly, Recurring series | Repeat weekly, Manage repeating shifts | "Recurring series" is vague. |
| Visit review | Other actions | Correct or approve | Says what is there. |
| Client page | Remaining | Hours left | Consistency. |
| Visit records "By client and service" | "1 visits" | "1 visit" | Plural defect. |
| Spelling | Authorized (US) | Keep | Your messages use "Authorisations"; the product uses US spelling. Confirm. |
| Role name | Administrator | Keep, or Owner | The change list says OWNER VIEW; the product says ADMINISTRATOR VIEW. Confirm. |

## 5. Client monthly calendar: selection and print

Verified in Chromium print emulation and `page.pdf` (letter landscape), synthetic data:

| Check | Result |
| --- | --- |
| Print button disabled until a client is chosen | PASS |
| One client per calendar, services never combined | PASS (separate lines per service per day) |
| Totals | PASS. Recomputed by hand: worked 18 h 33 min (1,113 min), billable 18 h 30 min, Respite 13 h 3 min, Personal Assistance 5 h 30 min; caregiver A 14 h, B 4 h 33 min. The page shows the same and "agree to the minute". |
| Branding (screen and print) | Agency logo and name print on page 1. **Address, phone and email do not print: the AWS build has no source for them** (functional gap). |
| Sidebar, header and padding in print | Hidden (computed styles in print media). |
| Pages | Calendar alone: 1 page. With "Add a visit detail page", 84 visits: 4 pages; the table header repeats. |
| Continuation pages | **No agency, client, month or page number** on pages 3 and 4 (gap). |
| CSV | Button present; not exercised here. |
| Not verified | A real printer or the browser's own print dialog; other browsers. |

## 6. Navigation and highlighting

- The correct item is highlighted on Home, Visit records, Reports (`?view=overview`) and Client monthly calendar (`?view=calendar`); tested.
- **Gap (existing behaviour):** choosing a report in the Report dropdown does not change the address, so the highlight stays on "Visit records" (verified in Chromium).
- Reports opened from the Action needed link (`?view=exceptions`) highlight Visit records.

## 7. Does AWS TEST identify synthetic data?

- **Only partly.** The Clients page has a fixed sentence, "TEST environment: synthetic clients only until the security approval." It is hard-coded, so it would also show in a production build, and no other page shows anything.
- The sidebar chip appears only when the build sets `VITE_APP_ENV` to `test` or `development`. `/config.json` does not carry that key, so a deployed build shows it only if it was set at build time. **Unknown for AWS TEST.**
- Recommendation: drive one environment banner from deployed configuration. That is a configuration change, so it is not made here.

## 8. Functional gaps (not styling)

1. No standalone Authorisations route in the AWS build.
2. Printed letterhead has no address, phone or email in the AWS build.
3. Printed continuation pages lack identification and page numbers.
4. Hard-coded test sentence on Clients; no configuration-driven environment label.
5. Report dropdown does not update the URL (sidebar highlight lags).
6. No Ogevia logo image exists in the repository.
7. Eight Supabase-path branches are not in this base (relevance unknown).

## 9. Requirement checklist

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Preserve working system | Done; all pre-existing tests pass |
| 2 | Clearer titles and labels | **Proposed, awaiting approval** |
| 3 | Sidebar | Done |
| 4 | Home layout | Done (screenshot comparison pending your reference) |
| 5 | Reports, calendar, printing | Discoverability done; calendar verified; gaps in section 8 |
| 6 | Clear records and actions | Partly done (section 3) |
| 7 | Style | Done, with contrast deviation: zero and unavailable grey darkened to `#5C727B` |
| 8 | Verify and hand off | Partly: browser checks in sections 5 and 6; real print, screen readers and deployed build not verified |

## 10. Checks run

`pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` (results in the final report). Browser checks used a production build with faked Cognito and API responses.
