# Feature test plan: 2026-11-10-ux-redesign-test (TEST only)

Source of requirements: `docs/ux/REQUIREMENTS-TRACKER.md` (R1 to R31). Template: `docs/release-process/FEATURE_TEST_PLAN_TEMPLATE.md`. Written 2026-11-10 at commit `d7f7147` (head when written).
**Status words used below:** AUTO-PASS = the named automated test passed in this session; HARNESS-PASS = observed on the local harness or the offline preview; PENDING = not run yet; BLOCKED = cannot run without something only the owner has; OWNER = needs a person (you) to look or decide. **Nothing here has run on TEST or production.**

## 1. The change
| Field | Value |
|---|---|
| Problem or requirement | The owner's brief "ogevia update 1111" (UX audit, redesign, build on demo) and the standing tracker; every row below cites its tracker ID |
| What changes, per role | **Owner/Admin:** one navigation, dashboard headline, schedule drawer, override approval, import, duplicate review, CPR/TB setup. **Manager/Scheduler:** same screens without admin-only actions. **Caregiver:** phone bottom bar, today-only Verify Visit, client label (first name + initial + code), open shifts show code + city |
| What must NOT change | Billing, authorization, schedule and visit rules; server count definitions; production; released ledger 0001 to 0088; Service Verification states (scheduled, worked, confirmed, billing ready, approved, billed stay separate) |
| Migrations, routes, screens touched | Pending 0090 to 0094 (outside the ledger); routes `POST /v1/caregivers/{id}/signin-override`, `GET /v1/signin-overrides`, `POST /v1/imports/{kind}`, `GET /v1/staff/duplicates`, `POST /v1/staff/{id}/merge`, each behind a release switch (off); screens listed in the tracker |
| Catalog areas required | SMK, SCH, VIS, DSH, USR, CMP, RDY, UIS, HOM (existing) and the new UXR section appended to the catalog |
| Harness data needed | Seeded: today's visit (`harness:seed-today -- --startable`), two duplicate staff, client cities. Not seeded: a second agency for cross-tenant UI checks (covered by the automated sweep) |
| Things only TEST can prove | Real JWT authorizer on the 5 new routes; API Gateway body limit and Lambda cold start with the larger bundle; migrations applied to the real `ogevia_sv_test` with the shared RDS instance; live version stamp; real phone; production error behind R3 |

## 2. Test cases
Columns: **Pass/fail criterion** is the exact condition for PASS (anything else is FAIL). **Evidence** is what is attached to the checklist. Automated test paths are relative: web `apps/web/src/aws/`, DB `infra/aws/db/test/`, API `apps/sv-api/test/`.

| ID | Req | What to test | How | Expected result | Pass/fail criterion | Evidence | Status |
|---|---|---|---|---|---|---|---|
| UXR-01 | R1 R24 | One navigation system; no tab strip repeating sidebar items; Verify Visit absent from manager and owner menus | AUTO `nav.test.tsx`, `sidebar-home.test.tsx`; HARNESS Owner at 1360 px | Sidebar groups only; no second row of tabs; no "Verify visit" link for non-caregivers | All tests pass; screenshot shows no tab strip | test summary; `evidence/UXR-01-nav.png` | AUTO-PASS; screenshot PENDING |
| UXR-01c | R1(c) | The "stray ▲▼ control" | OWNER: confirm whether the native Organization `<select>` is the control | Owner states yes/no | Owner answer recorded | tracker row R1 | OWNER |
| UXR-02 | R2 | Help: one "?" per page opens a panel; Escape and outside tap close it; no help icon between a label and its field | AUTO `ui/page-help.test.tsx`; HARNESS Schedule at 390 and 1360 px with help open | Panel opens/closes three ways; Care Request fields not covered | Tests pass; screenshots show no overlap | summary; 2 screenshots | AUTO-PASS; screenshots PENDING |
| UXR-03 | R3 | A failed load is "Unavailable", never 0 or empty | AUTO `load-failure-states.test.tsx`, `home-closure.test.tsx` | Failure message and Retry; no count shown | Tests pass | summary | AUTO-PASS |
| UXR-03b | R3 R29 | The production error behind the three failing endpoints | OWNER: capture status and message in DevTools; then fix `action_issue_rows` | Real error recorded | Error text attached | tracker R29 | BLOCKED (owner) |
| UXR-04 | R4 | Compact dashboard: one row of figures, one queue, hours collapsed | AUTO `dashboard-r4.test.tsx`; preview | 3 tiles + Hours left; queue with chips; hours in closed details | Tests pass | summary | AUTO-PASS |
| UXR-05 | R5 | Schedule: Add shift in a drawer, One shift / Repeating, one exceptions panel | AUTO `schedule-r5.test.tsx`, `schedule.test.tsx` | Drawer traps focus, Escape closes; exceptions single list | Tests pass; **control:** over-limit shift still refused with exact minutes (SCH-02, DB) | summary; SCH-02 result | AUTO-PASS |
| UXR-06 | R8 | Caregiver Verify Visit: today's visits only; no Other assigned clients; a client with no active authorization cannot be started | AUTO `pages/service-verification-page.test.tsx`; DB `start-without-authorization.db.test.ts` | Today's scheduled visit shown; start refused with OGC09 and no visit row | Tests pass | summary | AUTO-PASS |
| UXR-07 | R10 R21 | Approve by override: reason required; background check never waived; badge; not-signed-in caregiver cannot verify visits | DB `signin-override-0090.db.test.ts` (12); API `signin-override.db.test.ts` (7); web `signin-override-ui.test.tsx` | Override recorded with approver, reason, audit; 409 without background clearance; 403 for non-admin; 404 other agency | All pass; **control:** a caregiver who signed in is unaffected | summaries | AUTO-PASS |
| UXR-08 | R11 | Import people and clients (CSV, XLSX): check first, then confirm | DB `bulk-import-0092.db.test.ts` (10); API `bulk-import.db.test.ts` (6), `import-file.test.ts` (10); web `import-drawer.test.tsx` (5) | Preview writes nothing; confirm creates new rows in one transaction; duplicates skipped; invalid rows block; same file twice creates nothing; 1,000 rows OK, 2,001 refused; no invitation sent | All pass | summaries | AUTO-PASS |
| UXR-08b | R11 | Zip-bomb workbook refused before decompression | API `import-file.test.ts` ("workbook size guard"); manual 190 KB to 200 MB bomb | 422 "too large once opened", instant, no crash | Pass; process not killed | summary; bomb run | AUTO-PASS (found and fixed this session) |
| UXR-08c | R11 | 2 MB / 2,000-row file through the real API Gateway and Lambda (10 s timeout, 512 MB) | TEST: operator posts a generated 2,000-row .xlsx and .csv | 200 within 10 s; no 413 | Both succeed; duration recorded | CloudWatch duration and memory | PENDING (TEST) |
| UXR-09 | R6 | Possible duplicates: read-only report; audited merge; hard match; refuses sign-in/invitation/caregiver | DB `staff-duplicates-0093.db.test.ts` (4); API `staff-duplicates.db.test.ts` (2); web `staff-duplicates.test.tsx` (5) | Pair listed; merge marks extra profile inactive with reason, link row, audit; unrelated people refused (409); same pair in two groups opens one form | All pass | summaries | AUTO-PASS |
| UXR-09b | R6 | Run the report on real TEST staff | OWNER with operator, after migration 0093 is approved on TEST | Real duplicates listed; **no merge without the owner choosing each** | Report reviewed by owner | screenshot | PENDING (approval) |
| UXR-10 | R7 | Standard CPR/TB: types named CPR and TB, no rule, no approval; setup link on caregiver row | DB `standard-document-types-0094.db.test.ts` (2); web `readiness/readiness-ui.test.tsx` (R7 case), `readiness-r7-setup-link.test.tsx` (2) | CPR and TB exist (names only); Valid-until blank; Save disabled without a reason; admin sees "Set up CPR and TB", manager "Ask an administrator" | All pass; **control:** an agency with "CPR card" keeps it and gets only TB | summaries | AUTO-PASS |
| UXR-11 | R19 | One headline number: no header chip, no "Needs attention now" tile; bell = dashboard queue count | AUTO `attention-badge.test.tsx`, `home-closure.test.tsx`, `aws-app.test.tsx`; DB `over-limit-action-needed.db.test.ts` (server counts unchanged) | "Needs action first · N" equals the bell N | Tests pass; **control:** server count definitions untouched | summaries | AUTO-PASS |
| UXR-12 | R23 | Caregiver sees first name + last initial + code for assigned clients; open shifts show code + city only; no name for unassigned | DB `caregiver-client-labels-0091.db.test.ts` (4); web `wave1.test.tsx` | "Demo T. · CL-…"; "CL-… · Springfield"; full surname never returned | Pass; **negative:** unassigned caregiver gets no row/name | summaries | AUTO-PASS |
| UXR-13 | R27 | Reports vs Reporting & billing, Staff vs Accounts, Staff Types in one place | HARNESS (no automated test): open each help panel | Pointers present; one Staff Types entry | Owner/tester confirms wording | 3 screenshots | PENDING (harness screenshots); OWNER judgment |
| UXR-14 | R13 | 390 px: no horizontal scroll; controls at least 44 px | HARNESS `infra/aws/local-harness/touch-targets.mjs` (20 office screens) | 0 overflow, 0 controls under 44 px | Script prints 0 / 0 | `evidence/touch-after.json` | HARNESS-PASS (re-run at head PENDING) |
| UXR-14c | R13(c) | Caregiver flow end to end on a real phone | OWNER: today's visit, Start, End, Confirm on a physical phone | Completes with no zoom or scroll problems | Owner confirms | notes/photos | OWNER |
| UXR-15 | R14 | Loading, empty, error, success on each changed screen | AUTO: import-drawer, staff-duplicates, home-closure, dashboard-r4, readiness-ui | See tests | Tests pass | summaries | AUTO-PASS |
| UXR-16 | R18 R20 R25 | Office roles cannot reach caregiver Availability; caregiver bottom bar; sign-in links only by explicit bulk action | AUTO `availability-route.test.tsx`, `caregiver-tabs.test.tsx`, `staff-bulk-invite.test.tsx` | Manager on `/availability` lands Home with no API call; four tabs; nothing sent by loading | Tests pass | summaries | AUTO-PASS |
| UXR-17 | all | Tenant isolation: manager of agency B against agency A on every route, including the 5 new ones, with all pending migrations applied | API `tenant-isolation-sweep.db.test.ts` | 403/404/empty; agency A rows unchanged | 9/9 pass | summary | AUTO-PASS |
| UXR-18 | R28 | Regression set R and smoke set S | `pnpm test`, both DB suites; `pilot-regression-local.sh` | All pass; runner exit 0 | Runner exit 0 required for the gate | `regress/*.md` | **BLOCKED on SMK-06 only**: local run 35 pass, 0 fail, 1 not run (needs the deployed API URL); remaining pass |
| UXR-19 | all | Lambda bundle and cold start with `exceljs` | Bundle `apps/sv-api/src/index.ts` as CDK does; load; parse 2,000 rows | Bundle < 50 MB; cold load added < 500 ms; 2,000-row XLSX parse < 2 s, heap < 256 MB | Numbers within limits | measurements in `SECURITY_AND_COMPATIBILITY_REVIEW.md` | HARNESS-PASS (local; TEST cold start PENDING) |
| UXR-20 | all | Switches OFF: the 5 routes are absent from every real stack; ON only for TEST with the patch | AUTO `infra/aws/test/*-switch.test.ts`, `slice-contract.test.ts` | Production and TEST have none of them until a release commit flips TEST | Tests pass | summary | AUTO-PASS |
| UXR-21 | all | Migrations 0090 to 0094 apply on the real TEST database and roll back | TEST operator (after approval): ledger pre-flight, apply, `db:verify`, rollback rehearsal on the harness | Applies cleanly; verification SQL PASS; down scripts tested in DB suites | All PASS | operator log | PENDING (approval) |
| UXR-22 | R22 | Which commit is on demo/app today | OWNER: `VITE_APP_VERSION` in the served bundle | SHA recorded | SHA in tracker | tracker R22 | OWNER |
| UXR-23 | SMK-06 | Unauthenticated call to a new route returns 401; forged token 401 | TEST: `pilot_smoke.py` plus a curl without a token on the 5 routes | 401 | All 5 return 401 | command output | PENDING (TEST) |

## 3. Failure-first checklist
☒ Invalid input (malformed, formula text, 2,001 rows, zip bomb) ☒ Stale data (re-upload of the same file; merge of an already merged pair) ☒ Two people at once (advisory lock on import and on merge; **not stress-tested**) ☒ Retried or duplicated request (idempotent import; `already_merged`) ☒ Wrong role ☒ Other agency ☒ Network failure at submit (drawer error messages; route absent says "not available yet") ☒ Database failure mid-way (rollback test with a failing row) ☒ Old data (agencies with existing "CPR card" keep it; 0091 and 0090 roll back to previous shapes) ☐ Real network and cold-start behaviour: not applicable locally, TEST only (UXR-08c, UXR-19).

## 4. Numbers that must agree
| Figure | Where it appears | Single source | Agreement check |
|---|---|---|---|
| Needs action count N | Header bell, dashboard "Needs action first · N", Action needed page | `action-issues` counts (server) | AUTO UXR-11 same fixture |
| Needs attention (items) | Needs attention page only | overview endpoint (server) | unchanged; DB tests |
| Imported / skipped / invalid counts | Check result, applied message, audit event | `ogevia_api.import_rows` | AUTO UXR-08 compares preview counts with created rows |
| Hours left | Dashboard tile, hours details | utilisation endpoint | AUTO `dashboard-r4.test.tsx` |

## 5. Evidence plan
| Evidence | Phase | File name |
|---|---|---|
| Test summaries (A) | A | `CHECKLIST.md` A2 to A7, `ci-*.txt` |
| Screenshots at 390 and 1360 px for UXR-01, 02, 13 | B | `evidence/UXR-<n>-<what>.png` |
| Touch-target JSON | B | `evidence/touch-after.json` |
| Regression report | B (local), C (TEST) | `evidence/regress-local.md`, later TEST report |
| Security and compatibility review | A | `SECURITY_AND_COMPATIBILITY_REVIEW.md` |
| TEST operator log, ledger before/after, `db:verify`, 401 checks, CloudWatch durations | C | to be created at C |
| Owner confirmations (UXR-01c, 14c, 22, 03b) | C/D | `DECISION_RECORD.md` entries |

## 6. Rollback plan (whole change)
| Layer | Action | What it cannot undo | Who | Time |
|---|---|---|---|---|
| Web | Redeploy the previous bundle | nothing | Operator | minutes |
| API | Previous template; switches off removes the 5 routes | nothing | Operator | minutes |
| Database | `.down.sql` newest first 0094 to 0090 (SAFE for 0091, 0094; BACKUP REQUIRED for 0090, 0092, 0093 which drop their tables) | Records created by imports and merges stay (they are ordinary records); merged profiles stay inactive until set active | Operator, after a manual snapshot | minutes |
| Data created during the release | Never deleted by hand; corrected through the product | | | |
