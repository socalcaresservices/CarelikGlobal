# UX density and simplification pass: checklist and measurements

Base: `5878f936f0eebe7bafcdb9b49c2247e8ead61036` (after the TEST-findings cleanup); this change is web-layer only (no migration, no API route, no business rule, no enforcement change). Nothing pushed or deployed. Local harness, synthetic data, same database for before and after; phone figures are an EMULATED 390 px viewport (not a real device).
Screenshots: `screenshots/before/` and `screenshots/after/`, one `-full` (whole page) and one `-fold` (first screen: 1360x900 / 390x844) per screen. Measurements: `heights-before.json`, `heights-after.json` (main-content height in px).

## Calendar rule (separate request)
Only the CURRENT authorization of a service counts on the Monthly calendar (current = latest period start for that service). A replaced authorization is history: it is not added to or listed beside the current one. Worked/billable time that belongs to an earlier authorization stays in the totals table, tagged "Earlier authorization (history)" with no authorized time. Tests: `calendar-authorised-hours.test.tsx`.

## Measured page height (main content, px): before → after
| Screen | Desktop 1360 | Phone 390 (emulated) |
|---|---|---|
| Home | 1364 → 834 (-39%) | 2114 → 1614 (-24%) |
| Documents | 1165 → 687 (-41%) | 2121 → 1539 (-27%) |
| Action needed | 2187 → 708 (-68%) | 4675 → 1316 (-72%) |
| Scheduling | 1180 → 872 (-26%) | 2354 → 2039 (-13%) |
| Clients list | 505 → 477 (-6%) | 790 → 766 (-3%) |
| Client detail | 1596 → 912 (-43%) | 1816 → 1310 (-28%) |
| Care Team list | 1444 → 556 (-61%) | 2125 → 866 (-59%) |
| Caregiver detail | 2376 → 1085 (-54%) | 2804 → 1739 (-38%) |
| Recruiting | 656 → 466 (-29%) | 1356 → 1032 (-24%) |
| Compliance (Caregiver holds) | 871 → 515 (-41%) | 1759 → 825 (-53%) |
| Reports: Visit records | 2468 → 1146 (-54%) | 3137 → 2877 (-8%) |
| Reports: Monthly calendar | 604 → 384 (-36%) | 916 → 648 (-29%) |
| Reports hub | 2418 → 1384 (-43%) | 4084 → 2100 (-49%) |
| Settings: Appearance | 1468 → 404 (-72%) | 2108 → 872 (-59%) |
| Settings: Branding | 1536 → 1050 (-32%) | 1620 → 1394 (-14%) |
| Billing review | 1745 → 851 (-51%) | 3064 → 3006 (-2%) |
| Authorization changes | 264 → 206 (-22%) | 364 → 282 (-23%) |
| Visit review | 517 → 387 (-25%) | 549 → 455 (-17%) |
| Shift requests | 228 → 184 (-19%) | 268 → 228 (-15%) |
| Needs attention | 894 → 668 (-25%) | 1216 → 944 (-22%) |
| **Average** | **-39%** | **-29%** |

## What changed, by requirement
1. **Summary first, details on demand:** client page, caregiver detail and Care Team sections are one-line summary rows; the Care Team readiness block, the client Readiness card and the Caregiver compliance card are compact status rows whose forms open on demand.
2. **Status, actions and exceptions before explanations:** Action needed rows are one line (chip, what, short reason, due, action) with Critical/Urgent open and routine groups collapsed; Care Team now lists caregivers first; client page alerts first; compliance rows sorted exceptions first.
3. **Compliance forms to status cards:** caregiver Compliance card (hire date, background check, CPR, TB, enforcement), Care Team readiness, client Readiness, Caregiver holds reasons (chips such as "⚠ Hire date missing", full sentence behind Details).
4. **Instructional text:** shared info icon (floating text, stays in the page for screen readers), page leads behind an icon beside the title, about 60 instruction paragraphs moved to tooltips or expanders.
5. **Audit history:** shared compact list (when, who, one truncated line, expand for the full detail, scrolls inside a fixed height) on client history, Action needed issue history, Reports audit, visit rules, availability decisions.
6. **Less clutter:** one outer card with dividers instead of a bordered box per row (client alerts, onboarding checklist, assignments, caregiver outcome); one table header per schedule instead of one per day; Care Team, Documents, Billing review and Visit records rows are single lines.
7. **Above the fold:** Care Team and Action needed show their lists in the first screen; Billing review and Documents show their primary actions without scrolling; Billing review fits 1360 px with no sideways scroll.
8. **Shared system:** one button and link style, tighter cards (12-16 px), shell padding, section header rows 36 px (44 px on touch), compact page header.

## Screens reviewed one by one
Home, Action needed, Needs attention, Upcoming staffing, Visit review, Scheduling, Shift requests, Clients, Client detail, Care Team, Caregiver detail, Recruiting, Compliance/holds, Documents, Reports (visit records, calendar, hub), Settings (Appearance, Branding, Visit rules, Accounts), Billing review, Authorization changes. Screens not re-captured: Profile, Services, Continuity, Outage records, Care requests detail (spacing changes only).

## Checks
Web: `tsc` clean, `eslint . --max-warnings=0` clean, 125 files / 1,219 tests pass, `pnpm build` OK. API: `tsc` clean; names-first and workflow DB tests 65 pass. Not re-run (unchanged): infra/DB suites, CDK, auth.

## Remaining, stated plainly
- Smallest gains: Clients list (-6%, already a short list), Scheduling (-26%, data-driven), Authorization changes and Shift requests (short pages), and the phone views of Billing review (-2%), Reports/Visit records and Clients, which keep their card layouts.
- The Large-text and Compact appearance combinations were NOT re-run on the new layouts: NOT VERIFIED. Real keyboard traversal and a screen reader were NOT tested.
- Billing review below about 1100 px wide scrolls sideways inside its card (by design, in a scroll wrapper).
- Not deployed; TEST still runs the 0085 package.
