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
**Alerts by purpose** (migration `0054_attention_streams_appearance.sql`, rollback `0054_...down.sql`, BACKUP REQUIRED):
- `get_attention_overview` (read-only, role-aware, `null` section = not permitted, never a false zero) returning four streams; `GET /v1/attention/overview`.
- Counts are of unique shifts/visits (`count(distinct id)`); issues are counted apart and labelled "Issues" / "n issues across n items". "Visits needing attention" is unique visits.
- Web: four tiles on Home, each its own page: `/attention` (Needs attention now), `/staffing` (Upcoming staffing, by date), `/documents` (Documents & compliance), `/visit-review` (Visit review). The header badge now counts only Needs attention now; red only for blocked/at-risk care, amber for approaching risk, calm/neutral otherwise; every state has a word and a symbol. The old mixed "Action needed" sum and its list were removed from Home and the header (the old `/v1/attention` endpoint and `action-needed.ts` remain for the exceptions report and are now unused by Home; candidate for later removal).

**Documents & compliance**: cards show name, caregiver, one status label (Current / Expires in n days / Expired n days ago / Overdue n days / Awaiting review / Rejected, replace / Requested), **View** and **Replace**. Reviewer, review time, upload time, version, exact dates and the reminder note are behind a native Details control. Filters: All, Overdue, Due soon, To review (each with a count; "Needs action" removed). Version history and approval rules are unchanged (Replace posts a new version). A strip links to compliance holds.

**Financial section**: no "Unavailable" cards. Values appear only when returned; otherwise a reason ("Nothing approved yet", "No billable hours yet") or nothing. Missing rates produce one message with the count and **Review authorizations** (`/authorizations/rates`, backed by `list_authorizations_missing_rate`, the same set the totals skip). Caregiver cost/margin is not shown (no data source). Definitions are in "What these values mean".

**Other pages**: Hours this month is one card (four figures, a chart, table behind a disclosure); Outage readiness is a compact row; Caregiver holds and the compliance card use the shared header and a disclosure for the deadline rule. Shared parts: `ui/disclosure.tsx`, `ui/page-header.tsx`, `ui/status-chip.tsx`, `ui/chart.tsx`.

**Appearance** (Settings > Appearance, all roles): background (light, warm cream, soft gray, dark), accent (teal, blue, indigo, plum, rust), density, text size, chart type. Agency defaults need `organization.update` (administrator); a person's own choice overrides only their own view; both stored per organization with tenant isolation (`organization_appearance`, `user_appearance`, RLS-style checks in the functions). Applied as `data-og-*` attributes on `<html>` from CSS variables; the last choice is cached per user/agency for first paint, the server is the record. Charts follow the preference only where honest: category data supports bar and donut (parts of a whole); **line is shown as bars with a note** because the app has no time-series data yet.

## 4. Compliance coordination
Migration 0053 is untouched. Holds, flags and enforcement are unchanged; the visual work does not hide affected staffing (Needs attention now, Caregiver holds, the Documents strip).

## 5. Evidence
| Check | Result |
|---|---|
| Database: `infra/aws/db/test/attention-streams.db.test.ts` (12) | window and ordering, called-out and running shifts, past/cancelled excluded, unscheduled visit only in Visit review, unique counts, blocked caregiver = one item/2 issues, in-progress on hold, permissions/nulls, appearance defaults/overrides/isolation/validation, missing-rate list equals the utilisation count |
| API: `apps/sv-api/test/attention-appearance.db.test.ts` (3) | routes and argument validation |
| Web: `interface-simplification.test.tsx` (19), `attention-badge.test.tsx` (13), `styles/theme-contrast.test.ts` (105) | tiles/counts/destinations, tone words and symbols, document labels/filters/details, financial states and rates page, appearance save/override/persist/permissions, charts bar/donut/line fallback, contrast for 4 backgrounds x 5 accents |
| Full gates | see section 7 |

A defect found while testing and fixed: the "rust" accent failed 4.5:1 on tinted surfaces (now 160 72 7); an unsupported chart preference fell back to donut instead of bar; the shared Button ignored the chosen accent (a legacy `:root` value won).

## 6. Screenshots
`screenshots/before` and `screenshots/after`, desktop 1280 and phone 390: Home, Documents, Needs attention now, Upcoming staffing, Visit review, rates, Appearance, Care Team, Caregiver holds, caregiver detail. Horizontal overflow was measured on every page at both widths: none. The four backgrounds were captured for every changed page (see section 9).

## 7. Remaining gaps (not claimed)
- Five-board specs unavailable (section 1). Pilot not run. Real mobile device, screen reader and keyboard-only pass not done; keyboard/touch is by construction (native `<summary>`, radios, 44 px targets) and unit-asserted only.
- Remaining fixed colours: see section 9.
- Line chart has no data it fits. Density is CSS overrides on common spacing classes.
- Migration numbers 0053/0054 collide with the unmerged branch `claude/determined-goodall-syvv7s`: renumber on merge.
- The 48-hour window is a parameter but not configurable per agency.
- `/v1/attention` and `action-needed.ts` are now dead for Home.
- Pre-existing, unchanged: Home opens on the browser-clock month (known defect F7, `it.fails`).

## 8. Rollback
Common order, then `0054_attention_streams_appearance.down.sql` (BACKUP REQUIRED: drops stored appearance choices). Web: revert the commit; no data depends on the screens.

## 9. Visual review round (after the first report)
**Urgent window.** Changed from 24 to 48 hours: owner decision D10 (`docs/product/SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md` 15.3, also `BUILD_GAP_LIST_2026-10-12.md` G15). No later owner decision changing it was found in the repository. Edited in place in 0054 (not deployed). The Board 4 text itself has not been read (section 10).

**Per-user appearance storage (VERIFIED).** `user_appearance` has primary key (organization, user). `set_my_appearance` takes no user argument; the person is the signed-in actor. The application role has no direct access to either table (SQLSTATE 42501). Tests in `attention-streams.db.test.ts`: a manager's saved choice is unchanged by a caregiver's change and by the agency default; the other agency has no rows; agency A's administrator cannot write agency B's defaults and agency B's manager cannot write agency A's (OGN04); a non-member cannot read or write.

**Keyboard-only and touch checks (37 of 37 pass, Playwright against the local harness).** Tab reaches the header badge and each of the four tiles with a visible focus indicator and Enter opens each destination; the Hours details opens with Enter and closes with Space; Review authorizations, the Overdue filter (aria-pressed), View, Replace and Details are reachable and work; Replace opens the upload form; arrow keys move through Appearance choices, Enter on Save applies the choice and it persists after reload; on a phone Enter opens the menu, focus moves to Close, Escape closes it and returns focus. Touch targets: 44 px on the tiles, header badge, filters, View, Replace, Verify, Reject, Upload, Details, Appearance choices and Save at 390 px. Failures found and fixed: badge, View, Appearance choices and Save were 38-40 px.

**Four backgrounds (Light, Warm cream, Soft gray, Dark).** All changed pages were captured at 1280 and 390 px in each and inspected; an automated contrast audit of every visible text element found 0 failures after fixes (10 pages, 4 backgrounds, 2 widths, plus 9 further pages in the merged build). Defects found and fixed: white form fields with light text on Dark (all inputs, selects, textareas); filled accent buttons and chips using white text on the light Dark-theme accent; the secondary grey (slate-500) at 3.9:1 on tinted surfaces; the rust accent; text-slate-400 at 2.2 to 2.6:1 on the Visit records page; navigation area colours and badges (merged build). The disabled "Turn Service checks On" button is below 4.5:1 in every theme, which is its disabled state.

**Remaining fixed-colour problems (NOT fixed).**
- Indigo, violet and rose are now theme variables; other Tailwind families are not (none found in the changed pages).
- `text-slate-400` is still used as text in about 130 places across legacy Supabase-era pages and some components (`components/*`, `pages/*` other than the reports page); it is 2.2 to 2.6:1 on every background.
- The native colour picker in Settings > Branding stays light on Dark (a browser control).
- Environment banner, the agency accent border on the header and agency logos keep their own colours.
- Pages not rendered with seeded data were not inspected visually (for example an active caregiver visit, signature pad and public confirmation pages, which use fixed light styling by design).
- The page-by-page visual inspection covered desktop and phone in all four backgrounds, but not Large text or Compact density combined with each background.

## 10. Five-board OneNote handoff: comparison INCOMPLETE
Not read, so nothing is claimed as matching or differing. Files needed (any of: OneNote export to PDF or DOCX, a `.onepkg` section export, or the pages as images):
1. The handoff index or summary page of the approved five-board OneNote notebook, with its approval note (who approved it, when, which version).
2. One page or section per board, Board 1 to Board 5, including Board 4 (the 48-hour urgent coverage window) and Board 5 Reporting / Billing Readiness.
3. Every mockup, screenshot or attachment embedded in those pages.
4. Any change log or decision list after the approval date, so a later owner decision can be told from the baseline.
5. If boards were revised after handoff: the superseded version, to avoid comparing against the wrong one.
Until then, the only evidence for 48 hours is D10 in the repository.

## 11. Migration collision with `claude/determined-goodall-syvv7s`
Latest target `main` is at 0052 (`d82fefc`). `claude/determined-goodall-syvv7s` (scheduling patterns, hour limits, make-ups = 0053; recruiting and onboarding = 0054) is unmerged and collides with this branch (compliance = 0053; attention and appearance = 0054). No other remote branch has a migration above 0052.
A trial merge was made locally on `integration/compliance-attention-onto-scheduling-recruiting` (NOT pushed, NOT merged into any shared branch): their 0053 and 0054 keep their numbers; this branch's become **0055 compliance** and **0056 attention and appearance**. Renumbering alone was not enough: all three releases redefine `readiness_checks`, `readiness_outcome` and `readiness_message` and the series skipped-reason constraint, so the later migration silently drops the earlier one's logic. 0055 was rebuilt by a three-way merge so the gate carries hour limits (0053), the onboarding gate (0054) and the background and 14-day rules (0055); the skipped-reason list is the union; the 0055 rollback restores the 0054 gate. New test `merged-gate.db.test.ts` proves all three rules report together and that rolling back 0055 and 0056 leaves hour limits and onboarding enforced. Migration order verified: 0001 to 0056 contiguous, the runner applies 0050 to 0056 in order, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test:all` pass on the merged tree (web 961, database 60 files, sv-api 72). Conflicts resolved in the web app: the left navigation was replaced by the other branch's right-hand navigation, then the Needs attention badge, the Appearance link, "Documents & compliance" and theme tokens were re-applied.
