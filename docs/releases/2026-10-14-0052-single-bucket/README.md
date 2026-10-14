# Migration 0052: a minute is counted once (decision D2)

**Status: IMPLEMENTED and TESTED LOCALLY. NOT DEPLOYED. Stacked on PR #87 (it needs migration 0049, which only #87 contains).**
Approved by the owner on 2026-10-14 as the priority functional correction, to be developed separately with database and end-to-end tests.

## The defect
`authorization_month_usage` counts the billable minutes of signed and `administrator_review` visits (0036). A linked shift's reservation is released only when its visit becomes `signed` (0013). Migration 0049 stopped the double count only for an accepted late confirmation. A scheduled visit in review **with billable minutes** (for example a visit whose length differs from its shift by more than the agency rule from Wave 1, or one that went over the authorization) was counted as used **and** its shift stayed reserved: 60 minutes on a 130-minute shift counted 190.

## The change (one function)
`ogevia.reservation_counted_as_used(shift)` is extended: a reservation is not counted as reserved while its shift has a linked visit in `administrator_review` with billable minutes above zero, or with an active accepted late confirmation. The three functions that use it are untouched.

Not changed: visit status, billable minutes, billing approvals, review decisions, audit events, and the reservation row itself (never released, deleted or edited). The result is reversible and a function-only rollback exists (`rollback/0052_...down.sql`, SAFE AUTOMATED).

## Evidence
| Check | Result |
|---|---|
| New DB tests without 0052 (`failing-first-db.txt`) | 5 of 9 fail (the double-count cases) |
| New DB tests with 0052 | 9 of 9 pass |
| New end-to-end API test without 0052 (`failing-first-api.txt`) | fails |
| With 0052 | passes |
| `@carelik/infra-aws test:db` | 57 files, 560 tests pass (includes the `it.fails` F2/F4/F6/F8 tests, which did not flip) |
| `@carelik/sv-api test:db` | 5 files, 74 tests pass |
| lint, typecheck, infra and sv-api unit tests | pass |

## Cases covered
Visit in review by the schedule rule; over the authorization (capped billable); freed capacity is usable (a new shift fits while the review is open, and the cap still holds); review decision and billing approval do not move minutes; a correction that signs the visit; controls (signed inside the rule, no billable minutes keeps the shift reserved, other shifts stay reserved).

## Open question (not changed here)
Closing a review as "not billable" leaves the visit's billable minutes on the record, so they stay counted as used. That is existing behavior; the test documents it. Whether a not-billable visit should free its minutes is a policy decision for the owner.

## Release notes
Apply after 0049 to 0051 in order. Needs the release checklist, pilot validation and the owner's explicit GO. Nothing here was run against AWS, the pilot or production.
