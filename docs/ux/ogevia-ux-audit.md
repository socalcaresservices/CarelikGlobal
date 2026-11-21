# Ogevia UX audit (Phases 0 to 2)

Prepared 2026-11-10. Synthetic data only. Nothing here is deployed; production, `ogevia_prd` and `app.ogevia.com` were not touched.
Evidence labels: **VERIFIED** (observed on the local harness, or read in code), **INFERRED** (reasoned, not observed), **UNKNOWN**.

## 0. Orientation (Phase 0)

| Item | Finding |
|---|---|
| Branch / HEAD | Assigned branch `claude/ogevia-ux-audit-redesign-w36cov` was created on **stale `main`** (`466f8ac`, 2026-10-24, migrations to 0085). `main` has no Staff, Staff Types, Roles, Business Compliance or the redesigned navigation. **VERIFIED** (`git ls-tree`). |
| Corrective action | Branch re-based (reset, nothing of mine lost) onto `claude/compassionate-thompson-jk5ozb` @ `757a5e4` (2026-11-09), which contains the live line `claude/practical-tesla-r07odb` (migrations to 0088) plus pending 0089. This matches `docs/releases/2026-11-09-update-packet/HANDOFF.md` ("the live app does not run `main`"). **VERIFIED** for the line; **UNKNOWN** for the exact commit on app.ogevia.com and demo.ogevia.com (packet decision D0). |
| Open PRs | 11 open; none touch UX. Relevant: #106 (redesign + production enablement, draft, base `main`), #107 (0087 invitations, draft). No PR exists for the work branch. No CI run exists for it. |
| CI | Not run for this branch yet. Local: `pnpm install --frozen-lockfile` OK; harness built and served. Full lint/typecheck/test is deferred to Phase 4 (no code changed in Phases 0 to 3). |
| Canonical modules | Navigation: `apps/web/src/aws/nav-model.ts`, `aws-shell.tsx` (sidebar plus `section-tabs` strip). Dashboard: `home-page.tsx`, `home-extras.tsx`, `attention.ts`. Schedule: `schedule-page.tsx`, `schedule-views.tsx`, `scheduling-extras.tsx`, `recurring-schedule.tsx`. Caregiver profile/readiness: `care-team-page.tsx`, `readiness/*`. Staff: `staff-pages.tsx`. Business Compliance: `compliance/holds-page.tsx` (route `/compliance`, shown as "Caregiver holds"). Reports: `pages/service-verification-reports-page.tsx`, `reporting-page.tsx`. Caregiver: `my-shifts` (`MyShiftsPage`), `pages/service-verification-page.tsx` (Verify Visit), `caregiver-availability-page.tsx`, `documents-page.tsx`. Help: `ui/info-tip.tsx`. No parallel versions will be created. |
| Walk method | Local harness (real web build, real API handler, local PostgreSQL 16, synthetic agency). Playwright, signed in as Owner, Manager, Scheduler and Caregiver; every route at **390 px (touch) and 1360 px**; 240 screenshots, console and network failures, horizontal overflow and tap-target counts recorded. Captures are in the session scratchpad, not committed. |
| Not walked | The live site (not reachable; sign-in needs an account), demo.ogevia.com (no credentials in this session), signature drawing and submit, and a physical phone. Phone checks are Chromium emulation at 390 px with touch. |

## 1. Owner-observed issues: confirmed or refuted

| # | Issue | Verdict | Evidence |
|---|---|---|---|
| 1 | Navigation shown twice; stray up/down arrow; ambiguous "Notifications ?" | **Confirmed (duplicate nav).** Sidebar shows the group, then `section-tabs` repeats the same group's pages above every page. Examples (desktop): Clients page tabs `Clients / Authorization changes`; Staff `Caregivers / Staff / Staff Types / Recruiting / Documents`; Reports/Billing `Reports / Billing / Visits / Visits to review / Verify visit / Outage records`; Schedule `Schedule / Calendar / Requests`. The tab strip also carries the same count badges as the sidebar. **VERIFIED** (`aws-shell.tsx:218,533`). The tab strip scrolls sideways on a phone and clips ("My docum…"). **VERIFIED.** | 
| | "Stray up/down arrow" | **Not reproduced** as an arrow control. The only up/down glyphs found are the sidebar group chevrons (`>` collapsed, `v` open) and the `▲` severity icon in the "Needs attention now" chip. I think the owner means one of these. **INFERRED**; needs a screenshot from the owner to be sure. |
| | "Notifications ?" | **Confirmed as a failed-count state, not a design choice.** `attention.ts:96` and `action-needed.ts:96` render `?` with label "Unable to check" when the count request fails. With a healthy API it shows a number (3 locally). A bare "?" gives no cause and no retry. **VERIFIED** (code); symptom in production **VERIFIED** only by the owner's screenshots. |
| 2 | "i" help icons scattered, overlapping inputs | **Confirmed.** `InfoTip` is used in 36 source files; 13 pages show 1 or 2 icons next to headings and labels (client detail 2, branding 2, accounts, care requests, billing review, continuity, rounding, visit rules, Staff header, Schedule header, Recruiting). It is an absolutely positioned 20 px (44 px on touch) circle that opens a 256 px floating panel (`ui/info-tip.tsx`). The panel can sit over fields below it. The "reopens after closing" defect (packet B-01) is already fixed on this line (`6bd3e63`), but the floating pattern remains. **VERIFIED** (code and screenshots). Overlap over specific Care Request fields was **not re-observed** locally. |
| 3 | Production load failures | **Symptoms explained; root cause not yet proven.** See section 3. |
| 4 | Dashboard too heavy; solid blue blocks | **Partly refuted for this build.** The local build has **no** cards named "Billing and potential value" or "Hours available"; the strings do not exist in any commit (`git log --all -S`). The local dashboard already has a compact chip row (four tiles), a 5-row list, "Hours this month" and "Financial impact" cards. The solid dark-blue blocks in the owner's screenshots therefore come from a different build or from the `Chart` component (`ui/chart`, used for "Worked hours by service") rendering with no data scale. **INFERRED**; needs D0 (deployed commit). Still too busy: 8 stacked regions, three of them collapsible and three of them numbers about the same month. |
| 5 | Schedule stacks too much | **Confirmed.** Order on `/schedule`: filter chip row, 5-figure KPI strip, "Unfilled (3)" table, "Past: need review (0)", then the Day/Week/Month calendar below the fold. There are also three tabs (`Schedule`, `Calendar`, `Requests`) and two more links ("Repeat visits", "Manage repeating shifts", "Hours and limits"). Add shift is already a button; the form state was not observed (`schedule-page.tsx`, 652 lines). **VERIFIED** (screenshot, code). |
| 6 | Four "Renee Alika" staff records | **Mechanism confirmed in code; production rows not seen.** See section 4. |
| 7 | CPR/TB "Document type not set up" | **Confirmed as a configuration gap with a weak path.** The readiness check returns `type_not_set` when the agency has not picked a document type for CPR and TB. The setup control exists only on the Care Team readiness card ("Set up required documents") and is hidden from roles without `documents.requirements.manage`; the caregiver profile row shows the problem with no link to the fix. A new agency starts with the gap. **VERIFIED** (`readiness-card.tsx:182-196`, migrations 0042/0055/0081). |
| 8 | Verify Visit lists all "Other assigned clients" | **Confirmed.** At 390 px the Caregiver sees "Scheduled today: You have no visits scheduled for today", then **seven** "Other assigned clients" cards (two with "0 active services"), a clock, and a disabled "Start visit" button. `pages/service-verification-page.tsx:786-791`. **VERIFIED.** |
| 9 | Business Compliance shows other ventures' records; display defects | **Not verifiable locally.** The repo and seed contain no "Riverine" or "Ogevia SOS". The page (`/compliance`, title "Caregiver holds") lists caregiver compliance holds, not business licences, so the owner's "Business Compliance" entries come from the deployed build or its data. **UNKNOWN**; flag only, as instructed. Display defects: a holder name with a typo ("Ookereke") is data, not code. The truncated "Adam Muth (" is consistent with a fixed-width cell or a `truncate` class cutting a "Name (CODE)" label; the same pattern is used for the sidebar agency name ("Local Demo Agency (synthet…"), **VERIFIED** locally for the sidebar. |

## 2. Screen-by-screen audit

Columns: Purpose, Primary user, Primary action, Hide or collapse, Duplicated, Contradiction or unclear, Wasted space, Mobile defect. Every row **VERIFIED** unless marked (I).

### Admin and office screens

| Screen (route) | Purpose / user | Primary action | Hide or collapse | Duplicated navigation or data | Contradictory, unclear, wasted space | Mobile (390 px) |
|---|---|---|---|---|---|---|
| Dashboard `/` | What needs me now. Office | Open the first urgent item | "Hours this month" and "Financial impact" detail; Outage readiness card | Tabs `Dashboard / Action Needed` repeat the sidebar; "Needs attention now 3" chip repeated in the header and the first tile; "Notifications 3" is a third count | Three numbers for "attention" (header chip, tile, list "View all") with three definitions; "Needs attention now: 0" can sit beside "list could not be loaded" because the tile and the list use **different endpoints** (section 3) | No overflow. 1 target under 44 px |
| Action Needed `/action-needed` | Full issue list. Office | Open one issue | Filters | Same list as the dashboard top-5 | Tab, page and sidebar all named differently ("Action Needed", "Action needed", "Needs attention") | 5 small targets |
| Needs attention `/attention`, Upcoming staffing `/staffing`, Visit review `/visit-review` | Three more lists of overlapping items | Open item | all | Overlap Action Needed | A fourth and fifth place for the same shifts and visits | 1 small target each |
| Clients `/clients`, client detail | Client list and per-client authorizations. Office | Open client | Detail blocks | Tabs `Clients / Authorization changes` | Detail page has 2 "i" icons beside labels, 41 small targets at desktop | 5 to 6 small targets |
| Caregivers `/care-team` (+ detail) | Roster and readiness. Office | Approve or Assign | Readiness rows already collapse | Tabs list 5 related pages | Readiness mixes "required", "follow-up" and "setup incomplete" in one table; "Document type not set up" has no fix link | 4 small targets |
| Staff `/staff` | Staff list. Office | Add staff | Filters (4 selects always visible) | Tabs repeat sidebar | **List is a UNION of three sources with no shared identity** (section 4) | **24 small targets**; filter row consumes the first screen |
| Staff Types `/settings/staff-types`, Roles `/settings/roles`, Accounts `/accounts` | Setup | Add type / change role | all | Staff Types is both a Staff tab and a Settings item | Staff and Accounts overlap (both list people and sign-in state) | 14 to 17 small targets |
| Schedule `/schedule` (+ `?view=calendar`, `?view=exceptions`) | Schedule and cover shifts. Scheduler | Add shift / Assign | KPI strip; "Past: need review" when empty | 3 tabs plus 3 text links; chip "Needs attention now" repeated from header | Calendar is below Unfilled and Past blocks; "Calendar" tab and the calendar on the page are the same thing; "Requests" is a tab and a separate page | 10 small targets; weekly table needs sideways reading (I) |
| Care requests `/schedule/shift-requests` | Client requests. Scheduler | Convert to shift | Help panel | Tab | 1 info icon | 8 small targets |
| Visit records `/service-verification/reports` | Visit list. Office | Open visit | Columns | 6-tab strip `Reports / Billing / Visits / Visits to review / Verify visit / Outage records`; "Visits to review" count equals the dashboard "Visit review" tile | "Verify visit" is in the **manager** menu (a caregiver function) | **45 small targets** at 390 px, 74 at desktop: the densest screen |
| Reports `?view=overview`, Reporting & billing `/reporting` | Aggregates | Choose month | Dropdown of 8 reports | Two report entry points | "Reports" and "Reporting & billing" are different pages | 7 to 10 small targets |
| Billing review `/billing-review` | Approve billable visits. Owner | Approve | Per-row detail | Tab | Per-visit Approve with no "approve all clean" (packet M-05) | 2 |
| Outage records `/outage-visits`, Reconcile | Paper records and expired shifts | Open | Help | Tab | n/a | 12 small targets |
| Authorization changes `/authorization-impacts`, Rates `/authorizations/rates` | Authorization review | Review | n/a | Tab / orphan page | Rates page is reachable only by link | 1 to 3 |
| Caregiver holds `/compliance` | Compliance holds | Check now | Empty state | Orphan route (not in sidebar for Owner locally) | Named "Caregiver holds" here, "Business Compliance" in the owner's screenshots | 2 |
| Settings: Services, Appearance, Branding, Rounding, Visit rules, Continuity | Agency setup | Save | Rarely used: all | Tabs list six, sidebar three | Appearance has 25 small targets on phone (swatches); Branding 2 info icons | 5 to 25 |

### Caregiver screens (phone-first)

| Screen | Purpose | Primary action | Hide | Duplicated | Contradictory / unclear / wasted | Mobile |
|---|---|---|---|---|---|---|
| My Schedule `/my-shifts` | My upcoming shifts | Open a shift | Past shifts | Tab strip plus "Menu" button | 1 help icon | OK; tab strip clips "My docum…" |
| Verify Visit `/service-verification` | Start, run, confirm a visit | **Start** | Everything except today's visit | Tab strip repeats the Menu | All assigned clients listed (issue 8); "0 active services" shown; code "CL-3711AABD17" as the client name; Start is disabled and grey until a card is tapped | No overflow; page is 1,330 px tall for a one-tap action |
| Availability `/availability` | Set availability | Save | Week grid | n/a | **Owner, Manager and Scheduler all get `403 GET /api/v1/availability`** when they open it (it is a caregiver-only route) and see "Forbidden". Harmless for caregivers; wrong for others. | 2 small targets |
| Documents `/documents` | Upload CPR/TB | Upload | Reminder detail | n/a | n/a | 1 |

Caregiver menu already contains only the four required items; the defects are the duplicate tab strip and the Verify Visit page, not the menu.

## 3. Production loading failures (P0, investigation only)

| Symptom (owner screenshots, production) | Code path (VERIFIED) | Finding |
|---|---|---|
| Dashboard: "The list of items that need action could not be loaded" | `home-extras.tsx:121` `TopIssues`, query `useHomeIssues` -> `GET /v1/action-issues` -> `ogevia_api.list_action_issues` | Message is correct and honest ("not shown as empty"). |
| Dashboard **same time**: "Needs attention now: 0 items" | `attention.ts:141`, query `GET /v1/attention/overview` -> `ogevia_api.get_attention_overview` | A **different endpoint and a different engine**. It can succeed (0) while the list fails. The page then says two things at once. That is the contradiction. |
| Schedule: "Some figures could not be loaded." | `schedule-views.tsx:84`: shown when `todays.isError || issues.isError` (counts + issues) | Same dependency. |
| Action Needed page fails | `action-needed-page.tsx` -> `GET /v1/action-issues` | Same endpoint. |
| Notifications button shows "?" | `attention.ts:96` -> counts failed | See below. |

**Common cause (INFERRED, strong).** `list_action_issues` (0073/0084), `get_attention_counts` (0080) and the notifications function (0077) all call the shared `ogevia.action_issue_rows(...)`. `get_attention_overview` does **not**. The one endpoint that works is the one that does not use the shared function; the three that fail all do. So the likely failing component is `action_issue_rows` (or the issue-state bookkeeping `list_action_issues` performs on every read: advisory lock, inserts into `action_issue_events` and `action_issue_state`), erroring on production data or state.

**What I tried to reproduce, and the results:**
1. All three functions on the full local database as Owner: pass (48 issues).
2. Same, with every client set to inactive and all private names deleted (the state left by the 2026-10-23 test-data cleanup, PR #104): pass.
3. Walked every screen as four roles: no `/v1/action-issues`, `/v1/attention/*` or `/v1/notifications` failure.
4. Production ledger is 85 / 0085 (as-found 2026-10-26), so 0073/0077/0080/0084 exist there. **Version skew with 0086 to 0088 does not touch these functions** (migrations 0086 to 0088 do not redefine them).

**Root cause: NOT PROVEN.** It needs one of: the Lambda or Postgres error for `GET /v1/action-issues` in CloudWatch (read-only), or a read-only `select ogevia_api.list_action_issues(...)` run in the approved DB window. I have no AWS credentials in this session and was told not to touch production. **Requested input:** the error line (route, status, `errcode`) for those three requests. If it is a constraint violation in `action_issue_state` or a statement timeout, the fix is in SQL and must be re-tested on a production-like fixture.

**Defects fixable now (planned in Phase 4 PR 1), independent of the root cause:**
- A failed list must make **every** attention figure on the page read "Unavailable", not just the list. The tile must not show 0 while a sibling request failed.
- "?" in the Notifications button becomes the word "Unavailable" with a retry.
- One request for the whole attention picture so the page cannot disagree with itself (see spec section 5).
- Add a test that fails the issues endpoint and asserts no "0 items" is shown anywhere.

## 4. Duplicate staff (issue 6)

**How they get created (VERIFIED in `0086`/`0087` `ogevia_api.list_staff`).** The Staff list is `UNION ALL` of three independent sources:
1. `staff_profiles` (created by **Add staff**),
2. `caregiver_records` (created by caregiver intake, recruiting, or the Care Team page),
3. `organization_memberships` for roles without either of the above (an account with no profile).

Nothing links the three except `user_id`, and only when it is set. Uniqueness exists only on `(organization_id, user_id)` and `(organization_id, login_email)` for profiles. There is **no uniqueness or duplicate warning on name, normalized email or phone**, caregiver records carry no email in this list (the column is `null`), and `create_staff` does not look for a matching caregiver record. So one person who is entered as a caregiver, then added again with **Add staff** (type Caregiver), then invited by email, appears as up to three or four rows with different capitalization ("RENEE ALIKA", "Renee Alika"), role ("Caregiver", "No access") and status ("Active", "Invited", "No sign-in"). That matches the owner's description. **INFERRED** for the production rows (not seen).

**Proposed server-side rule (not applied to any data):**
1. Normalize: `lower(btrim(collapse_spaces(name)))`, email lowercased, phone to E.164 digits.
2. **Hard match** (same organization): same normalized email, or same normalized phone, or same `user_id` -> one person. Creating or importing a second row is refused with a pointer to the existing one ("Already on your team: open it").
3. **Possible match** (name only, or name plus shared last 4 phone digits): allowed only after the admin picks "This is a different person" with a reason, recorded in the audit log.
4. **Merge** is an explicit admin action on a reviewed pair: choose the surviving record, move the others' links (assignments, shifts, readiness, documents, invitations, `user_id`) to it, soft-retire the others with `merged_into`, write one audit event with before and after. Never automatic, never across organizations, refuse when both records hold different `user_id`s or different background-check results (needs a person).
5. A **read-only duplicate report** ships first (candidate groups with reasons), so the owner can review production-like groups before any merge tool exists.

## 5. Pattern research (Phase 2)

All sources are vendor pages or help documents read on 2026-11-10 through search results; most pages are undated. They describe vendor claims, not tested behavior. Patterns only; no branded UI is copied.

| Problem | Pattern seen | Source | Recommendation (one) |
|---|---|---|---|
| Navigation | AxisCare and AlayaCare group by task (scheduling, clients, caregivers, billing) in one sidebar and keep related pages inside the section, not as a second tab bar. (INFERRED from product tours; not confirmed pixel-for-pixel) | [AxisCare features](https://axiscare.com/overview/), [AlayaCare operations](https://alayacare.com/home-care-operations-software/) | **One sidebar of 6 sections with sub-items; no tab strip.** |
| Exception queue | AlayaCare describes automated tasks and "streamlined resolution of exceptions" for missing documentation and visit-verification issues before claims. | [AlayaCare pricing page](https://alayacare.com/ca/pricing/), [operations page](https://alayacare.com/home-care-operations-software/) | **One prioritized queue** (past shifts, unfilled, documents, authorization), one action per row. |
| Scheduling | AxisCare: drag-and-drop assign and reassign on a calendar; open shifts pushed to caregivers by text, email or app. | [AxisCare scheduling](https://axiscare.com/scheduling) | **Calendar first; assign through a side drawer** (drag-and-drop is later, not first: a drawer works with a keyboard and on touch). |
| Caregiver mobile | AxisCare app: today's schedule, open visits (accept, decline, dismiss), clock in/out within an agency-set window; AlayaCare: daily visit list. | [AxisCare mobile](https://axiscare.com/features/caregiver-mobile-app/), [AxisCare Mobile Tutorial](https://static.axiscare.com/master/documents/AxisCareMobileTutorial.pdf), [AlayaCare mobile](https://alayacare.com/home-care-mobile-app/) | **Today's visits only, one large Start.** Ogevia keeps server timestamps and no GPS (CLAUDE.md section 10). |
| Open-shift cover | AlayaCare "Shift Offers": a vacant visit offered by message with a response due date. | [AlayaCare Shift Offers](https://alayacare.com/blog/feature-highlight-shift-offers/) | Already exists in Ogevia as pickup requests; reuse it for call-out replacement. |
| Bulk import | HHAeXchange: downloadable Excel template, bulk caregiver import, failed files reported. CareSmartz: self-serve import for clients, caregivers and staff that **validates mandatory fields and formats**. | [HHAeXchange caregiver bulk import](https://knowledge.hhaexchange.com/provider/Content/Documentation/Portals/Port-B-Caregiver-Bulk-Import-Process.htm), [CareSmartz self-serve migration](https://intercom.help/caresmartz/en/articles/10514239-using-the-self-serve-data-migration-tool) | **Template, upload, preview with row errors, dry-run summary, explicit confirm.** |

WellSky Personal Care and CareTime: the search returned nothing usable about their screens or imports. **UNKNOWN**; they are not cited.

## 6. What to keep (verified working)

OWNER VIEW / MANAGER VIEW label, the TEST banner, "Needs action first" with one link per row, the three-step bar (Start / Visit / Confirm) in English and Spanish, no sideways scroll at 390 px on any screen walked (0 of 120 phone captures, all four roles, overflowed), server timestamps, and the honest failure sentence "not shown as empty".
