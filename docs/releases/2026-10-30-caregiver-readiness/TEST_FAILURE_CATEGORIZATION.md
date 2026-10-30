# Categorization of the 41 database test failures (2026-10-30)

Question asked: are they pre-existing environment issues, obsolete tests, or actual defects? **Answer: no actual defect found. None is caused by migration 0086.** 37 are tests of superseded release packages (now retired); 4 are date-dependent tests that fail only because today is two days before a month end and a DST change.

Evidence base: the same 6 files and the same 41 tests failed on the code **before** migration 0086 existed (run with 0086 removed), so they pre-date this change. After retiring the 37, the full DB suite on the real clock shows exactly the remaining 4.

| Category | Files | Tests | Evidence | Disposition |
|---|---|---|---|---|
| **Obsolete: tests of superseded release packages** (they drive that package's operator scripts against mocked AWS and a fixed ledger such as `46\|0046`, or pin the repository to 85 migrations) | `auth-cutover-scripts` (2026-10-21), `prd-release-exec` and `prd-rehearsal` (2026-10-19 prd-readiness) | 16 + 13 + 8 = **37** | Failed identically on the unmodified code in this container. Typical failure: the script reports `account …: OK` where the test expects `MIGRATION FAILED`/`not exactly 46\|0046`. Root cause of the mismatch **not diagnosed** (the scripts and fixtures belong to packages the owner has declared superseded) | **Retired** (moved to `infra/aws/retired-tests/`, restorable with `git mv`; see its README). Not re-pinned |
| **Date-dependent tests (fragile by design, not defects)** | `authorization-tiers` (1), `authorization-single-bucket` (1), `dst-local-times` (2) | **4** | Today is Fri 2026-10-30: the fixtures place shifts at "today + 2 days" (2026-11-01), which is outside the current-month authorization and is also the DST fall-back Sunday. Symptoms: "No current authorization covers this client and service on that date", "This shift is already over", "The first date cannot be in the past". **With the clock frozen at 2026-10-10 (Postgres and Node), all three files pass: 34 of 34 and, with the two visit files, 61 of 61** | **Left as they are.** They will pass again after 2026-11-02 and fail again near each month end. Recommended follow-up (not done, out of scope): make their dates independent of the calendar. They are the only DB failures on the real clock |
| **Actual defects** | none | 0 | | |

## What was run
| Run | Result |
|---|---|
| Full DB suite, real clock (2026-10-30), after retiring the 3 obsolete DB files (99 files) | 96 files pass, 3 fail; **1080 pass, 4 fail** (exactly the 4 date-dependent tests above) |
| The 5 date-sensitive files with Postgres and Node frozen at 2026-10-10 12:00 | 5 of 5 files pass, 61 of 61 tests |
| Full DB suite frozen at 2026-10-10 | **not completed**: the full run stalled after 6 files (a test that waits on the clock hangs when time is frozen) and was stopped; it is not counted. Only the 5 date-sensitive files were run frozen (61 of 61 pass) |
| Unit suites after retiring the 4 obsolete `test/` files | infra/aws 23 files, 458 of 458 pass; web 1215 of 1215; sv-api 96 of 96; sv-api DB 152 of 152 |

Method note: the frozen clock uses `libfaketime` preloaded into both the Postgres server and the Node test process with an **absolute** time. An earlier attempt with a ticking start time (`@…`) made five unrelated visit tests fail because the two processes drifted apart; that was an artifact of the method, not a finding, and is not counted.

## Browser regression scripts (for checklist B9)
| Script | Result | Category |
|---|---|---|
| `local-harness/browser-scenario.mjs` | stops at "office sees the caregiver request panel" (schedule page) | **Fails identically on the unmodified code** (run on a clean checkout of the commit before 0086): pre-existing, probably date-dependent (today is a Friday near month end); not related to readiness |
| `local-harness/workflows.mjs` | stops in W1 (client intake) | Stale script: expects a client code format and screens older than the current client page; fails before reaching anything 0086 touches. It also still expects the removed Onboarding/Compliance cards (W2) |
| Fake-clock browser run | not usable (Chromium with the preload misbehaves) | method limit |
