# Sidebar, Home and UX review: status and evidence

Updated 6 October 2026 (second round). **The full UX request is not marked complete** (see section 6). Presentation only: no query, calculation, count, route, permission or business rule was changed. Branch `claude/vibrant-sagan-rn9z58`. Not merged, not deployed. Screenshots (synthetic data) are in `docs/product/evidence/2026-10-06/ux/`.

Related documents: `OMITTED_BRANCHES_COMPARISON.md` (the eight omitted branches), `PROPOSAL_LETTERHEAD_AND_ENV_MARKER.md` (two separate fixes, proposals only).

## 1. Base branch and deployed commit

- **The deployed commit is still unverified.** This session has no AWS access. The last deployment on record is release 0036 at `7b1236d` (database, API, web), reported by the owner as verified 14/14 on 2026-10-05.
- **Git history supports the base choice.** `claude/ogevia-action-needed-filters` contains `7b1236d`, `main` and every AWS pull request branch, and no branch is newer. Since `7b1236d` the base differs only in web code, tests, scripts and docs (no migration, no API handler), so the Action needed change and this restyle need a web deploy only.
- That is a statement about history, not about what is running. To close it, the owner can compare the deployed web build and `config.json` with `7b1236d` or the later web commits.

## 2. Decisions applied (from your instructions)

| Decision | Applied |
| --- | --- |
| "Action needed" everywhere | Reports page title and dropdown, Visit review text, Documents text, Branding page text. |
| US spelling | "colour" to "color" and "authorised" to "authorized" in visible text. Server messages in the API were not touched (not web code). |
| "Administrator" kept | Unchanged. |
| Shorter labels | Visit records, Visits overview, **Monthly hours & billing** (not "Monthly reconciliation"), Hours this month, Reminders (not counted), Outage records, Continuity pack (menu), Availability, Manage repeating shifts, "1 visit". |
| "Other actions" | It contained only Correct visit and the link to Billing review where minutes are approved, so it became **Correct or approve**. |
| "Hours left" | Used where the value is identical: Home, visit records, client page (was Remaining), calendar service totals, monthly reconciliation table, continuity pack. The CSV column header "Remaining to schedule" was left unchanged so exported spreadsheets do not break. |
| Authorization columns | Hidden by default; each row has an **Hours balance** control with the same three values (Monthly limit, Used this month, Hours left); all three stay in Columns. A previously auto-saved full column set counts as "never customized" and takes the new default; a real saved choice is kept. In a printout the three values are written out in full. |
| Actions visible without collapsing the sidebar | At 1440px with the sidebar expanded the visit table now fits its card (1074 of 1074 px); Status and Actions are visible. The visit reference moved under the client name (still a column in Columns). |

## 3. Completed, with evidence

| Item | Evidence |
| --- | --- |
| Sidebar, drawer, tooltips, remembered choice | Screenshots 01 to 05; `sidebar-home.test.tsx`; Chromium checks in the first round. |
| Home layout and palette; financial split | Screenshots 01 to 03, 06; test shows no dollar value for the manager. |
| Action buttons: Schedule, Visit records, Care requests (Open), caregiver Availability and My shifts | 40px or taller buttons; Cancel shift is red. Screenshots 07, 14, 20, 21, 22. Tests in `sidebar-home.test.tsx`. |
| Readable names | Client, caregiver and service cells have minimum widths; client name is bold; Care requests and caregiver opportunities show the service name, not only its code. Screenshot 07, 14, 20. |
| Per-client authorizations | Clients rows say "View authorized hours →"; the client page opens on Authorized hours. Screenshot 23. |
| Calendar filters | Date range and Filters are not shown on the client calendar; its description says it is always one client and one month. Screenshot 10; test. |
| Report selection and sidebar in sync | Choosing a report updates `?view=`; the highlight follows (browser: calendar, overview and reconciliation, exceptions, visit list); test. |
| **Every printed page identified** | A running header (agency, report, client or "All clients", month or period) and "Page N of M" on every page. Browser PDFs: calendar with detail (4 pages) and visit list (12 pages), every page carries both. The visit list now prints landscape with all columns (it used to clip at the right edge). Screenshots 11 to 13. |

## 4. Remaining screens: what was checked

Walked in Chromium with faked data at 1280px (office) and 390px (caregiver), screenshots 14 to 21:

| Screen | Result |
| --- | --- |
| Care requests | Readable. Fixed: Open button height, service name, capitalized status. **Shows client codes only** (the endpoint returns no name). |
| Care Team and detail | Clear. Detail page showed "2 active assignments" and "No current or upcoming assignments" together; I believe that is my fixture (list and assignments endpoints disagree), **not verified as a product defect**. |
| Settings: Branding | Fixed "NEEDS ATTENTION" and UK spellings. Billing rounding: opened with no policies only. |
| Documents | Due dates read "Due 10/20/2026 (in 14 days)" and "(5 days overdue)"; statuses are text. The "Reminder days" list showed blank values because my fixture lacks that endpoint; **not verified with real data**. |
| Caregiver: Verify visit, My shifts, Availability, My documents, Profile | Open at 390px with no sideways scroll. Fixed: availability opportunity shows the service name; "I can't make it" is now a bordered button. The Start/End/Confirm steps were not re-walked (covered by the existing end-to-end test). |

**Not verified:** a real printer and the browser's own print dialog; **Safari and Firefox** (the running header and page numbers use CSS page margin boxes, which Chromium browsers support; elsewhere the first-page letterhead still prints but the header and page numbers may not); screen readers; real touch devices; care request detail panel and offers; Documents and Billing rounding with real data; the deployed build.

## 5. Functional gaps (not styling)

1. No standalone Authorisations page in the AWS build (authorizations are per client).
2. Printed letterhead has no address, phone or email: see the proposal (Fix A).
3. No configuration-driven TEST marker; the Clients page has a fixed sentence: see the proposal (Fix B).
4. Care requests show client codes only.
5. Overnight availability and overnight care requests are not supported by AWS matching (see the branch comparison).
6. No Ogevia logo image in the repository (text wordmark used).
7. CSV exports keep the old column title "Remaining to schedule".

## 6. Requirement checklist

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Preserve working system | Done; all existing tests pass |
| 2 | Titles and labels | Applied as approved (section 2) |
| 3 | Sidebar | Done |
| 4 | Home layout | Done; **your reference screenshot has not been compared** |
| 5 | Reports, calendar, printing | Done and verified in Chromium print; other browsers not verified |
| 6 | Clear records and actions | Done for the screens listed; Care requests client names are a gap |
| 7 | Style | Done; zero and unavailable grey darkened to `#5C727B` for contrast |
| 8 | Verify and hand off | Partly: see "Not verified" in section 4 |
| Branch comparison | Done as a document; decisions pending |
| Letterhead and TEST marker | Proposals only; not built |

## 7. Checks run

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`; results are in the hand-off message. Browser checks used a production build with faked Cognito and API responses.
