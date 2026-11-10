# Ogevia redesign spec (Phase 3)

Prepared 2026-11-10. **Status: PROPOSED. Not implemented. Not deployed.** Awaiting owner approval before any Phase 4 work.
Companion files: `docs/ux/ogevia-ux-audit.md` (evidence) and `docs/ux/mockup/index.html` (clickable mockup, layout and flow only, not schema).
Base: the live line, `claude/compassionate-thompson-jk5ozb` @ `757a5e4` (see audit section 0). The exact deployed commit is still unconfirmed (packet D0).

## 0. How to run the mockup

```bash
cd docs/ux/mockup && python3 -m http.server 8099   # then open http://localhost:8099/
```
It is one static file (no build, no network, no libraries) with synthetic people only. The bar at the top switches **Office admin / Caregiver (phone)** and simulates a dashboard load **failure** or **empty** state. Use a 390 px window for the phone flow. Checked with Chromium at 390 px (touch) and 1360 px: no horizontal scroll, no console errors, every button 44 px or taller, all flows clickable end to end (verified by script, 2026-11-10). It is not the product: its data lives in the page and nothing is saved.

## 1. Design rules (apply to every screen)

1. Every screen answers two things: **what needs my attention** and **the one next action**.
2. One primary button per view. Everything else is secondary or a text link.
3. Progressive disclosure: anything used less than weekly is collapsed (`<details>`) or lives in a drawer.
4. One type scale (page title 20, section 16, body 15, helper 13), one spacing step (8 px), existing design tokens (`og-*`); no new colors.
5. Plain labels. One name per thing: "Action needed" (not Needs attention / Action Needed / Attention).
6. Every data region has four states: **loading** ("Checking…"), **empty** (says what would appear), **error** ("Unavailable", says why and how to retry), **success**. A failed load is never rendered as 0.
7. No horizontal scroll at 390 px. Tables become stacked rows below 768 px, or sit in one labelled scroll region only when a table is the point (reports).
8. Touch targets at least 44 px (currently 24 to 74 under-sized targets per screen; the audit lists them).
9. Help: no floating "i" icons. Inline helper text under a field only when needed; otherwise **one `?` in the page header** that opens a short panel anchored to the header, never over a field or a label.
10. Colors always paired with a word or icon (existing practice, kept).

## 2. A. Navigation (one system)

**Sidebar only; the section tab strip is removed.** Collapsible (icons only at 64 px; remembered per user on this device). Below 900 px it becomes a drawer opened by a Menu button.

| Section | Sub-items (shown only inside the sidebar) | Who |
|---|---|---|
| Dashboard | — | Owner, Manager, Scheduler |
| Schedule | — (Calendar, Requests, Repeating, Hours and limits move inside the page) | Owner, Manager, Scheduler |
| Clients | Clients, Authorization changes | Owner, Manager |
| Care Team | Caregivers, Staff, Staff types, Recruiting, Import people | Owner, Manager (Import and Staff types: Owner) |
| Reports | Visit records, Reports, Billing | Owner, Manager (Billing: Owner) |
| Settings | Roles and permissions, Agency settings, Business compliance | Owner |

- Header (right): **Notifications** (count, or the word "Unavailable") and the single **`?`**. The ambiguous "Notifications ?" and the "Needs attention now" chip in the header are removed; the dashboard's KPI row carries that number.
- Role menus come from the existing permission map (`aws-shell.tsx` `show` conditions). Nothing new is granted or hidden by this change; destinations are unchanged except the removed tab strip, so every page stays reachable.
- **Caregiver menu: My Schedule, Verify Visit, Availability, Documents only**, as a 4-item bottom bar on a phone (current: top tab strip that clips). Profile and sign out live under the avatar.
- "Verify visit" is removed from the manager/owner Reports menu. Visit records is the entry to Reports.
- Owner/Manager/Scheduler no longer see the caregiver-only Availability route (today: `403 Forbidden` page, audit section 2).
- Reuse: `nav-model.ts` (groups, `currentLink`, `visibleGroups`), `aws-shell.tsx`. The change deletes the strip rendering and moves `tabOnly` items into their page or into the sidebar sub-items. No parallel shell.

## 3. B. Dashboard

Top to bottom, nothing else visible by default:
1. **KPI row** (5 compact figures, 60 px high, no solid color blocks): Action needed · Past shifts to review · Unfilled shifts · Documents expiring · Hours left this month. Each is a link to its filtered queue. Tone by word and a thin top rule only.
2. **One work queue**, sorted by urgency, chips to filter (All, Past shifts, Unfilled, Documents, Authorization). Each row: type tag, what, why, **one** action button (Review / Assign / Open documents / Review authorization). Only the first row's button is primary.
3. Collapsed by default, reachable by link: Billing and potential value and Hours detail (move to Reports > Billing/Reports), Outage readiness (Settings).

**Consistency fix for the P0 finding.** One request supplies the KPI row and the queue (extend the existing `get_attention_counts` / issue engine contract; do not add a parallel endpoint). If it fails, the KPI row and the queue both read **Unavailable** with one Retry. A figure may show 0 only when the server returned 0. The mockup's "Simulate failure" and "Simulate empty" buttons show both states.

## 4. C. Schedule (calendar first)

- Toolbar: Day / Week / Month, previous / next, week label, **Add shift** (the one primary button).
- **One exceptions list** directly above the calendar, collapsed to a single bar when empty, open when not: Unfilled, Past shifts needing review, Caregiver not signed in. Each row has **one** action (Assign / Review / Send sign-in link).
- Calendar below it, visible without scrolling past more than that bar. Week on desktop; a single-column agenda per day on a phone. Shift colors: covered (green rule), unfilled (red), not signed in (amber), past (grey), each with a text label.
- **Add shift opens a right-side drawer** (full-screen on a phone): client (with authorization hint), service, date, start, end, caregiver (only approved caregivers; "not signed in" shown beside the name), **Repeat** (does not repeat / weekly on chosen days / until a date). Save runs the server checks that exist today (authorization hours, availability, overlap, readiness) and shows each result.
- **Shift drawer**: details, authorization (collapsed), and the one relevant action: Assign (open) or **Record call-out** (covered). Call-out asks for a **required reason** and an optional **replacement**; choosing none turns the shift Unfilled and it appears in the exceptions list. The authorization hours stay reserved once, not twice (existing call-out and replacement rules are reused, not changed).
- "Repeat visits", "Manage repeating shifts", "Hours and limits" and "Requests" stop being tabs and links: Repeat is in the drawer; series management is a link inside the shift drawer; limits are in Settings; Requests is an item in the exceptions list ("Care request waiting").
- Reuse: `schedule-page.tsx`, `schedule-views.tsx`, `recurring-schedule.tsx`, `replacement-model.ts`, `pickup-requests.tsx`, existing assign and call-out API routes.

## 5. D. Assign client to caregiver plus schedule

Entry: Care Team > Caregivers > **Assign client** (also from the shift drawer's Assign). One drawer:
1. Readiness summary (4 rows: background check, CPR, TB, app sign-in), each with a word and a reason.
2. Client, service, and **schedule**: weekly pattern / one shift / assign only (schedule later).
3. One button: **Assign and schedule**, or **Approve by override and assign** when the only thing missing is sign-in.
The server performs assignment and shift creation in one transaction with a per-shift result and a safe retry key; it reuses the current assignment (no second assignment for the same pair), per packet S-02.

### Admin override (owner decision 2026-11-10; implement only as specified)

| Rule | Spec |
|---|---|
| What it does | An administrator may approve a caregiver for work, and schedule and assign them, although they have **not signed in to the app yet**. |
| Who | Organization owner / administrator only (matches the existing "Admin may override a No Match; Manager may not" rule). **Needs owner confirmation**, see decision 1 below. |
| Record | **Required reason** (free text, not empty after trimming), approver, timestamp, and an **audit event** (`caregiver.approved_by_override`) written in the same transaction. Append-only. |
| Background check | **Hard block. No override exists.** The button is disabled and the drawer says why. Enforced in SQL, not only in the UI. |
| CPR / TB | Unchanged: existing 30-day grace period plus recorded per-caregiver extensions. The override does not touch them. |
| Visibility | Badge **"Approved by override — not signed in"** on the caregiver profile, the Care Team list and every schedule shift for that caregiver, until first sign-in. On first sign-in the badge clears; the override record and audit event stay. |
| Visits | A caregiver who has not signed in cannot verify a visit (needs the account). The schedule shows a **warning on their shifts** and the exceptions list shows "Not signed in" with **Send sign-in link**. |
| Not allowed | The override is not a way around the background check, required training, or authorization limits; it is not reusable across caregivers; it does not create billing state. |

**Conflict to resolve before build (decision 1).** The pending, unapplied migration **0089** (`infra/aws/db/pending/migrations/0089_signin_followup_not_hard_requirement.sql`, packet U-01, owner instruction 2026-11-09) removes sign-in as a requirement for everyone, with **no reason, no approver record and no badge**. Today's decision keeps sign-in a requirement that only a recorded administrator override can waive. They cannot both stand. Recommendation: implement today's decision, **withdraw 0089 before it is released** (it is applied nowhere, so nothing is rolled back), and write a new migration that adds the override table, the audit event, and the readiness rule "sign-in is met by first sign-in **or** by an active override". The packet's wording "superseded by U-01" (T-03) is itself superseded. This is recorded in the decisions log (`docs/product/SCHEDULING_AND_ACCOUNTS_DECISIONS.md`, section 2026-11-10) as the owner's rule; the 0089 withdrawal is **pending the owner's answer**.

## 6. E. Caregiver phone flow

Four screens, same logic as today (server timestamps, minimum one minute before End, refresh keeps the open visit, "unable to confirm" fallback, English and Spanish step bar). Changes are only what is shown:

1. **Start**: only **today's scheduled visits** for this caregiver (client label, service, time) and one large **Start visit** button. If there are two visits, two cards, each with its own Start. If there are none: "You have no visits scheduled for today" and nothing else. **"Other assigned clients" is removed**, as are "0 active services" cards and the three authorization numbers (office concern). The client name is the existing label (client code today; the caregiver-facing label is packet decision D7, unchanged).
   - **Unscheduled visit** stays available behind one small, labelled link ("Not your scheduled visit? Start an unscheduled visit"). It opens a **Provisional** screen: client picker (only assigned clients), required reason, Start. It is clearly marked provisional and goes to office review; no schedule is invented (existing rule).
2. **Active**: server Time In, elapsed timer, client, service, linked scheduled window, one **End visit** button.
3. **End and confirm**: scheduled vs worked vs difference; who confirms (client signs, representative signs, verbal, unable to confirm); caregiver attestation is an authenticated checkbox (ID, time, version recorded; not a second handwritten signature); one **Submit visit** button, disabled until a method and the attestation are chosen.
4. **Submitted**: locked summary (worked, confirmed by, status "In review").
- Navigation: 4-item bottom bar (64 px). No top tab strip, no "Menu" button.
- Reuse: `pages/service-verification-page.tsx` (delete the `notScheduledToday` list at lines 786-791; the `scheduledToday` data already exists), existing start/end/confirm API.

## 7. F. Bulk import: staff and clients (CSV and XLSX)

Flow (mockup: Care Team > Import people): **Template → Upload → Preview and dry run → Confirm**. Clients import lives under Clients > Import clients with the same component.

**Server design (all in the API, nothing trusted from the browser):**
- Routes: `GET /v1/imports/{kind}/template` (kind = staff | clients; csv or xlsx), `POST /v1/imports/{kind}/preview` (upload + parse + validate + dry run; **writes nothing except a preview record**), `POST /v1/imports/{kind}/{importId}/confirm` (explicit confirm; one transaction). Same style as existing routes; added to both `routes.ts` and the API stack route list (existing `slice-contract` test enforces this).
- **Tenancy**: `organization_id` comes from the session (`orgParam(event)` pattern), never from the file; a column named organization is ignored and reported. Row-level security as on every other table.
- **Parse**: CSV (UTF-8, RFC 4180) and XLSX, first sheet or a named sheet; max 1,000 rows, max file size 5 MB (Lambda payload), formulas never evaluated, macro files rejected, header row required, unknown columns reported not ignored silently. **XLSX needs a new dependency**; see decision 3.
- **Validation per row** (shown in the preview with a reason): required fields; email and phone format; dates; for clients, authorization start before end, hours greater than 0 and within a sane cap; staff type exists. **Importing never creates billing state**: no approvals, no billable minutes, no claim rows; authorizations imported follow the manual-entry rules only.
- **Dedupe**: staff on normalized email and normalized phone (see audit section 4); clients on **agency-defined keys** (the "Agency key" column plus normalized name and date of birth, chosen per agency in import settings). A match = **Update** only when the key is exact; a weaker match = **Possible duplicate**, held for review, never merged or written silently.
- **Dry run**: counts New / Update / Possible duplicate / Error, plus the row table. A preview record stores the parsed rows with a hash of the file and expires after 24 hours.
- **Confirm**: single transaction, all-or-nothing for the rows marked New/Update; error and duplicate rows are skipped and listed. **Idempotent**: key = `(organization_id, file SHA-256, mapping)`; confirming the same preview twice, or re-uploading the same file, returns the first result and changes nothing. A concurrent double confirm takes an advisory lock on that key.
- **Staff**: **no sign-in invitations are sent by import.** Invitations are a separate, explicit bulk action in Care Team ("Send sign-in links to selected"), using the existing invitation function.
- **Clients**: Ogevia client codes are generated server-side (existing random, non-semantic generator). UCI / Medicaid / member IDs are restricted fields: written only through the existing restricted-identifier path, never shown in the preview table for roles without access, never logged.
- **Privacy**: file names, row contents, names, emails and identifiers never appear in logs, URLs, S3 keys or error messages (errors say "row 9, column Phone", not the value). The uploaded file is not retained; only parsed rows in the preview record (encrypted, 24 h) and the audit entry.
- **Audit**: one append-only event per import (`import.confirmed`): who, when, file SHA-256, kind, counts (new, updated, duplicate, error), result status. No row data in the event.
- **Tests (each must fail without its rule):** malformed file (bad zip, binary, wrong encoding, missing header); wrong tenant (token for org A cannot confirm a preview of org B; `organization_id` column ignored); duplicate rows inside one file; partial failure rolls the whole confirm back (inject a failure on row N, assert zero rows written); a **1,000-row file** within the Lambda time budget; re-upload of the same file (no new rows, same result); concurrent double confirm; no invitation sent; no billing rows created; log-capture test asserting no value from the file appears in any log line; permission test (Scheduler and Caregiver refused).

## 8. G. Other fixes carried into the build

| Item | Spec |
|---|---|
| Help icons | Replace every `InfoTip` use: pages with a real need get a helper sentence under the field; everything else moves into the header `?`. `InfoTip` is deleted after the last use is migrated (a lint rule or a test greps for imports). |
| CPR/TB "Document type not set up" | (1) **Default setup**: when an agency has no CPR/TB document type, the Care Team readiness card offers one button, **Use standard CPR and TB** (creates the two document types with the agency's current grace and validity defaults; reversible; audited). (2) The profile row links straight to it for administrators and says "Ask an administrator" otherwise. (3) A new agency gets the two types seeded at creation. Per CLAUDE.md the exact validity rule is not invented here: the button uses values the owner confirms (decision 4). |
| Business Compliance | Flag only: possible other-venture records ("Riverine SOS", "Ogevia SOS") listed for the owner's decision; **no move, no delete**. Display defects: allow wrapping instead of truncating "Name (CODE)"; holder name typos are data and are corrected by the owner. |
| Duplicate staff | Read-only duplicate report first; then create-time refusal on hard matches; then an admin merge action with audit (audit section 4). No production record is merged by this work. |

## 9. Phase 4 plan (after approval; small PRs in the owner's order)

| # | PR | Tests | Notes |
|---|---|---|---|
| 1 | **P0 load failures**: unify the attention figures into one honest state; "Unavailable" everywhere; add the failing-endpoint fix once the log line is supplied | web unit: every figure reads Unavailable when the endpoint fails; SQL: `action_issue_rows` on a production-like fixture | **Blocked for the SQL part** until the real error is seen (audit section 3). The web part can ship first. |
| 2 | Navigation and help-icon cleanup | `nav.test`, `route-map`, role menus, no `InfoTip` imports, 390 px overflow test | Reuses `nav-model.ts` |
| 3 | Caregiver Verify Visit simplification | start/end/confirm regression, only-today list, provisional path, 390 px | Deletes one list |
| 4 | Schedule redesign | schedule tests, drawer a11y, repeat, call-out reserve-once, exceptions list | Largest web PR |
| 5 | Dashboard | KPI/queue states (ok, failed, empty) | |
| 6 | Admin override | **SQL**: override needs reason; refused for background check; audit written in the same transaction; badge clears on first sign-in; cross-tenant refused; concurrency (two admins) ; HTTP permission tests | One migration (pending folder until released, like 0089) |
| 7 | Bulk import | list in section 7 | New dependency decision first |
| 8 | Duplicate-staff report and merge tool | candidates, hard/soft match, merge atomicity, audit, tenant isolation | Read-only report first |

Each PR: reuse canonical code, run the repository's real `pnpm lint`, `pnpm typecheck`, `pnpm test` (and the DB and API suites for SQL work), phone-width check, then **demo.ogevia.com only**, following `docs/TESTING_AND_RELEASE_PROCESS.md` with the owner's go for each demo deployment. Migrations are applied to demo (`ogevia_sv_test`) only through the approved operator procedure; I cannot run AWS commands from here, so each demo deployment is prepared as an operator package and not claimed as deployed until the owner reports the result.

## 10. Owner answers (2026-11-10) and what remains

| Decision | Answer | Effect |
|---|---|---|
| 1 Override vs 0089 | **Agreed.** Implement the override; withdraw unreleased 0089. | PR 6. 0089 is not released. Administrators only (recommended default stands unless the owner objects). |
| 2 Deployed commit | OK to build on the `757a5e4` line. | Items 4 and 9 stay marked unconfirmed until the real commit is known. |
| 3 XLSX library | **Agreed**: CSV and XLSX; library `exceljs` (version and advisories re-checked at install). | PR 7. |
| 4 Standard CPR/TB values | **Not sure.** The October brief says "do not invent legal expiry periods; unset rules = incomplete". So the button will **not** pre-fill any validity period. | "Use standard CPR and TB" creates the two document types named **CPR** and **TB** only, then asks the administrator to enter each validity rule (required; no default). The rule stays "incomplete" until entered. |
| 5 Production error line | **Not sure.** | PR 1 ships the web half only; the SQL half stays open (audit section 3). |

### Original questions (kept for the record)

1. **Override vs migration 0089.** Implement today's override (reason, approver, audit, badge) and withdraw the unreleased 0089? **Recommend yes.** Also confirm that only administrators (not managers) may approve by override (recommend administrators only, as for the No Match override).
2. **Deployed commit (packet D0).** Which commit runs on demo.ogevia.com and app.ogevia.com? The audit and the build are based on `757a5e4`; if demo/production differ, items 4 (dashboard blocks) and 9 (Business Compliance) cannot be confirmed. Recommend: send the commit SHA shown in the TEST release record, or the deployed `index.html` asset hash.
3. **XLSX library.** CSV can be parsed with a small, vetted parser or hand-written code with no new dependency. XLSX needs one. Recommend `exceljs` (maintained, reads and writes templates) or `read-excel-file` for read-only; **not** the npm `xlsx` package (known unpatched advisories on the npm line). Version and advisories to be re-checked at install time. Approve CSV first and XLSX behind the same approval, or both together?
4. **Standard CPR/TB setup values.** What document names and validity periods should "Use standard CPR and TB" create for SoCal Care Services? Recommend using the values already agreed in the October readiness records after you confirm them.
5. **Production error for the P0 failures.** One read-only CloudWatch query for `GET /v1/action-issues`, `/v1/attention` and `/v1/notifications` (status and error code), or a read-only DB-window run. Without it the SQL half of PR 1 stays open.

Nothing in this document claims a production result. Local and mockup results do not prove demo or production behavior.
