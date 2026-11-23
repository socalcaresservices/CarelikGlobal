# Feature test plan: 2026-10-26-redesign (staff management + navigation, Help, Reports, Staff, Roles & Permissions)

Written after the build (a gap against `TESTING_AND_RELEASE_PROCESS.md` section 3: the plan should precede the code). The cases below are what the work was tested against and what Phase C and D must repeat. New IDs are proposed for the catalog (prefixes `NAV`, `STF`, `ROL`, `HLP`, `RPT-1x`); they are not yet in `ACCEPTANCE_TEST_CATALOG.md`.

## 1. The change
| Field | Value |
|---|---|
| Requirement and source | Owner directives 2026-10-25 (staff management, navigation, text removal, report numbering) and 2026-10-26 (redesign: groups Dashboard, Clients, Staff, Scheduling, Operations, Settings, My Work; Help control; Reports filter bar; Staff and Roles & Permissions tables) |
| Per role | **Owner**: Staff, Staff Types, Roles & Permissions, Agency Settings, Reports, Billing. **Manager/Scheduler**: same pages as before in a new menu; no Staff Types or Roles & Permissions. **Caregiver**: My Work only (My Schedule, Verify Visit; Availability and My documents as tabs). |
| Must NOT change | Every route and its permission; calculations, billing states, exports; authorization limits; scheduling and visit rules; tenant isolation; audit; appearance settings |
| Migrations, routes, screens | Migration 0086 (staged, `infra/aws/db/pending`); 13 API routes under `/v1/staff*`, `/v1/role-permissions`; screens: shell and menu, Staff, Staff Types, Roles & Permissions, Reports filter bar, page titles, Help |
| Catalog areas (process 6.3) | USR, DSH, RPT, AUT (unchanged numbers), SCH (menu only), plus set R and the isolation cases; Migration: rollback cases |
| Harness data | Seeded demo agency covers it; 0086 applied to the harness database as `ogevia_owner` (harness:setup does not apply pending migrations; a step to add if this becomes a release) |
| Only TEST can prove | Cognito invitation of a staff member (email, temporary password flow, MFA), API Gateway authorizer on the 13 new routes (401), CloudFront serving the new bundle and headers, CORS from `demo.ogevia.com`, real latency |

## 2. Test cases
| ID | What | How | Expected | If it fails |
|---|---|---|---|---|
| NAV-01 | Sidebar groups and order | AUTO `nav.test.tsx`, `sidebar-home.test.tsx`, `route-map.test.tsx`; HARNESS `verify-redesign.mjs` | Owner: Dashboard, Clients (Clients, Authorization changes), Staff (Caregivers, Staff, Staff Types), Scheduling (Schedule), Operations (Reports, Billing), Settings (Roles & Permissions, Agency Settings) | Stop; redeploy previous web |
| NAV-02 | No destination lost | AUTO `nav.test.tsx` "every destination..."; HARNESS 24 destinations open without error | Every pre-redesign link reachable from sidebar or tab | Stop |
| NAV-03 | Menu shows only permitted items | AUTO `route-map.test.tsx`; PILOT: each role | Manager: no Staff Types, Roles & Permissions. Scheduler: no Billing. Caregiver: My Work only. A hidden item is still refused by the server (USR-01) | Stop; security |
| NAV-04 | Active group opens, manual state kept, drawer closes after choosing a page | AUTO `nav.test.tsx`; HARNESS phone | As stated | Fix before GO |
| NAV-05 | Badges are server counts, never a sum of unlike counts | AUTO `attention-counts-badges.test.tsx` | Billing 4 and Visits to review 5 stay separate; a closed group with two sources shows a dot | Stop |
| NAV-06 | Appearance reachable by everyone | AUTO `sidebar-home.test.tsx`; PILOT caregiver | Footer link works for every role | Fix before GO |
| HLP-01 | Help opens on hover, focus, click, tap; closes on Escape, Close, outside tap; never blocks | AUTO `info-tip.test.tsx`; HARNESS mouse, keyboard, touch | As stated | Fix before GO |
| HLP-02 | No help text over 250 characters | AUTO `info-tip.test.tsx` source scan | 0 over | Fix before GO |
| STF-01 | Staff list: Name, Staff Type, Role, Status, Email, Phone; numbered; phone layout | AUTO `staff-pages.test.tsx`; HARNESS 1360 and 390 | As stated; contact email only, never the sign-in email | Stop |
| STF-02 | Search and Staff Type, Role, Status filters; Clear Filters; numbers follow the filter | AUTO + HARNESS | Narrowed lists, 1..n | Fix before GO |
| STF-03 | Row actions are true: Invite, Invite again, Disable, Enable, Edit; none for yourself | AUTO `staff-pages.test.tsx` | As stated | Stop |
| STF-04 | Add staff, edit, invite, resend, change role, disable/enable through existing account rules; history | AUTO `staff-pages.test.tsx`, `apps/sv-api/test/staff.db.test.ts`; PILOT with an inbox the owner controls | Invitation recorded, status Invited, no duplicate person; role changes need a reason; Owner role cannot be assigned | Stop |
| STF-05 | A staff type never grants access | AUTO `staff-management.db.test.ts` "a type named like a powerful role grants NOTHING" | Permissions identical before and after a type change | Stop; security |
| STF-06 | Only the Owner manages staff; other agencies see nothing | AUTO `staff-management.db.test.ts`, `staff.db.test.ts`, `tenant-isolation-sweep.db.test.ts`; PILOT Manager and Scheduler | 403/404 as designed; screens refuse | Stop; security |
| ROL-01 | Role table: description and real users assigned | AUTO `staff-pages.test.tsx`; PILOT compare counts with Staff list | Counts equal active memberships per role | Stop |
| ROL-02 | Permission matrix: granted / not granted, no keys, read only | AUTO + HARNESS | As stated; matrix equals the server's role_permissions | Stop |
| RPT-10 | Filter bar: Month for monthly reports, Start/End for date-range reports, only supported filters, Clear Filters | AUTO `service-verification-reports-page.test.tsx` | As stated | Fix before GO |
| RPT-11 | Print / PDF and Export CSV together; exports unchanged | AUTO export tests; PILOT export compared with screen (RPT-05) | Same rows and totals as before the change | Stop |
| RPT-12 | Chart legend and link readable and tappable | HARNESS appearance matrix | 0 contrast, 0 undersized | Fix before GO |
| DSH-13 | Zero urgent shows "No urgent items", no number | AUTO `attention-badge.test.tsx` | As stated; urgent items still show count | Fix before GO |
| MIG-86a | 0086 applies once, idempotent refusal on a second run | AUTO `staff-management.db.test.ts`; PILOT | One set of objects | Stop; down script |
| MIG-86b | Rollback leaves people, roles and history | AUTO rollback test; PILOT only if the owner approves | People, memberships, audit unchanged | n/a |
| MIG-86c | Existing `note_my_sign_in` still works | AUTO same file; PILOT sign-in of each role | Sign-in recorded | Stop |
| API-86 | 13 routes: 401 without a token, 403 wrong role, 404 other agency, 400 bad input | AUTO sv-api tests; PILOT 401 for all 13 | As stated | Stop; security |
| R | Regression set R and smoke S | `pilot_regression.py`; catalog | All PASS | Stop |

## 3. Failure-first checklist
Invalid input (API-86, STF forms) ✔ · Stale data (list refetch after each action) ✔ · Two people at once (existing advisory locks; invitation counters) ✔ · Retried/duplicated request (invitation begin/complete idempotent per profile) ✔ · Wrong role ✔ · Other agency ✔ · Network failure at submit: forms keep their text and show the error (UI tests) ✔ · Database failure mid-way: each function is one transaction ✔ · Old data and old links: old routes redirect (route-map test) ✔ · **Not applicable**: signature, time-zone and calculation cases (unchanged code).

## 4. Numbers that must agree
| Figure | Where | Single source | Check |
|---|---|---|---|
| Users assigned per role | Roles & Permissions | `organization_memberships` (active) via `list_role_permissions` | Count rows per role on Staff (filter by Role); equal |
| Navigation badges | Sidebar, tab strip, Home | `/v1/attention` counts | Same number as Action Needed / Billing Ready for Approval |
| Report hours and CSV | Reports, exports | Unchanged server calculations | RPT-05 |

## 5. Evidence plan
Before/after screenshots: `screenshots/before` and `screenshots/after` (harness, done). Appearance matrix: done (64-run re-runs). Pilot checks the harness cannot prove: section 1 above. UAT scripts: `DEPLOY_PLAN_TEST.md` section 9.

## 6. Rollback plan (whole change)
| Layer | Action | What it cannot undo | Who | Time |
|---|---|---|---|---|
| Web | Re-publish the captured previous files and invalidate CloudFront | Nothing | Operator | ~5 min |
| API | Previous Handler code (CDK deploy of the stack at the previous commit); the 13 routes disappear | Nothing | Operator | ~10 min |
| Database | `rollback/0086_staff_management.down.sql` (BACKUP REQUIRED: drops staff profiles and types with their rows; sign-ins, memberships, roles, audit stay); restore only to a NEW instance, by separate approval | Staff profiles and types created during the test window | Operator | ~10 min |
| Data created | Never deleted by hand; Cognito users created by test invitations stay (TEST pool) | | | |
