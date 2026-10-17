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

**Appearance** (Settings > Appearance, all roles): background (light, white, soft gray, dark), layout (standard, minimal), accent (teal, blue, indigo, plum, rust), density, text size, chart type. Agency defaults need `organization.update` (administrator); a person's own choice overrides only their own view; both stored per organization with tenant isolation (`organization_appearance`, `user_appearance`, RLS-style checks in the functions). Applied as `data-og-*` attributes on `<html>` from CSS variables; the last choice is cached per user/agency for first paint, the server is the record. Charts follow the preference only where honest: category data supports bar and donut (parts of a whole); **line is shown as bars with a note** because the app has no time-series data yet.

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
`screenshots/before` and `screenshots/after`, desktop 1280 and phone 390: Home, Documents, Needs attention now, Upcoming staffing, Visit review, rates, Appearance, Care Team, Caregiver holds, caregiver detail. Horizontal overflow was measured on every page at both widths: none. The four backgrounds were captured for every changed page (see section 9).

## 7. Remaining gaps (not claimed)
- Five-board specs unavailable (section 1). Pilot not run. Real mobile device, screen reader and keyboard-only pass not done; keyboard/touch is by construction (native `<summary>`, radios, 44 px targets) and unit-asserted only.
- Remaining fixed colours: see section 9.
- Line chart has no data it fits. Density is CSS overrides on common spacing classes.
- Migration numbers 0055/0056 collide with the unmerged branch `claude/determined-goodall-syvv7s`: renumber on merge.
- The 48-hour window is a parameter but not configurable per agency.
- `/v1/attention` and `action-needed.ts` are now dead for Home.
- Pre-existing, unchanged: Home opens on the browser-clock month (known defect F7, `it.fails`).

## 8. Rollback
Common order, then `0056_attention_streams_appearance.down.sql` (BACKUP REQUIRED: drops stored appearance choices). Web: revert the commit; no data depends on the screens.

## 9. Visual review round (after the first report)
**Urgent window.** Changed from 24 to 48 hours: owner decision D10 (`docs/product/SCHEDULING_DASHBOARD_REVIEW_PACKAGE_2026-10-12.md` 15.3, also `BUILD_GAP_LIST_2026-10-12.md` G15). No later owner decision changing it was found in the repository. Edited in place in 0056 (not deployed). The Board 4 text itself has not been read (section 10).

**Per-user appearance storage (VERIFIED).** `user_appearance` has primary key (organization, user). `set_my_appearance` takes no user argument; the person is the signed-in actor. The application role has no direct access to either table (SQLSTATE 42501). Tests in `attention-streams.db.test.ts`: a manager's saved choice is unchanged by a caregiver's change and by the agency default; the other agency has no rows; agency A's administrator cannot write agency B's defaults and agency B's manager cannot write agency A's (OGN04); a non-member cannot read or write.

**Keyboard-only and touch checks (37 of 37 pass, Playwright against the local harness).** Tab reaches the header badge and each of the four tiles with a visible focus indicator and Enter opens each destination; the Hours details opens with Enter and closes with Space; Review authorizations, the Overdue filter (aria-pressed), View, Replace and Details are reachable and work; Replace opens the upload form; arrow keys move through Appearance choices, Enter on Save applies the choice and it persists after reload; on a phone Enter opens the menu, focus moves to Close, Escape closes it and returns focus. Touch targets: 44 px on the tiles, header badge, filters, View, Replace, Verify, Reject, Upload, Details, Appearance choices and Save at 390 px. Failures found and fixed: badge, View, Appearance choices and Save were 38-40 px.

**Four backgrounds (Light, then Warm cream, since replaced by White; Soft gray; Dark).** All changed pages were captured at 1280 and 390 px in each and inspected; an automated contrast audit of every visible text element found 0 failures after fixes (10 pages, 4 backgrounds, 2 widths, plus 9 further pages in the merged build). Defects found and fixed: white form fields with light text on Dark (all inputs, selects, textareas); filled accent buttons and chips using white text on the light Dark-theme accent; the secondary grey (slate-500) at 3.9:1 on tinted surfaces; the rust accent; text-slate-400 at 2.2 to 2.6:1 on the Visit records page; navigation area colours and badges (merged build). The disabled "Turn Service checks On" button is below 4.5:1 in every theme, which is its disabled state.

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
A trial merge was made locally on `integration/compliance-attention-onto-scheduling-recruiting` (pushed for safekeeping, NOT merged into any shared branch, nothing deployed): their 0053 and 0054 keep their numbers; this branch's become **0055 compliance** and **0056 attention and appearance**. Renumbering alone was not enough: all three releases redefine `readiness_checks`, `readiness_outcome` and `readiness_message` and the series skipped-reason constraint, so the later migration silently drops the earlier one's logic. 0055 was rebuilt by a three-way merge so the gate carries hour limits (0053), the onboarding gate (0054) and the background and 14-day rules (0055); the skipped-reason list is the union; the 0055 rollback restores the 0054 gate. New test `merged-gate.db.test.ts` proves all three rules report together and that rolling back 0055 and 0056 leaves hour limits and onboarding enforced. Migration order verified: 0001 to 0056 contiguous, the runner applies 0050 to 0056 in order, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test:all` pass on the merged tree (web 961, database 60 files, sv-api 72). Conflicts resolved in the web app: the left navigation was replaced by the other branch's right-hand navigation, then the Needs attention badge, the Appearance link, "Documents & compliance" and theme tokens were re-applied.

## 12. Visual direction approved; White replaces Cream; Minimal layout (presentation only)
**Owner decision (this round):** the visual direction is approved. Cream is replaced by **White**, and a **Minimal** layout is added. Both are presentation only.

- **White, not a copy of Light.** Light keeps its tinted page (244 247 247), teal-tinted sidebar and lines. White is a pure white page and card (255 255 255) with a neutral sidebar (246 248 249) and stronger lines (208 216 222) so white cards stay distinct. `theme-layout.test.ts` fails if any two backgrounds share the same page, card, side and line tokens, or if White's page, side or line equal Light's. Contrast (4.5:1 text, accent, chart marks) is checked for White against every accent like the other backgrounds.
- **Cream is gone before release.** Migration 0056 is not deployed, so its allowed values were changed in place (`light, white, gray, dark`); no stored value needed converting. A test refuses `cream` at the database and API; a cached browser value `cream` is ignored and the saved server value applies.
- **Minimal layout** (`layout` = `standard` | `minimal`, stored per agency default and per person, same rules as the other choices: administrator sets the agency default, each person's own choice overrides only theirs, isolated by agency). It flattens boxes (no fill, rounding or side and top borders; one hairline under each group) and adds spacing between sections. It never hides, clips or shrinks anything. Elements carrying a status (red, amber, emerald, sky borders or fills), form fields, buttons and images are excluded, so alerts keep their emphasis.

**Proof that nothing is lost when switching** (`verification/switch-check.mjs`, results in `verification/switch-check-results.json`, local harness, synthetic data):
- 11 pages x desktop and phone x 8 combinations (4 backgrounds x 2 layouts) against the Light and Standard baseline = **1072 checks, 1072 pass.** Per combination: identical text (including closed details), identical controls and states, identical alerts, tiles, badges and status symbols; nothing newly hidden; red and amber items keep border and fill; no text under 4.5:1 (3:1 large); no sideways scroll.
- Unsaved input: a typed review reason keeps its value, its keyboard focus and its identical element through all 8 switches at both widths. In the app test (`interface-simplification.test.tsx`, "switching background or layout changes presentation only") the change arrives through the real path (server answer, cache refresh, applier) with a typed review reason, a typed date and a chosen filter on screen; all 8 combinations keep every word, control, alert, symbol and character, on the same elements. A third test proves saving My view leaves an unsaved Agency defaults draft untouched.
- The check can fail: with a hidden heading and a stripped alert border injected, it fails on every Minimal combination. A first version missed the hidden heading (a hidden element was treated as screen-reader-only); that was fixed before the final run.
- Stylesheet guard: `theme-layout.test.ts` allows only border, fill, rounding, shadow and spacing properties in the Minimal rules and rejects display, visibility, opacity, clipping, overflow, size, font, colour, position and line-clamp.

**Limits.** The switch is verified at the one point the app uses (the data attributes on the page element) and through the in-app refresh path; a setting change made on another page is not live on an open page until it is reloaded (unchanged behaviour). Large text and Compact density were not combined with each of the 8 combinations in the browser check. Minimal does not collapse the navigation (that would remove group headings from the page).

## 13. Pre-merge review round (Large text, Compact density, migration safety, push safety)
**Scope statement for the "checks passed" figures.** They describe exactly what was run and nothing wider. They are not evidence that no item can ever be missed, hidden or mis-sized.
- **First run (White and Minimal):** 1072 of 1072 checks, 11 pages, desktop 1280 px and phone 390 px, 8 combinations (4 backgrounds x 2 layouts), compared with the Light + Standard baseline.
- **Extended run (this round):** 6400 of 6400 checks on the integration branch at `d049fca`, same 11 pages and two widths, **32 combinations** (4 backgrounds x 2 layouts x text Standard/Large x density Comfortable/Compact). Script `verification/switch-check-extended.mjs`, results `verification/switch-check-extended-results.json`.
- **Pages covered:** Home, Needs attention now, Upcoming staffing, Documents & compliance, Visit review, Authorizations without a rate, Appearance, Caregiver holds, Care Team list, caregiver detail (compliance card), Scheduling. **Not covered:** Recruiting, Billing review, Reports and Visit records, Services, Accounts, Continuity, Settings, the caregiver's own screens (Verify visit, My shifts, availability), the public confirmation and care-request pages, the signature pad, dialogs and the open phone menu, empty, loading and error states, print, other browsers (Chromium only), browser zoom, tablet widths, real devices and screen readers, the Manager and caregiver role views (the run signs in as the Administrator), and data volumes beyond the seeded demo records.
- **Checks per page and combination:** same words (including text in closed details); same controls and states; same alerts, tiles, badges and status symbols; nothing newly hidden; red and amber items keep border and fill; no text below 4.5:1 (3:1 large) and no sideways scroll; no control or alert pushed off the screen, no newly truncated text; no non-inline control shorter than in the Standard layout (minimum 44 px on a phone, 40 on desktop); no text below 11 px; typed unsaved text keeps its value, focus and its very element (Documents page, review reason) in all 32 combinations at both widths.
- **Sensitivity:** with deliberate faults injected (a 40 px-wide truncated heading under Large text, a 20 px clipped tile under Compact, a hidden heading, a stripped alert border) the checks fail on the affected combinations.
- **First extended run:** 16 failures, all the same kind: an inline link inside a sentence changed height because its line wrapped differently (Caregiver detail under Compact, Scheduling under Large). Inline links are exempt from the minimum target size (WCAG 2.5.8 inline exception), so the check now skips inline elements; nothing was hidden, truncated, unreadable or lost. No product code changed.

**Migration edited in place: what is and is not established.** The runner records a SHA-256 for every applied migration and refuses to continue if an applied file changed. Editing a migration is therefore safe only if no database has applied the old text.
- VERIFIED in the repository: `main` and every other remote branch except the two below stop at 0052; only `claude/ogevia-test-deployment-verify-5xqjsa` and the local integration branch contain the compliance and attention/appearance migrations; no release plan, checklist, script or deployment record names them; the latest recorded TEST ledger is `52|0052` (owner-reported 2026-10-16, `docs/releases/2026-10-16-test-web-release/README.md`).
- NOT VERIFIABLE from here: the live TEST and production ledgers (no AWS access), other people's local databases, and anyone who applied the earlier text from this branch's pushed history (commits `a412c48` onward contain earlier versions of 0056).
- If a database has applied an earlier text, the runner refuses (checksum drift) rather than corrupting data; the integration branch also renumbers compliance to 0055 and attention/appearance to 0056 and rewrites 0055 to carry scheduling and recruiting rules, so the same applies there.
- **Required before merge (read-only, operator):** `select version, checksum from ogevia_meta.schema_migrations where version >= '0053' order by version;` on TEST and on production. Expected: no rows. Any row: stop; ship the changes as new migrations instead of editing.
- **TEST ledger: CHECKED. OPERATOR-SUPPLIED EVIDENCE (from the actual CloudShell output, supplied 2026-10-17; this session did not run it and did not see the raw output).**
  - Script extracted from commit `4881611c7b25431368c3ccd7c05357bbdbc2dbbf`; SHA-256 verified as `f96c06f2c4f20d4c85871baad84cdc8726fb2183e138cd1ac7cd6d15bef85f6f` (equal to the checksum recorded for that commit in this repository).
  - Command: `OGEVIA_EXPECT_HOST_IP=10.20.132.179 bash ~/ledger-check-temp-access.sh test --host-ip`. Run timestamp: 2026-10-17T16:29:27Z.
  - Connected database: `ogevia_sv_test`; `read_only=on`.
  - **Result: 52 migrations applied, latest 0052, no rows with version >= 0053.**
  - The run reported both `ogevia_sv_test` and `ogevia_prd` present on the RDS instance. **The production database therefore exists; its ledger was not queried and remains unchecked.**
  - Cleanup reported RESTORED, with the original full rule-set hash restored (the script's own verification).
  - Follow-up AWS listing (separate read-only check) showed only `sgr-088d9ee71c4b0244d`: source `sg-064ffce3bcbe8eb3b`, TCP 5432, no CIDR rule. That matches the repository record of the RDS group's original configuration.
  - Consequence: **for TEST, nothing in the unreleased migrations (0053 onward) had been applied at 2026-10-17T16:29:27Z, so editing those unreleased files in place does not conflict with the TEST ledger as of that time.** It is a point-in-time read of one database.
- **Production ledger: OUTSTANDING. NOT checked.** `ogevia_prd` EXISTS (reported by the TEST run), but whether it has applied any version >= 0053 is unknown. Until it is read, the in-place-edit question is open for production, and so are other people's local databases. No production window is approved. No merge or deployment is approved or has happened.

**Push safety: PARTLY ESTABLISHED, PARTLY UNVERIFIED (corrected).** Repository inspection shows one workflow, `.github/workflows/ci.yml`: it runs on pull requests and on pushes to `main` only, has a read-only token, uses no AWS credentials and only uploads a bundle to the CI run. Deployments in this repository are manual operator scripts. **Repository inspection cannot establish what externally configured services do when a branch is pushed**, and no such configuration is stored in the repository. UNVERIFIED: Netlify (whether the site is linked to this repository, branch deploys, deploy previews, build hooks, which branches build; `netlify.toml` defines a `deploy-preview` context, which suggests previews are in use at least for pull requests), GitHub-side settings (webhooks, installed GitHub Apps, rulesets), and anything configured in AWS outside the repository's stacks (EventBridge rules, CodeStar connections). The integration branch was pushed before these were checked. Read-only checks for the owner: Netlify, Deploys list for the push times and Site configuration, Build and deploy, Branches and deploy contexts; GitHub, Settings, Webhooks and GitHub Apps, and the Actions runs for the branch; AWS, a list of EventBridge rules and CodeStar connections (list and describe calls only).

**Five-board comparison: COMPLETED against `a9a7d2ee71b6dbb90f194b28ffc16f279251d701` on 2026-10-17; full record in `FIVE_BOARD_COMPARISON.md`.** The approved handoff (6 pages) was supplied and compared with the integration tip, not only `024b4ac`. Result: 88 requirement IDs: 13 IMPLEMENTED, 46 PARTIAL, 12 MISSING, 13 CONFLICT, 4 UNVERIFIABLE. Twelve design-vs-code conflicts are listed with evidence (Home cards and quick actions; severity words; 60-minute vs 48-hour client confirmation; no 24 h / 48 h escalation rules; remaining hours clamped at zero; no 80/95/30-day tiers; hour limits warn-only; recurring series refused by default; billing state labels, Voided not visible; Ready for Approval counted in the Visit review tile; caregiver self-claim). Nine owner decisions are listed; none has been made. The comparison is static (nothing run) and does not authorize any code change, merge or deployment.

## 12. Reconciliation batch 1 (owner direction 2026-10-17): Home additions and the severity vocabulary
**Status: IMPLEMENTED and TESTED LOCALLY on the integration branch (synthetic data, local harness). NOT DEPLOYED. NOT RUN ON TEST/PILOT. Not merged.** The owner's instruction was cut off after requirement 2 ("Keep routine ..."); requirements 3 onward, and the end of 2, were not received. Only what was received was built.

**Verified before changing code (against `a9a7d2ee`):** the four Home tiles and the Urgent/Soon/Routine words (`attention.ts`, `home-page.tsx`); that Home had no Today's visits list, quick actions, last-updated or Refresh; that the server marks every uncovered shift inside the 48-hour window red (migration `0056`); `/v1/shifts?from&to` already returns what a Today's list needs.

**What changed (web only; no migration, no API, no database change):**
- Severity: Critical / Urgent / Routine everywhere (`TONE`); "Soon" removed. A shift whose only problem is that nobody covers it is **Critical from its start time and Urgent before it** (inside 48 h); Upcoming staffing (beyond 48 h) is never urgent and its amber 72-hour rule is gone. Other items (a caregiver on a hold, a document problem, a visit open too long) keep the server's severity: red is Critical, amber is Urgent. The time used is the server's `asOf`, not the browser clock. Needs attention now is ordered Critical first, then soonest. The rule is computed in the web app from fields the server already returns, so `0056` is untouched (the production ledger is still unchecked; see section 7).
- Home keeps the four-stream structure, White background, Minimal layout and appearance preferences. Added, compactly: a Today's visits list (upcoming and running visits, soonest first, at most six, time, client, caregiver, a status word, View all); exactly three quick actions (Schedule Visit, Find Client, Resolve Coverage), each shown only to someone permitted; "Updated <server time>" with Refresh, which becomes Retry and shows a plain warning when a refresh fails or the figures are older than 10 minutes. A failed load is never shown as zero. The actions open existing workflows: `/schedule?add=1`, `/clients?find=1`, `/schedule?coverage=1`.
- Files: `attention.ts`, `attention-pages.tsx`, `home-page.tsx`, new `home-extras.tsx`, `home-data.ts`, `agency-clock.ts`, `schedule-page.tsx`, `clients-page.tsx`, tests (`attention-severity.test.ts` and `home-today.test.tsx` are new; four existing tests updated for the new words and the amber/red split).

**Evidence:** web suite 103 files / 1001 tests passed (969 before; 32 new); `pnpm lint`, `pnpm typecheck`, `pnpm build` passed. Home check in a real browser (Chromium, local harness, Manager persona): 98 of 98 checks passed at 1280 px and 390 px across White+Minimal, White+Standard, Light+Standard, Soft gray+Minimal and Dark+Standard (no sideways scroll, three actions of the right height and inside the viewport, four streams, Today's visits present, Refresh re-reads the overview, each action lands where intended, no "Soon"). For the populated list the browser was given synthetic shifts for the Today's query only (the seeded data had none left today); nothing was written. Appearance matrix on the changed pages (Home, Needs attention now, Upcoming staffing, Visit review, Appearance, Schedule): **3456 of 3456 checks passed** (4 backgrounds x 2 layouts x 2 text sizes x 2 densities, desktop and phone, Administrator): nothing lost or hidden when switching, contrast, targets, no sideways scroll. The documents unsaved-input check was not re-run (the page is unchanged and the seeded data lacks a document awaiting review). Not run: `pnpm test:all` (database and API suites; no database or API code changed), mobile on a real device.

**Ambiguities documented, not decided (owner to confirm):**
1. Items that are not "no caregiver" (hold, document problem, visit open past its end) keep the server's severity; the Critical-after-start rule was applied to uncovered shifts only, as instructed. A shift blocked by a hold that starts tomorrow is still Critical.
2. "Documents & compliance" turns amber with the word **Urgent** (it was "Soon"); Board 4 has no rule for it.
3. Today's visits shows the client's name where the schedule already does, the code otherwise.
4. Home keeps Hours this month, Financial impact and Outage readiness below the new sections; Board 1 does not list them.
5. The text after "Keep routine" in requirement 2 and requirements 3 onward are unknown.
Open design conflicts from `FIVE_BOARD_COMPARISON.md` that this batch did **not** touch: 60-minute vs 48-hour client confirmation, the 24 h / 48 h escalation rules, remaining hours clamped at zero, the 80/95/30-day tiers, hour-limit default, recurring-series default, billing state labels, Ready for Approval in the Visit review tile, caregiver self-claim.

## 13. Reconciliation batch 2 (owner direction 2026-10-17): requirements 2 (completed), 3, 4, 5
**Status: IMPLEMENTED and TESTED LOCALLY on the integration branch (synthetic data, local harness and local PostgreSQL 16). NOT DEPLOYED. NOT RUN ON TEST/PILOT. Not merged. Not pushed** (see "Push safety" in section 11: Netlify, GitHub-app and AWS-side triggers are unverified, so this batch stays local). No AWS change, no live agency record touched. Requirements 6-10 have not been received.

### Owner directive, recorded (2026-10-17; these are owner-defined rules, not verified legal or payer requirements)
- Routine staffing, document reminders, Pending Confirmation and Ready for Approval stay separate from urgent problems.
- Uncovered shift: Critical at or after its start, Urgent within 48 hours, Upcoming beyond 48 hours.
- Compliance-blocked future shift follows the same timing (Upcoming beyond 48 h, Urgent within 48 h, Critical at/after start while unresolved). The caregiver's hold is enforced immediately regardless of the display severity (the migration 0055 gate is untouched).
- Overdue documents belong under Documents & compliance and say "Overdue", not "Urgent". The affected care escalates separately when the document blocks a shift.
- A server red status is not automatically Critical; one rule set is applied in the backend response, the counts, the filters and the screens.
- Pending Confirmation escalates 48 h after the visit ends. Administrator review is queued immediately and escalates after 24 h. Routine document review escalates after 48 h, sooner if it blocks care or the document is expired. Routine counts do not inflate urgent totals.
- Authorization balances are never silently clamped; the real over-limit amount is shown and reconciles across Home, client, scheduling and reports. Reservation accounting, approved adjustments and concurrency protection are preserved.
- Tiers: Healthy below 80%, Near Limit 80% to below 95%, Critical 95% and above; a separate expiry warning within 30 days. Utilization is the approved committed definition: billable + approved rounding adjustments + reserved.

### What changed (backend and web)
- **Migration 0057** (`authorization_tiers_unclamped_balances`, with `.down.sql`): `ogevia.authorization_tier()` (integer arithmetic, so 95.0% is exactly Critical and 79.99% is Healthy); `list_monthly_service_summary` and `get_utilisation_overview` recreated with committed, over-limit, utilization, tier and expiry fields; per-authorization remaining is signed; `confirm_service_visit` stores the signed balance; `create_shift` / `reschedule_shift` say "already X over its limit" when negative. Error code OGC09 and the lineage lock are unchanged. The billable cap (`least(worked, cap - prior)`, floored at zero) is deliberately kept: you cannot bill beyond the authorization, but the excess is now visible instead of hidden.
- **Migration 0058** (`attention_tiers_separate_queues`, with `.down.sql`): `get_attention_overview` rewritten; urgent items carry a `tier` (critical or urgent) and the counts; Upcoming includes blocked shifts beyond 48 h; Documents add `reviewRoutine` / `reviewOverdue`; Visit review adds `pendingConfirmation`, `confirmationOverdue`, `reviewOverdue`; Ready for Approval stays separate and null without billing. The legacy sidebar summary now uses the 48 h rule. Rules live in `ogevia.attention_rule_hours` (48 / 24 / 48).
- Both are NEW migrations, not edits of 0056, because the production ledger is unchecked. Rollback order: down 0058, then 0057, before 0056.
- **Web:** server tier preferred over the legacy fallback; Documents chip "Overdue" / "Needs action"; Visit review chip "Urgent" (admin review at 24 h) / "Overdue" (confirmation at 48 h); a "Needs a decision" list separated from "Routine follow-up (not counted above)"; "Over by X" instead of 0 on Home, client page, scheduling summary, reports (new Authorization status column and CSV columns), continuity pack; tier and expiry badges on the client page.

### Evidence (local, synthetic data)
- New DB tests: 14 (`authorization-tiers.db.test.ts`) and 17 (`attention-tiers.db.test.ts`), covering the 79/80/94/95 boundaries, zero authorization, 30/31-day expiry, 47h59/48h00/48h01 and at-start timing, hold enforcement, permissions and cross-tenant isolation. sv-api DB tests extended for tiers, signed balances and the 48 h sidebar rule.
- Web: 105 files, 1021 tests passed. `pnpm lint`, `pnpm typecheck`, `pnpm build` passed.
- Browser (Chromium, local harness, migration 0058): Home 98/98; appearance matrix 3456/3456; seven pages (Home, Needs attention, Upcoming staffing, Visit review, client detail, Schedule, Appearance) in White+Minimal and Dark+Standard at 1280 and 390 px, 68/68 (no sideways scroll, no error screen; client page tier and expiry badges and "Over the limit 2 hr 10 min" on synthetic balances injected in the browser only, nothing written).
- Full DB and sv-api results: see the final report of this batch.

### Ambiguities decided by me, owner to confirm
1. A shift exactly 48 h away is Upcoming.
2. Visit review chip words: Urgent (admin review 24 h), Overdue (confirmation 48 h).
3. "Blocks care" for a document means the caregiver has an unresolved document flag on an upcoming scheduled shift.
4. Time administrator review was entered: client confirmation time, else the visit's creation time (no dedicated column).
5. Hours-left totals add unused time only; overage is reported separately (authorized - committed = hours left - over limit).
6. The caregiver Start Visit screen's remaining-time estimate in the browser was left as is.
7. Stricter payer or agency deadlines are not modelled.
Not verified: real AWS behaviour, Netlify and other triggers, the production ledger.
