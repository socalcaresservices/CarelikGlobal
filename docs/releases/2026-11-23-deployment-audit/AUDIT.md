# Deployment audit from production release commit c7691b63 (2026-11-23)

Method: codebase and git history only. "In c7691b63" = `git merge-base --is-ancestor <commit> c7691b63` (checked for every implementing commit below). LIVE IN PRODUCTION means the commit is in c7691b63 AND production records show it shipped (production web published from c7691b63; Handler code equal to the TEST code of the same source trees; migrations through 0112 applied; the nine release routes live) AND nothing keeps it off (no OFF switch, no absent route). Production records used: `docs/releases/2026-11-21-offices/README.md` (4711b6b5, aeaed304), `docs/releases/2026-11-22-office-assignments/HANDOFF.md` (74ca9bf9), `docs/releases/2026-11-22-invitation-email-fix/README.md` (7555b030), merge `2b07ae43` (PR #113, "production deployed 2026-11-21").

## Limit of this audit (not guessed)
The Nov 15 go-live document is NOT in the repository: `docs/releases/2026-11-20-go-live-items/TRACKER.md` says "The repository holds no earlier written list, so item meanings are the builder's reading". Rows 1-10 below are that tracker's ten items. Items 1, 2, 3, 4, 7, 8, 9 and 10 still need the owner's confirmation of what was meant. Anything the document asked for beyond these ten cannot be audited from the repository.

## Status per item
| # | Item (source) | In c7691b63 | Implemented in | Status |
|---|---|---|---|---|
| 1 | Calendar CSV sort (Nov 15 list) | yes | 93e84d1 | LIVE IN PRODUCTION |
| 2 | Export ordering, all exports (R39) | yes | f88bdc4 | LIVE IN PRODUCTION |
| 3 | Caregiver picker (R40) | yes | 494b3fd | LIVE IN PRODUCTION |
| 4 | Shift drawer (R41) | yes | 4fc3859 | LIVE IN PRODUCTION |
| 5 | Dashboard refresh after shift updates (R43) | yes | eef6b23 | LIVE IN PRODUCTION |
| 6 | Requests refresh after shift updates (R43) | yes | fea082a | LIVE IN PRODUCTION |
| 7 | "Office filtering": read as Billing review reason filter (R42), and Offices with office filters (R46) | yes | 7bf0a4c; cac98cfd (0110) | LIVE IN PRODUCTION (both readings built; which one was meant is unconfirmed) |
| 8 | Homepage updates: Home Refresh uses shared refresh | yes | 369e988 | LIVE IN PRODUCTION |
| 9 | Mobile view: phone sorting for Documents and Staff (R44) | yes | 914695f | LIVE IN PRODUCTION (real-phone check NOT DONE per R44) |
| 10 | Scheduling refusal messages (R45) | yes | c19453d | LIVE IN PRODUCTION (step wording needs owner review per R45) |
| 11 | Dashboard names the caregiver on caregiver document rows (R32, 2026-11-17) | yes | aabe6932 | LIVE IN PRODUCTION |
| 12 | Dashboard chart colour schemes incl. primary colours (R33, 2026-11-17) | yes | aabe6932 | LIVE IN PRODUCTION |
| 13 | Care requests: closed not counted, filters (R34) | yes | a6badc6e | LIVE IN PRODUCTION |
| 14 | Care request alerts pill, mark read (R35) | yes | a6badc6e (migration 0109, route behind requestCleanup) | LIVE IN PRODUCTION (0109 applied 2026-11-21; routes live with the Offices release) |
| 15 | Client monthly calendar lists every active client (R36) | yes | a6badc6e | LIVE IN PRODUCTION |
| 16 | Cancel a document request, retire a document type (R37) | yes | a6badc6e (0109) | LIVE IN PRODUCTION (same basis as 14) |
| 17 | Every list table sortable (R38) | yes | a6badc6e | PARTIALLY IMPLEMENTED: live for Documents, Care requests, Clients, Caregivers, Staff, Billing review, Reports visit table. Not sortable (R38 "NOT YET" list; the shared sort is used by no other page): dashboard hours, monthly chain report, monthly reconciliation, correction history, caregiver hours, authorization impacts, readiness issues, schedule day lists |
| 18 | App icon and link preview (2026-11-17) | yes | f38f3f3e | LIVE IN PRODUCTION by ancestry and the web publish (the README still says "not deployed"; not checked in a browser) |
| 19 | Branded invitation emails (README of 2026-11-17: planned after the icon) | no code | none | NOT IMPLEMENTED |
| 20 | Offices: add/rename/retire, client's office (R46, 2026-11-21) | yes | cac98cfd | LIVE IN PRODUCTION (migration 0110, aeaed304) |
| 21 | Schedule Active / History view (2026-11-21) | yes | 42eab1e2 | LIVE IN PRODUCTION |
| 22 | Error messages for switched routes (2026-11-21) | yes | 10b8c69d | LIVE IN PRODUCTION (web follow-up published, d9378722) |
| 23 | Clear unworked Nov/Dec shifts (2026-11-21, data operation) | n/a (SQL + script) | 6e915c6b (record) | LIVE IN PRODUCTION as an executed operation: 41 shifts cancelled, 1 series ended, authorizations untouched |
| 24 | Correct a caregiver's invitation email before first sign-in (2026-11-22) | yes | 798f3726 | LIVE IN PRODUCTION as a tool; used on production for one caregiver (7555b030). Caregiver's first sign-in not yet confirmed |
| 25 | Assign clients and caregivers to several offices, one primary; office address/county; service counties; filters (2026-11-22) | yes | 1213c373 (0111) | LIVE IN PRODUCTION (c7691b63, 111 ledger rows) |
| 26 | Caregiver Color red/yellow/blue and the others, shown on profile, list, schedule, Reports chart (2026-11-22) | yes | 1213c373 (0111) | LIVE IN PRODUCTION |
| 27 | Who changed an assignment and when; office choice when creating a record (2026-11-22) | yes | e4fa3fab (0112) | LIVE IN PRODUCTION |
| 28 | Notifications for cover shifts to the office and to caregivers (2026-11-23) | none | none | NOT IMPLEMENTED (in-app notifications exist for staff, migration 0077; no email, text or push channel exists in code) |
| 29 | Staff bulk import (R11, older) | yes | 0105 / import routes | IMPLEMENTED BUT NOT DEPLOYED: routes `POST /v1/imports/{kind}` are on the production STAY-OFF list; PRD `bulkImport: false` |
| 30 | Duplicate staff merge (R6, older) | yes | 0106 / merge routes | IMPLEMENTED BUT NOT DEPLOYED: `GET /v1/staff/duplicates`, `POST /v1/staff/{profileId}/merge` on the STAY-OFF list; PRD `staffDuplicates: false` |
| 31 | Save-to-phone help on the public care request page | NO | 1bd7f28a (branch claude/peaceful-clarke-uw8l1h) | IMPLEMENTED BUT NOT DEPLOYED (the commit is not in c7691b63 and not on main) |

## A. Features live in production
Items 1-16, 18, 20-27 above. Production state per the operator output: ledger 111 rows (0112 last), web at c7691b63, nine routes added in each of the two releases (the route total of 276 is 258 recorded before the Offices release plus 9 plus 9; it was not re-counted), API code equal in source trees to TEST code at 7fca7784.

## B. Completed but not yet deployed
- Item 29 staff bulk import (switch OFF, routes absent).
- Item 30 duplicate staff merge (switch OFF, routes absent).
- Item 31 save-to-phone help (only on `claude/peaceful-clarke-uw8l1h`, commit 1bd7f28a).
- Item 17's completed part is live; its remainder is in C.

## C. Features still missing
- Item 28 cover-shift notifications (email, text, push) and a "cover shift available" alert to caregivers.
- Item 19 branded invitation emails.
- Item 17 sorting for the summary and figure tables listed above.
- Verification gaps recorded in the repo, not code: real-phone checks (R13, R44) and owner confirmation of items 1, 2, 3, 4, 7, 8, 9, 10.

## D. Recommended go-live items not yet built (recommendations written in repo docs)
- Separate TEST onto its own RDS instance (recommended in `docs/releases/2026-11-20-dev-validation`; TEST uses its own database `ogevia_sv_test` on the shared instance; no separate instance exists in code).
- Dependency updates for `react-router` (apps/web), `zod` (shared) and `qs` via `stripe` (SEC-4, recorded OPEN). SEC-3 overrides (a709eb1) ARE in the release.
- Branch and CDK alignment plan and the database-alignment migration 0108 (see E).
- Drift monitoring proposal (2026-10-27 production preparation record): no monitor exists in code.

## E. Production fixes that exist on branches but not on main
- `main` (466f8ac9, 2026-10-24, PR #102) contains none of the release: 351 commits in c7691b63 are not on main; main holds nothing that c7691b63 lacks. Every production release since 2026-10-26 is therefore off main.
- Branch `claude/keen-hawking-e9o2jg` (15 commits, none in c7691b63): the 2026-11-15 production deployment of the sign-in override routes and its records (a1591980, 5409d58f, ab00dc61, b3a22741, dcb1e543, 1892358f), and migration 0108 (2daa7eee, a2b75e18): a proposal to preserve two manual production database fixes of 2026-11-14 (ogevia_owner SELECT on business_documents with a policy, and EXECUTE on action_issue_rows). The proposal is NOT applied and NOT in the release.
- Configuration drift: in c7691b63 the production configuration (`infra/aws/lib/config.ts`, PRD features) has `signInOverride`, `bulkImport`, `staffDuplicates` false and none of the release switches (`requestCleanup`, `offices`, `officeAssignments`, `assignmentHistory`) on, while production runs the sign-in override routes and the nine release routes because they were added by reviewed change sets from the live template. The release scripts list these routes as retained. A deployment from this branch's configuration alone would not reproduce them (not tested).
- Branch `claude/peaceful-clarke-uw8l1h`: item 31 (1 commit).
- Branch `claude/sharp-mendel-sy1p24` itself holds five commits after c7691b63 (74ca9bf9, 66fc2809, a6c4b9bc, a432c471, 7555b030): records and two production correction-wrapper fixes; the correction on production ran from a432c471, which is not c7691b63.
