# Interface simplification and alert severity: release report (2026-10-18)

**Status: IMPLEMENTED and TESTED LOCALLY (synthetic data, local PostgreSQL 16, local harness). PREPARED FOR REVIEW. NOT DEPLOYED. NOT RUN ON THE PILOT/TEST ENVIRONMENT. No AWS setting, live database or live agency record was touched.**

## 1. Baseline and what could not be compared
The request asks for the latest approved five-board specifications as the baseline. **Those files are not in the repository or the connected Drive** (searched in earlier sessions). Nothing here is claimed to match Board 5 Reporting / Billing Readiness or any other board spec, and the older Wave 1 list was not substituted. Needed: the five-board handoff and the per-board specification files.

## 2. Assumptions and decisions
| Item | Assumption |
|---|---|
| Urgent window | **48 hours** (owner decision D10, SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md 15.3; no later change found). A shift or visit starting or running within 48 hours that is blocked or at risk is "Needs attention now"; later uncovered shifts are "Upcoming staffing". One parameter: `get_attention_overview(p_organization_id, p_urgent_hours default 48)`. |
| Uncovered shift vs unscheduled visit | Uncovered shift = a scheduled, not-ended `shifts` row with no caregiver or an unreplaced call-out. Unscheduled visit = a `service_visits` row with no `scheduled_shift_id`; it is a visit to review and is counted only in Visit review. |
| Compliance and imminent work | A shift inside the window whose caregiver is blocked (hold or non-current required document) appears in Needs attention now, linked to the caregiver's compliance record. Shifts beyond the window stay reachable from Documents & compliance, then Caregiver holds. |

## 3. What changed
**Alerts by purpose** (migration `0056_attention_streams_appearance.sql`, rollback `0056_...down.sql`, BACKUP REQUIRED):
- `get_attention_overview` (read-only, role-aware, `null` section = not permitted, never a false zero) returning four streams; `GET /v1/attention/overview`.
- Counts are of unique shifts/visits (`count(distinct id)`); issues are counted apart and labelled "Issues" / "n issues across n items". "Visits needing attention" is unique visits.
- Web: four tiles on Home, each its own page: `/attention` (Needs attention now), `/staffing` (Upcoming staffing, by date), `/documents` (Documents & compliance), `/visit-review` (Visit review). The header badge now counts only Needs attention now; red only for blocked/at-risk care, amber for approaching risk, calm/neutral otherwise; every state has a word and a symbol. The old mixed "Action needed" sum and its list were removed from Home and the header (the old `/v1/attention` endpoint and `action-needed.ts` remain for the exceptions report and are now unused by Home; candidate for later removal).

**Documents & compliance**: cards show name, caregiver, one status label (Current / Expires in n days / Expired n days ago / Overdue n days / Awaiting review / Rejected, replace / Requested), **View** and **Replace**. Reviewer, review time, upload time, version, exact dates and the reminder note are behind a native Details control. Filters: All, Overdue, Due soon, To review (each with a count; "Needs action" removed). Version history and approval rules are unchanged (Replace posts a new version). A strip links to compliance holds.

**Financial section**: no "Unavailable" cards. Values appear only when returned; otherwise a reason ("Nothing approved yet", "No billable hours yet") or nothing. Missing rates produce one message with the count and **Review authorizations** (`/authorizations/rates`, backed by `list_authorizations_missing_rate`, the same set the totals skip). Caregiver cost/margin is not shown (no data source). Definitions are in "What these values mean".

**Other pages**: Hours this month is one card (four figures, a chart, table behind a disclosure); Outage readiness is a compact row; Caregiver holds and the compliance card use the shared header and a disclosure for the deadline rule. Shared parts: `ui/disclosure.tsx`, `ui/page-header.tsx`, `ui/status-chip.tsx`, `ui/chart.tsx`.

**Appearance** (Settings > Appearance, all roles): background (light, warm cream, soft gray, dark), accent (teal, blue, indigo, plum, rust), density, text size, chart type. Agency defaults need `organization.update` (administrator); a person's own choice overrides only their own view; both stored per organization with tenant isolation (`organization_appearance`, `user_appearance`, RLS-style checks in the functions). Applied as `data-og-*` attributes on `<html>` from CSS variables; the last choice is cached per user/agency for first paint, the server is the record. Charts follow the preference only where honest: category data supports bar and donut (parts of a whole); **line is shown as bars with a note** because the app has no time-series data yet.

## 4. Compliance coordination
Migration 0055 is untouched. Holds, flags and enforcement are unchanged; the visual work does not hide affected staffing (Needs attention now, Caregiver holds, the Documents strip).

## 5. Evidence
| Check | Result |
|---|---|
| Database: `infra/aws/db/test/attention-streams.db.test.ts` (12) | window and ordering, called-out and running shifts, past/cancelled excluded, unscheduled visit only in Visit review, unique counts, blocked caregiver = one item/2 issues, in-progress on hold, permissions/nulls, appearance defaults/overrides/isolation/validation, missing-rate list equals the utilisation count |
| API: `apps/sv-api/test/attention-appearance.db.test.ts` (3) | routes and argument validation |
| Web: `interface-simplification.test.tsx` (19), `attention-badge.test.tsx` (13), `styles/theme-contrast.test.ts` (105) | tiles/counts/destinations, tone words and symbols, document labels/filters/details, financial states and rates page, appearance save/override/persist/permissions, charts bar/donut/line fallback, contrast for 4 backgrounds x 5 accents |
| Full gates | see section 7 |

A defect found while testing and fixed: the "rust" accent failed 4.5:1 on tinted surfaces (now 160 72 7); an unsupported chart preference fell back to donut instead of bar; the shared Button ignored the chosen accent (a legacy `:root` value won).

## 6. Screenshots
`screenshots/before` and `screenshots/after`, desktop 1280 and phone 390: Home, Documents, Needs attention now, Upcoming staffing, Visit review, rates, Appearance, Care Team, Caregiver holds, caregiver detail. Horizontal overflow was measured on every page at both widths: none. Dark/cream/gray theme screenshots are NOT captured (gap, below).

## 7. Remaining gaps (not claimed)
- Five-board specs unavailable (section 1). Pilot not run. Real mobile device, screen reader and keyboard-only pass not done; keyboard/touch is by construction (native `<summary>`, radios, 44 px targets) and unit-asserted only.
- Themes other than light/teal are verified by contrast calculation only, not by page-by-page screenshots; legacy pages that still use fixed colours may look uneven in dark.
- Line chart has no data it fits. Density is CSS overrides on common spacing classes.
- Migration numbers 0055/0056 collide with the unmerged branch `claude/determined-goodall-syvv7s`: renumber on merge.
- The 48-hour window is a parameter but not configurable per agency.
- `/v1/attention` and `action-needed.ts` are now dead for Home.
- Pre-existing, unchanged: Home opens on the browser-clock month (known defect F7, `it.fails`).

## 8. Rollback
Common order, then `0056_attention_streams_appearance.down.sql` (BACKUP REQUIRED: drops stored appearance choices). Web: revert the commit; no data depends on the screens.
