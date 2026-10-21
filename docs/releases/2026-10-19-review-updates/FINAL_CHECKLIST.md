# Final checklist: owner directive 2026-10-18 and corrections 2026-10-18 (local)

**Publication state.** LOCAL COMMITS ONLY on `local/review-updates`. NOT pushed. NOT merged. NOT deployed to TEST. NOT deployed to Production. No AWS setting was changed and no live agency record was touched. All data used here is synthetic. Local tests do not prove deployed behaviour. Migrations 0078 to 0081 were applied only to throwaway local databases.

Statuses: VERIFIED (exercised here, evidence named) / PARTIAL / NOT VERIFIED / BLOCKED. Test counts describe only what was exercised.

Commits (full SHAs are in `git log`; the last is the Batch 5 commit): Batch 0 `9b76745b`, Batch 1 `c844fdff`, Batch 2 `480606ba`, corrections `018d2468`, Batches 3 and 4 `2ec1301a`, Batch 5 (this commit).

## Ground rules
| Requirement | Status | Evidence / remaining |
|---|---|---|
| Inspect tree, branch, HEAD first; preserve uncommitted work | VERIFIED | Batch 0 section of CHECKLIST.md |
| Integration branch confirmed; new local branch from its tip, no reset to an older SHA | VERIFIED | local tip `3159e52` contains origin `bffa1fc`; branch = tip + 3 local commits |
| No push, merge, deploy, AWS change, live-record change | VERIFIED | none performed; the only pushes in this project were earlier, owner-approved, and not part of this directive |
| Deployment triggers reported separately (GitHub Actions, Netlify, GitHub apps, AWS automation) | VERIFIED for the repository; external settings NOT VERIFIABLE | PRODUCTION_READINESS_REPORT.md |
| Never edit an applied migration; new migrations when history is uncertain | VERIFIED | only new files 0078 to 0081 (with rollbacks); `git diff 3159e52 -- infra/aws/db/migrations` shows additions only |
| Screenshots: same seed, fixed clock, 1360 px and 390 px (phone = emulation) | VERIFIED | one database snapshot restored for each pass; server and database clock fixed at 2026-10-19 15:00 UTC (libfaketime), browser Date fixed; `screenshots/before` (build of `480606ba`) and `screenshots/after` |
| No mock-ups replacing real screenshots | VERIFIED | all images are real harness captures |
| One local commit per batch; one persistent checklist | PARTIAL | one commit per batch, except the Batch 3 and 4 work and the four corrections were integrated from parallel work and committed as two commits (`018d2468`, `2ec1301a`) |

## Batch 0
| Item | Status | Evidence |
|---|---|---|
| Branch contains White/Minimal, combined rules, migration conflict resolution | VERIFIED | ancestry checks (CHECKLIST.md) |
| Completed / partial / missing identified before changes | VERIFIED | table in CHECKLIST.md |
| Ledgers and collaborating branches (goodall) | VERIFIED for the repository; live ledgers UNKNOWN | goodall `ea22bbf` fully contained; TEST ledger last read at 52 (2026-10-17), 0053 to 0077 applied by the owner's 2026-10-18 operation (not re-read); production never read. Read-only command: `OGEVIA_EXPECT_HOST_IP=<ip> bash infra/aws/slice/ledger-check-temp-access.sh test --host-ip` (production not run) |
| Five-board handoff and comparison documents located | VERIFIED | the zip is MISSING; comparison and 88-row matrix present; addendum added to FIVE_BOARD_COMPARISON.md |

## Batch 1
| Item | Status | Implementation | Tests | Remaining |
|---|---|---|---|---|
| Document upload | CAUSE FROM CODE; fix LOCAL, NOT DEPLOYED | `*/client-documents/*/*` added to role policy and S3 endpoint policy; storage error name logged | `app.test.ts` key-coverage test (fails without the fix); `storageUnavailable` unit test | live error not seen; deploy NetworkEgress then ServiceVerificationApi needs owner approval, then retest |
| Own-document approval blocked; second account approves; persists | VERIFIED locally | DB guard unchanged | `client-documents.db.test.ts` | real two-account check on TEST after the fix is deployed |
| Pin checker: failed `git status` fails | VERIFIED | `candidate-pin-check.sh` | `candidate-pin-check.test.ts` (non-zero exit, disk full, corrupt index) | PR #101 and the `_backup` package still hold the old script |
| `ledger-check-temp-access.test.ts` failure | NOT REPRODUCED | n/a | passed alone (54) and in the full infra suite | impact test-only; 60 s timeout vs about 31 s slowest test |

## Batch 2 and corrections
| Item | Status | Evidence | Remaining |
|---|---|---|---|
| Assignment outcome: one server decision, outcome first, Blocked headline kept | VERIFIED | 0078; `assignment-outcome` (infra 10, API 2); web panel | submit-time recheck verified; missing scores never block |
| Service not approved: Warning when Service checks Off, Blocked when On | VERIFIED | same | |
| Daily limit shows actual and allowed hours | VERIFIED | "10.5 of 9 h" test | |
| Equation Authorized = Billable + Rounding + Pending + Reserved + Hours left; per authorization; Over limit | VERIFIED | 0079; `hours-accounting` (20 + 1) | review-document 31.1 h not reproducible (no production data) |
| Rounding explicit and counted once | VERIFIED | rounding assertion (usage 60 = 50 + 10) | |
| Correction 1: Pending hours must count when deciding if more work fits | VERIFIED; overbooking WAS possible and is fixed | 0081; `pending-hours-guards` (18): failing-first on 0080 (605 of 600 accepted); race tests: two 300s for 555 left, one succeeds; six 100s, five succeed | residual: `end_service_visit` takes no lineage lock, so a visit ending at the same instant as a scheduling call could be missed by that one check; the confirmation cap still applies. NOT fixed |
| Correction 2: closed-not-billable not Pending forever | VERIFIED (labelling); POLICY DECISION OPEN | closed hold counted inside Reserved with its own visible line and worked time kept; nothing releases it today because the decision row leaves the visit in review (`reconcile_ended_shift` and `cancel_shift` refuse) | OWNER: release the reservation on close? Recommended yes with an audited release reason; see HOURS_ACCOUNTING.md |
| Correction 3: pending/unverified CPR/TB is not a pass; no grace bypass | VERIFIED locally | 0081 removes the grace branch; `cpr-tb-verified-required` (12): failing-first, blocks create, reschedule, assign, series, make-up, pickup, care request and visit start when enforced; Warning when report-only | the compliance hold still waits 14 days (unchanged); an onboarding exception would need an explicit audited one-shot (not built). Enforcement NOT activated anywhere |
| Correction 4: Worked, not billable cannot vanish from consumption checks | VERIFIED | worked above billable arises only when the cap is used up; 150 on 100 leaves Hours left 0 and refuses 15 more minutes | an unscheduled visit closed as not billable consumes nothing by design (same decision as correction 2) |
| Caregiver vs office balance identical records | VERIFIED | caregiver "Left to record" excludes reservations, office "Hours left" deducts them, difference labelled; all surfaces agree in test | |
| Attention timing: 48 h, start, holds, review clocks, boundaries | VERIFIED (server) | 0080; `attention-counts-one-definition` (33) incl. 1 microsecond before, at, after | stricter payer or regulator deadlines NOT modelled |
| Counts: one definition each, count equals list | VERIFIED | COUNT_DEFINITIONS.md; count-vs-list tests; Documents card now separates counted items from "Not counted" reminders | |
| "1 needs coverage" beside two past shifts | VERIFIED as a web GROUPING error, not counting | server counted correctly; web grouping fixed; not reproduced on the owner's real data | |

## Batch 3
| Item | Status | Evidence | Remaining |
|---|---|---|---|
| Names on administrator screens, codes in Details; caregiver screens and notifications keep codes | VERIFIED | `names-duplicates.test.tsx` (2), `duplicate-names.db.test.ts` (3) | codes still shown beside names in care-team and client detail headers, accounts, pickup and care-request rows, visit-review header |
| Duplicate names detected server-side per agency, existing code shown, no new identifier | VERIFIED | API `duplicateName` flag only where a name is visible to the caller | action-issue and reconcile rows carry no flag |
| Scheduling: Unfilled (n), one Unfilled badge, call-out reason kept, upcoming apart from past | VERIFIED | screenshots; `schedule-simplified`, `attention-counts-badges` | |
| Assignment: Suggested, Select, Assign, score info in Details | VERIFIED | tests; aria-label names the shift | |
| Visits wording: In review, Review, Correct, History, Unscheduled, Replaced (Details), Pending Confirmation kept | VERIFIED | `service-verification-reports-page.test`, `visit-review.test`, `aws-app.test` | hours-table "Pending" column headers and CSV headers left as the accounting terms |
| Layout: compact rows, one-line badges, each count once, instructions removed, role shown once | PARTIAL | the phone Unfilled row still names the client twice (collapsed line and expanded line); duplicates removed (sidebar role, readiness banner, client alert rows, Home counts, Documents card); day rows no longer repeat the date | authorization-impact cards still repeat client and amendment text; Schedule and Reports row lists not further compacted; desktop inline links and Details toggles are 16 to 19 px tall (touch targets on phone fixed) |

## Batch 4
| Item | Status | Evidence |
|---|---|---|
| Route map written before moving; every route and permission preserved | VERIFIED | ROUTE_MAP.md; `route-map.test.tsx` (36): only `/care-requests` and `/services` changed path, both redirect with query and fragment |
| Monthly calendar and shift requests under Schedule; Recruiting under Caregivers; Services and Appearance under Settings | VERIFIED | nav tree in ROUTE_MAP.md |
| Care requests destination explained | VERIFIED | now Schedule > Shift requests (the page turns client requests into shifts); link kept on the client page |
| Visits versus Approvals defined, no duplicate queues | VERIFIED | doc plus uniqueness test |
| Desktop left sidebar, phone drawer | VERIFIED | sidebar moved from right to left; drawer already existed, now also closes on route change; `sidebar-home.test.tsx` |
| Main order Home, Schedule, Visits, Approvals, Clients, Caregivers, Documents, Reports, Settings | VERIFIED | screenshots; tests |
| Authorizations discoverable; authorization context kept through Schedule > Shift > Caregiver > Eligibility > Assign | PARTIAL | nav entry opens the existing "Authorization changes to review" screen (label and title differ); context line shown in Add shift and the assign panel from server fields | no standalone Authorizations overview page |
| Every mapped route reachable by authorised roles, denied for others, direct links kept | VERIFIED | `route-map` 36, `route-denial` 9 (depends on current refusal wording) |

## Batch 5
| Item | Status | Evidence |
|---|---|---|
| Large text and Compact density x every background x both layouts x desktop 1360 and phone 390 (emulated), six screens | VERIFIED for the checks below | `appearance-matrix2/matrix.json` (192 runs; script `infra/aws/local-harness/appearance-matrix.mjs`) |
| Settings really applied | VERIFIED | `data-og-*` attributes matched on all 192 runs |
| No unintended horizontal scroll | VERIFIED | 0 of 192 |
| Readable text | VERIFIED with one exception | automated WCAG ratio check; only finding: the DISABLED "Turn Service checks On" button (2.5 to 2.6, disabled controls are exempt). Not a visual review of every screen |
| Visible alerts | VERIFIED | 0 hidden alert or status elements |
| Usable controls | PARTIAL | phone: the first run's link, summary and checkbox findings were fixed; the final run (80 flagged of 192) leaves, on phone, only raw checkbox inputs of 13 to 20 px inside labels that are 44 px tall (tappable through the label); on desktop, inline links and Details toggles 16 to 19 px |
| Form input preserved when appearance changes | VERIFIED in unit test, NOT VERIFIED in browser | `interface-simplification.test.tsx` keeps typed text, focus and the same elements across all 8 background and layout combinations; in the browser a change made in another tab does not reach the open tab, so that check proved only that the field kept its value |
| Final screenshots White + Standard and White + Minimal; Home, Documents, Scheduling, Appearance; 1360 px and emulated 390 px | VERIFIED | `screenshots/after` (16) and `screenshots/before` (16) |
| Five-board comparison | INCOMPLETE | handoff zip missing; addendum from code evidence |
| Complete required suites | VERIFIED locally | see Test results |
| Publication states distinguished | VERIFIED | first paragraph |

## Test results (this tree; local; synthetic)
| Suite | Result (final tree, real PostgreSQL 16 clock) |
|---|---|
| infra database suite | 89 files, 933 tests passed |
| API database suite | 18 files, 124 tests passed |
| infra default (CDK, static) | 14 files, 206 tests passed |
| API unit | 3 files, 74 tests passed |
| UI package | 20 files, 73 tests passed |
| web | 121 files, 1174 tests passed |
| typecheck | clean: web, API, infra, UI (a type error in an infra DB test was found and fixed at this checkpoint) |
| eslint | web only (not configured for infra or API): clean after fixing one unused-variable error found at this checkpoint |
| web build | succeeded |
Skipped or not run: no real-device, TEST-environment or Production check; no screen-reader check; no run of the old suites against Supabase. Environmental limits: the harness uses libfaketime (PostgreSQL and API server) and a fixed browser Date; the infra CDK tests need esbuild on PATH (`infra/aws/node_modules/.bin`).

## Deferred and not built
New hover-help systems, new action-menu or drawer systems (the existing phone menu is the only drawer), unspecified features: none built.
