# Remediation of the date-dependent database tests (G3), 2026-10-30

Owner decision: make the date-dependent tests calendar-independent, **without weakening coverage, removing assertions or changing production behaviour**, deterministically, and validate them on the current date and after 2026-11-02. No production code, migration or API was changed. Test files changed: `infra/aws/db/test/harness.ts` (one added helper), `authorization-tiers.db.test.ts`, `authorization-single-bucket.db.test.ts`, `dst-local-times.db.test.ts`.

## Exact root cause
All failures come from one pattern: **a test builds its calendar from "today" plus a small offset, but a rule it exercises depends on a boundary the offset can cross.** The product code is correct in every case; the tests then ask it for something impossible.

| # | Test (file) | What the test did | Boundary crossed on 2026-10-30 | Symptom |
|---|---|---|---|---|
| 1 | "double count: the freed capacity is real" (`authorization-single-bucket`) | Used minutes and a held reservation in the **current month**, then created a new shift on `today + 2` and asserted the month's used and reserved figures | `today + 2` = 2026-11-01, **next month**: outside the fixture authorization (which ends on the last day of the current month) and in a different monthly bucket from the used minutes | "No current authorization covers this client and service on that date"; and, had it been covered, the month's reserved figure would not include the new shift |
| 2 | "concurrency: two managers filling the last hour" (`authorization-tiers`) | Two shifts on `today + 1` and `today + 2` against a 60-minute month | The two days fall in two different monthly buckets (or outside the authorization) at a month end, so both succeed | `expected [] to have a length of 1` |
| 3 | "'Change this date only' refuses an unclear time and accepts a clear one" (`dst-local-times`) | Found the next DST transition from `today + 2`, then created a base shift two days **before** it | Fall-back fell on `today + 2` (2026-11-01), so the base shift was dated today, hours already over | "This shift is already over; record past service as a visit instead" |
| 4 | "weekly series flags the repeated-hour Sunday ..." (`dst-local-times`) | Same search start; series started 7 days **before** the transition | Series start = 2026-10-25, in the past | "The first date cannot be in the past" |

A sweep of the original files on other dates found **two more tests of the same family** that happen to pass on 2026-10-30 and fail on the last day of any month: "a shift that does not fit still refuses (OGC09) ..." and "when time remains but not enough, the wording is the same as before ..." (both `authorization-tiers`): reservations in the current month, new shift on `today + 1`, which on a month's last day is next month (outside the authorization, "OGV22" instead of "OGC09"). They are fixed in the same way. Nothing else in the three files is date-sensitive.

Why a controlled clock was not used inside the tests: the product reads `now()` in PostgreSQL and has no clock seam, and adding one would change production code, which the owner ruled out. A clock cannot be set from inside a test against an external database.

## What changed (deterministic approach: fixed test data)
1. **`harness.ts`: new helper `midMonthAhead(db)`.** Returns the 15th of the month that contains (agency today + 40 days): always a future month's middle, between about two weeks and two months ahead, so no month end or day boundary can split the test's dates. Used with `freshClient(..., { before: 5, after: 100 })`, an authorization period that covers it.
2. **Test 1** (`authorization-single-bucket`): the visit and its held reservation are still produced by the real flow (`reservedShift`, `run`); their agency-local service dates are then moved into the fixed month with a fixture write (triggers off, the same technique `ageVisit` uses), and the new shift is created in that month. Assertions: the original three are kept (new shift created; used 60 + reserved 180 for the month; a further 120-minute shift is refused) **plus one added** (before the new shift: used 60, reserved 0, i.e. the review visit counts once and its 130 held minutes are freed).
3. **Tests 2 and the two further `authorization-tiers` tests**: reservations (`reserve` gained an optional `serviceDate`, default `today`, so every other caller is unchanged) and shifts are all in the same fixed future month. All asserted error codes and wordings are unchanged (OGC09; "already 2 hr 40 min over its limit this month, and this shift needs 1 hr"; "2 hr available, this shift needs 3 hr"; exactly one of two concurrent shifts succeeds and one fails with OGC09).
4. **Tests 3 and 4** (`dst-local-times`): the search for the next fall-back and spring-forward now starts at `today + 9` instead of `today + 2`, so every test has at least a week of future lead before the transition. Every assertion is untouched. Worst case (today = 2026-11-02) the next fall-back is 2027-11-07, 370 days ahead, inside the 400-day search window and the 400-day authorization period the tests already use.

No assertion was removed. Business rules still validated: authorization month cap arithmetic, one bucket per minute, lineage lock under concurrency, plain-language shortfall wording, DST ambiguity/nonexistence refusals, `Change this date only`, weekly-series skip rules.

## Validation
Method: Postgres and Node both run under `libfaketime` with the **same frozen absolute time** (a ticking start time makes the two processes drift apart and is not used). Each date runs the three files twice: the original files (from the commit before the change, in a clean worktree) and the fixed files.

| Frozen date (UTC) | Original files | Fixed files |
|---|---|---|
| 2026-10-24 12:00:00 | 34 passed (34) | 34 passed (34) |
| 2026-10-25 12:00:00 | 1 failed, 33 passed (34) | 34 passed (34) |
| 2026-10-29 12:00:00 | 1 failed, 33 passed (34) | 34 passed (34) |
| 2026-10-30 19:00:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2026-10-31 12:00:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2026-11-01 06:30:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2026-11-01 12:00:00 | 34 passed (34) | 34 passed (34) |
| 2026-11-02 12:00:00 | 34 passed (34) | 34 passed (34) |
| 2026-11-30 12:00:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2026-12-31 23:30:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2027-01-31 12:00:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2027-02-28 12:00:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2027-03-13 12:00:00 | 34 passed (34) | 34 passed (34) |
| 2027-03-14 12:00:00 | 34 passed (34) | 34 passed (34) |
| 2027-04-30 12:00:00 | 4 failed, 30 passed (34) | 34 passed (34) |
| 2027-11-06 12:00:00 | 34 passed (34) | 34 passed (34) |
| 2027-11-07 12:00:00 | 34 passed (34) | 34 passed (34) |
| 2026-10-10 12:00:00 | 34 passed (34) | 34 passed (34) |

| Result | Original | Fixed |
|---|---|---|
| Dates with a failure | 10 of 18 | **0 of 18** |
| Tests per run | 34 | 34 |

The 18 dates include: the real date (2026-10-30), the last day of a 31-day, 30-day and 28-day month, year end, both daylight-saving days (2026-11-01, 2027-03-14) and the days before and after them, a late-evening local time that is already the next UTC day (2026-11-01 06:30 UTC = 2026-10-31 23:30 local), 2026-11-02 and later dates (after the 2026-11-02 mark the owner named), and a year ahead.

Real clock, full suite after the change: FULL_SUITE_LINE
