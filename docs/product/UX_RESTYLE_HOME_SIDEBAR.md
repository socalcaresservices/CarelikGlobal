# Sidebar and Home restyle: hand-off (6 October 2026)

Presentation only. No query, calculation, count, route, permission or business rule was changed.
Branch `claude/vibrant-sagan-rn9z58`, based on `claude/ogevia-action-needed-filters` (a17eb7c). Not merged, not deployed.

## Read first
1. **Base branch.** `main` holds the older Supabase app: it has no Home with Hours this month, Reminders or Outage readiness. The AWS product is on `claude/ogevia-action-needed-filters`, so the work is based there.
2. **The navigation was not horizontal on that branch.** It was a header link row that wrapped (hamburger below 768px). It is now a sidebar.
3. **The approved light-teal screenshot was not attached to this session.** Layout follows the written specification only. Compare against the screenshot before approving.
4. **No earlier "shorter wording" instruction exists in the repo.** The nearest are `docs/product/OGEVIA_UX_CHANGE_LIST.md` ("keep established module names; no wholesale renaming") and the owner decision of 2026-10-06 in `PILOT_SCOPE_RECONCILIATION.md` item 13. No label was renamed.

## Files changed
- `apps/web/src/aws/aws-shell.tsx`: sidebar, drawer, collapse, tooltips, user block.
- `apps/web/src/aws/nav-model.ts` (new): groups and current-link logic.
- `apps/web/src/aws/home-page.tsx`: layout and styling.
- `apps/web/src/aws/continuity-page.tsx`: the continuity banner is now the "Outage readiness" panel (same text, same link).
- `apps/web/src/index.css`, `apps/web/tailwind.config.ts`: fonts and palette tokens.
- `apps/web/package.json`, `pnpm-lock.yaml`: `@fontsource-variable/plus-jakarta-sans`, `@fontsource/ibm-plex-mono` (self-hosted in the build; verified no font-CDN request).
- `apps/web/src/aws/sidebar-home.test.tsx` (new, 12 tests).
- Screenshots: `docs/product/evidence/2026-10-06/ux/`.

## Checklist
| # | Requirement | Outcome |
|---|---|---|
| 1 | Preserve working system | All 115 existing AWS tests pass unchanged. Every Home element, link target and permission check is the one that existed. |
| 2 | Labels | No renames (see label decisions). Accessible names unchanged. |
| 3 | Sidebar 256/76px, remembered, drawer <768px, tooltips, names | Done. Verified in Chromium: collapse persists across reload; Escape closes the drawer and returns focus; Tab is trapped in the open drawer; icon-only items keep accessible names; tooltip dismisses with Escape. |
| 3 | Groups TODAY/VISITS/BILLING/PEOPLE/SETUP | Done. Caregiver-only items: My shifts, Availability in TODAY; My documents in PEOPLE. Reports and Client monthly calendar added in VISITS as links to the existing reports route (`?view=overview`, `?view=calendar`). |
| 3 | Sidebar contents | Logo/collapse, agency card (name and logo from branding), groups, view label, name, email, Profile, Sign out. No hard-coded agency name. Environment chip appears only if `VITE_APP_ENV` is `test` or `development` (see UNKNOWN below). |
| 4 | Home layout | Header (title, Action needed count, month), Hours this month with the four KPIs and the 7-column table, Financial impact, two columns (Action needed rows; Reminders with dashed border, then Outage readiness). Content max 1180px. Attention rows render from the data. |
| 4C | Financial split | Verified in code and `ACCESS_AND_BILLING_VISIBILITY.md`: only `billing.read` (Administrator) gets dollar values; the server returns null to managers; test covers both. No conflict found. |
| 5 | Reports, calendar, print | Exist: Reports page has "Client monthly calendar" and "Print / Save as PDF" (print stylesheet with agency letterhead; not a raw page print). Now reachable from the sidebar. Sidebar, top bar and left padding are hidden in print (class-level test). |
| 6 | Clear records and actions | Home only. Other pages were not restyled; their Submit/Cancel/Approve/Correct controls are untouched. |
| 7 | Style | Applied. Deviation: see contrast. |
| 8 | Verify | Below. |

## Contrast deviations (owner review)
- Zero counts `#9AABB1` on white is 2.38:1 and unavailable `#8A9CA2` is 2.85:1 (both below 4.5:1). Both now use `#5C727B` (5.06:1); unavailable text is also italic.
- `#19A69C` and `#9ED9D3` are used only for dots and bars, never text.

## Verification
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (web 670 tests, sv-api 58, infra-aws 106), `pnpm build`: all exit 0.
- Real Chromium at 1440, 1024 and 390px with faked Cognito/API (synthetic data): no horizontal page scroll; fonts load locally; the service table scrolls inside its own region at 390px.
- NOT VERIFIED: actual print output after the shell change (only classes tested); screen-reader behaviour; real touch devices; a deployed environment.

## Functional gaps (not styling)
1. No standalone **Authorisations** route exists in the AWS build. Authorisations are per client (Client detail) and the Services page. No link was invented.
2. Choosing a report in the Report dropdown does not change the URL, so the sidebar highlight can lag (Visit records vs Reports). Existing behaviour.
3. No Ogevia logo image exists in the repository. The sidebar uses a text wordmark with an "O" tile.
4. **Reports/Calendar discoverability** relies on the shared reports page; no new report was built.

## Label decisions for the owner
- Task text says "Needs Attention"; the latest recorded decision (2026-10-06) is **"Action needed"**. Kept "Action needed".
- Task says "Reminders (not counted above)". The panel is beside, not below, the list, so the existing "Reminders (not in the Action needed total)" was kept.
- "Hours this month (utilization)" and "Financial impact (Administrator only)" kept as they were (task and screenshot may say "Hours this month" and "owner").
- "Client monthly calendar" is the existing report name; "Reports" is the new link label.

## UNKNOWN
- Whether the AWS TEST build sets `VITE_APP_ENV`; if not, no environment badge shows. No synthetic-data badge setting exists in the AWS build.
