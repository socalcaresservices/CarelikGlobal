# Feature test plan: <release-id>

Copy to `docs/releases/<release-id>/FEATURE_TEST_PLAN.md` **before** writing code, and keep it current. Every new feature, bug fix, migration, API change, dashboard, report, scheduling or authorization change has one. The release checklist cannot be completed without it. Process: `docs/TESTING_AND_RELEASE_PROCESS.md`.

## 1. The change
| Field | Value |
|---|---|
| Problem or requirement (in the owner's words, with the source) | |
| What changes, per role (Owner, Scheduler, Manager, Caregiver) | |
| What must NOT change | |
| Migrations, routes, screens touched | |
| Catalog areas required (process section 6.3) | |
| Harness data needed (seeded already? what must be added to `local-harness/setup.ts`) | |
| Things only the pilot can prove (Cognito, authorizer, IAM, S3/KMS, CloudFront, email) | |

## 2. Test cases
One row for **every** behaviour the change adds, changes or must preserve. Use catalog IDs where they exist; add new IDs to the catalog in the same change. The four columns are required for every row.

| ID | What to test | How to test | Expected result | Rollback plan if it fails or must be undone |
|---|---|---|---|---|
| | The behaviour, in one sentence | Automated: file and test name. Harness: persona, screen, exact steps and data. Pilot: who, steps | Exact numbers, text and states. "Works" is not an expected result | What is reverted, in what order, and what cannot be undone |

Include at least: the main path; the nearest case that must not change (control); a refusal case; a wrong-role case; another-tenant case; a retry/duplicate case (if records are created); concurrency (if shared money, hours or capacity); old data still readable (if stored data or its meaning changes); mobile 390 px (if a caregiver screen).

## 3. Failure-first checklist (tick or write "not applicable because ...")
☐ Invalid input ☐ Stale data ☐ Two people at once ☐ Retried or duplicated request ☐ Wrong role ☐ Other agency ☐ Network failure at submit ☐ Database failure mid-way ☐ Old data and old signed or locked records ☐ Correction after the fact ☐ Daylight-saving and month-boundary dates ☐ Timezone is the agency's, not the browser's

## 4. Numbers that must agree
List every place the same number appears (Home, client page, reports, API, CSV) and the single calculation they must all use. For each: how you will show they agree (same fixture, same figure in each place).
| Figure | Where it appears | Single source | Agreement check |
|---|---|---|---|

## 5. Evidence plan
| Evidence | Phase | File name |
|---|---|---|
| Failing test before the fix (bug fixes) | A | |
| Before and after screenshots of the same record | B | `evidence/<ID>-<what>-before.png`, `...-after.png` |
| Pilot checks that the harness cannot prove | C | |
| UAT scripts and sign-offs | D | |

## 6. Rollback plan (whole change)
| Layer | Action | What it cannot undo | Who | Time |
|---|---|---|---|---|
| Web | Redeploy the previous bundle (kept in S3 history) | | | |
| API | Redeploy the previous template / commit | | | |
| Database | `.down.sql` for each migration (list), restore only to a NEW instance from the snapshot and only by separate approval | | | |
| Data created during the release | Never deleted by hand; corrected through the product's own workflows | | | |

## 7. Worked example (for orientation; this is the F1 fix, release 0049)
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| AUT-04 | A minute is counted once, as used or as reserved | Automated: `authorization-accounting-risks.db.test.ts` "a linked visit left in administrator_review whose late confirmation was ACCEPTED ...". Harness: client "Demo Rivera (late confirmation)", Administrator, client page, "Balance for month" | 10 h authorized, 45 min accepted, 2 h shift reserved: **Hours left 9 hr 15 min** (before the fix 7 hr 15 min) | `0049_*.down.sql` restores the three previous function definitions; web and API unchanged |
| AUT-04c | Revoking the decision restores the reservation | Automated: same test, revoke step | Reserved 120 returns, used 0; reservation row never changed | Same |
| AUT-04d | A visit with no shift is unaffected | Automated: second test in the same file | Unrelated reservation still counts (used 30, reserved 90) | Same |
| AUT-01 | Signed linked visit still counts once (control) | Automated: control test in the same file | Used 45, reserved 0 | Same |
