# Sidebar, Home and UX review: status, evidence and checklist

Updated 7 October 2026 (third round). **The full product is not marked complete.** Branch `claude/vibrant-sagan-rn9z58`. Not merged, not deployed, no migration applied anywhere except disposable local test databases. Screenshots (synthetic data) are in `docs/product/evidence/2026-10-06/ux/` (01 to 06 and 24 to 30 are from this round; 07 to 23 are earlier captures of pages this round did not change, taken before the environment banner existed).

Related: `OMITTED_BRANCHES_COMPARISON.md`, `PENDING_RESTORATION.md` (CareScore, skills, services, cities, incidents and the other omitted features, with an ordered plan), `RELEASE_0037_0038_RUNBOOK.md` (deployment and rollback steps), `PROPOSAL_LETTERHEAD_AND_ENV_MARKER.md` (the original proposals, now built).

## 1. Two kinds of evidence: keep them apart

**A. Simulated-data checks (what has been done).** Disposable local PostgreSQL 16, jsdom unit tests, and a production web build opened in Chromium with faked sign-in and faked API answers (all synthetic). They show the code does what it should given those inputs.

**B. Deployed verification (what has NOT been done).** Nothing in this round has been run against AWS TEST. The deployed commit is still unverified: the last deployment on record is release 0036 at `7b1236d` (owner-reported 14/14, 2026-10-05); Git history supports `claude/ogevia-action-needed-filters` as the base, but history is not proof of what is running. Not verified on a deployed system: any migration, the new route, the web build, `config.json`, real printing, real phones.

## 2. Requirement checklist

| # | Requirement | Code | Simulated-data check | Deployed check |
| --- | --- | --- | --- | --- |
| 1 | Preserve the working system | Done | All existing tests still pass | Not done |
| 2 | Titles and labels | Applied as approved. "Other actions" kept (Correct visit plus a link to Billing review, which is not an approve action) | Tests | Not done |
| 3 | Sidebar (expanded, collapsed, drawer, tooltips) | Done | Chromium at 1440, 1024, 390; keyboard | Not done |
| 4 | Home layout and palette | Done | Screenshots 01 to 06 | **Your light-teal reference has not been compared** |
| 5 | Reports, calendar, printing | Done | Chromium print to PDF (section 4) | Not done |
| 6 | Clear records and actions | Done on the screens listed in the earlier rounds | Screenshots 07 to 23 | Not done |
| 7 | Style (contrast adjusted to `#5C727B` for zero and unavailable) | Done | Computed contrast | Not done |
| 8 | **Overnight availability** (0037) | Built, with rollback and web editor | 30 database tests (section 3) | Not applied, not deployed |
| 9 | **Print letterhead** (0038, separate route) | Built | 21 database tests, 3 handler tests, 5 web tests | Not applied, not deployed |
| 10 | **Environment marker** (explicit configuration) | Built | 11 resolver cases and 8 banner tests; Chromium with three configurations | `config.json` not yet written on any bucket |
| 11 | Preserve the full product plan (CareScore, skills, services, cities, incidents, others) | Documented as pending restoration with an ordered plan | n/a | n/a |
| 12 | Release steps and rollback | Runbook written; **gated release scripts for 0037 to 0038 not yet created** | Local gate only | Not done |

## 3. What was built this round

**Overnight availability (0037).** A window whose end is earlier than its start runs into the next day (the rule shifts already use); equal times are refused. Matching now works on real instants in the agency's own time zone: all windows that could touch the request are turned into start and end instants, overlapping or adjacent windows are merged, and a caregiver matches only if the merged availability covers the whole request. A date marked unavailable blocks every local date the request touches (for a daytime request, the one date, as before). Everything else in matching is unchanged. Rollback refuses while any overnight window exists; otherwise it restores the 0011 constraint and matcher exactly.
Tests (30, local PostgreSQL): window shape (overnight and until-midnight accepted, equal refused, saved through the caregiver function and read back); daytime and weekend preserved (inclusive edges, weekend days, date-specific windows, source label); overnight matching (inside, before, after, wrong night, small hours belong to the evening before, until-midnight, date-specific); **weekday, month and year boundaries** (Saturday to Sunday, Sunday to Monday, Friday not covered, 31 December to 1 January, 31 October to 1 November); **overlapping and adjacent windows** (overlap merged, adjacent joined, gap not, overnight plus the next morning, duplicates); unavailable dates (either touched date blocks, unrelated date does not, request ending at midnight does not touch the next date); **time zone and daylight saving** (Los Angeles versus New York read in the agency's zone, the 25-hour night of 1 November 2026, the 23-hour night of 8 March 2026, a Honolulu agency); other matching rules intact (caregiver and other-agency callers see nothing, declined offer excludes, helper not callable by the application role); rollback (refuses with an overnight window, restores otherwise). **Negative control:** with the old matcher restored, a daytime window 8 AM to 8 PM wrongly matched a 7 PM to 2 AM request; the new matcher does not.
The caregiver editor now allows From later than To, explains it, refuses equal times, and warns before replacing a saved schedule that is more detailed than one time range.

**Print letterhead (0038).** Seven optional columns on the agency (legal name, street, city, state, ZIP, phone, email); nothing pre-filled and no agency's details in the product. New route `POST /v1/branding/letterhead` for the agency named in the request, requiring `organization.update` (the Administrator, the same role as branding), re-checked in the database function, idempotent, audited with before and after. `GET /v1/branding` returns the fields to any active member of that agency only. Settings, Branding has a "Print letterhead" section that says to enter agency business details only. Printed reports show what was entered; the legal name falls back to the agency name. Tests: Administrator only, managers and caregivers refused, another agency cannot write or read, validation, blank clears, retry with the same key audited once, existing branding unchanged, rollback refuses while details exist.

**Environment marker.** One explicit value, `VITE_APP_ENV`, read from the deployment's `/config.json` (overriding the build value). `test` or `development`: banner "TEST — synthetic data only". `production`: no banner. Missing or invalid: banner "Environment not verified"; an unknown value is never called TEST. The banner appears on every page, is hidden when printing, and the same text is in every printed page header (and page one) for test and unverified environments. The hard-coded sentence on Clients is removed. `config.json` carries a label only; no credential. **A finding:** `infra/aws/scripts/deploy-test-slice.sh` built the TEST web app with `VITE_APP_ENV=production`; the three deploy scripts that write `config.json` now take an explicit `OGEVIA_APP_ENV` (default `test`, refused unless test, development or production).

## 4. Browser printing: limitations

- Verified only by Chromium print-to-PDF at US Letter, with synthetic data: the calendar alone (1 page), the calendar with the visit detail page (4 pages), and the visit list (landscape, 10 to 12 pages). Each page carries the agency, report, client or "All clients", month or period, the environment label where it applies, and "Page N of M". Page one shows logo, legal name, address, phone and email when entered.
- The running header and page numbers use CSS page margin boxes. Chromium-based browsers (Chrome, Edge) support them. **Safari and Firefox are not verified**; there the first-page letterhead should still print, but the repeated header and page numbers may not.
- Not verified: a real printer, the browser's print dialog and its own header and footer setting (users can turn the browser's header and footer on or off), A4 paper, scaling other than 100 percent, a very long list on a real device.
- The test suite logs "Could not parse CSS stylesheet" for the print rule because jsdom cannot parse page margin boxes. It is harmless noise in test output.

## 5. Other checks and observations

- Gates run (local): `pnpm typecheck`, `pnpm lint`, `pnpm test` (web 706, sv-api 58, infra-aws 106, ui 73, shared 118, auth 138), `pnpm build` all pass. Database suites against a local disposable PostgreSQL 16: infra 385 tests in 38 files, sv-api 59 tests, all pass.
- **One intermittent failure was seen:** in one loaded full `pnpm test` run the existing caregiver slice test (`aws-app.test.tsx`, "login to submitted") failed to find a button within its 1-second wait; it passed on three reruns, including the next full run. It looks timing-related under load; it was not investigated further.
- Local database tests do not prove behavior on RDS. The local test database is PostgreSQL 16.15. `docs/aws/CURRENT_AWS_INVENTORY.md` records the AWS database as PostgreSQL 18.3 (a document, not checked live); 0037 uses `range_agg`, which needs 14 or later, and nothing was run on 18.

## 6. Functional gaps and pending items

1. Gated release scripts for 0037 to 0038 are not created (runbook only).
2. CareScore, skills, caregiver services, preferred cities, languages, incidents, an Authorizations page, month hours by source, AskCare, support access and the others are **pending restoration**, not discarded: `PENDING_RESTORATION.md`.
3. Care requests show client codes only (the endpoint returns no name).
4. No Ogevia logo image exists in the repository (a text wordmark is used).
5. CSV exports keep the old column title "Remaining to schedule".
6. The availability editor still saves one time range for all selected days.
7. Server messages from the API may still use UK spelling (for example "colour"); only the web text was changed.

## 7. Not verified, in one place
The deployed commit; anything on AWS; real printing and browsers other than Chromium; screen readers; real phones; your light-teal reference; Documents reminder days and Billing rounding with real data; care request offers.
