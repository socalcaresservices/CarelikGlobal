# Production release preparation: 2026-10-26-redesign (staff management and the redesigned navigation)

**Status: PACKAGE PREPARED; CI ON POSTGRESQL 18 GREEN (PR #106, head `6030924`); AWAITING THE OWNER'S DECISIONS AND FINAL GO. Nothing is deployed to production. No GO has been given.** Opened 2026-10-26 on the Owner's instruction ("I want this update deployed to PRODUCTION. Begin production release preparation now."). Owner and AWS Operator: Stella Okereke. TEST exceptions do not carry over to production (the Owner's words); section 4 shows what that means item by item.

Labels: VERIFIED (read from the repository, a recorded run or the read-only production capture of 2026-10-26), INFERRED, UNKNOWN. Words: *implemented*, *tested (where)*, *deployed (where)*, *accepted (by whom)*.

## 1. What was tested on TEST, and how the production code relates to it
| Item | Value | Label |
|---|---|---|
| Code deployed to TEST | commit `7870a04c43545bacc378ad93ffc6a09d63345b5a` (Handler asset `94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip`, Identity asset `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip`, 241 routes = 228 + 13 staff routes) | VERIFIED (`DEPLOYED_RECORD_TEST.md`) |
| Migration deployed to TEST | `0086_staff_management.sql` from `infra/aws/db/pending/` (sha256 `8eb7b4a3…a16a4f`), applied outside the ledger; TEST ledger stayed 85 / 0085; `verify-0086.sql` 110 of 110 | VERIFIED |
| Production code commit | `f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45` = the TEST-tested code plus **one configuration line** (`ENVIRONMENTS.prd.features.staffManagement: true`, commit `515c49a`, which the Owner approved) plus tests. A synthesis of this commit gives the same Handler and Identity builds as TEST (VERIFIED by the package build, which refuses otherwise) | VERIFIED |
| Not in this release | everything else after `7870a04`: documentation, operator-package scripts and tests only. The only changed source file outside docs and tests is `infra/aws/lib/config.ts` | VERIFIED by `git diff --name-only 7870a04 HEAD` |

## 2. Production as it is today (read-only capture of 2026-10-26, run by the Owner in CloudShell; nothing was changed)
| Fact | Value | Label |
|---|---|---|
| Account, region | `300094796789`, `us-west-2` | VERIFIED |
| Stacks | `Ogevia-prd-DatabaseSecret`, `-EvidenceStorage`, `-WebHosting` (updated 2026-10-23), `-ServiceVerificationApi` (updated 2026-10-21), `-Observability`, `-Auth` (created 2026-10-21) and the shared `Ogevia-prod-NetworkEgress`: all settled, termination protection on | VERIFIED |
| API / Lambda | API `zk527zk4ua`, 228 routes; the Lambda serves `ogevia_prd` with `OGEVIA_ENV=prd`; code asset `debd1d43…` (last modified 2026-10-21); the previous asset exists in the CDK bucket (260,561 bytes) and the live code zip was downloaded as a recovery copy | VERIFIED |
| Web | served bundle version string `e80b770210c54e423d28ecf48e00f1dda9506cec`, environment `production`, calls only the production API host; 83 files captured | VERIFIED |
| Database | `ogevia_prd` ledger **85 migrations applied, latest 0085** (applied 2026-10-20); no staff objects expected (the apply script checks); enforcement reported "0 of 0 agencies" (the settings table has no rows: that says nothing about whether any organization exists) | VERIFIED (ledger, enforcement), UNKNOWN (contents of the tables) |
| RDS | `ogevia-prod-postgres` (shared with TEST): available, private, encrypted, backups 7 days, deletion protection on; 20 manual snapshots | VERIFIED |
| Cognito | both pools MFA on; production pool `us-west-2_FHJoX71ca` | VERIFIED |
| Real or synthetic data | the Owner stated on 2026-10-20 that production holds synthetic data only. The row counts were **not** collected and are **not** used to decide; the package neither classifies nor deletes any record. D-P3 below stays open | UNKNOWN |
| Hostnames `app.ogevia.com`, `admin.ogevia.com` | the WebHosting stack equals the release (so any aliases it holds are in place); whether DNS points at it is not part of this release | UNKNOWN (DNS) |

## 3. What the release changes in production (difference of the capture against the release templates)
| Stack | Live → release | Gate result |
|---|---|---|
| `Ogevia-prd-ServiceVerificationApi` | 244 → 257 resources: **13 staff routes added** (JWT-authorized like the others); Handler code `debd1d43…` → `94b73574…`; CORS origins `https://app.ogevia.com` and `https://admin.ogevia.com` appended. Nothing else (no IAM, role, policy, environment, permission, stage, authorizer, rule, log or secret change) | DELTA, deploy |
| `Ogevia-prd-Auth` | web client sign-in callbacks and sign-out URLs gain the `app.` and `admin.` URLs (4 properties); nothing removed | DELTA, deploy |
| `Ogevia-prd-WebHosting` | no resource difference; the template still carries the export `ExportsOutputRefTestSliceAppClient5EA2F71F`, which the release no longer has. **No stack imports it** (CloudFormation `list-imports` answered "not imported by any stack") | EXPORT-ONLY, **not deployed** |
| `-DatabaseSecret`, `-EvidenceStorage`, `-Observability`, `Ogevia-prod-NetworkEgress` | identical | NONE, not deployed |
| `ogevia_prd` | + staff types and profiles (2 tables), 21 functions, 1 trigger, 2 permissions; `note_my_sign_in` replaced; 7 default staff types seeded per existing agency; **ledger stays 85 / 0085**; nothing existing is dropped, deleted or updated | applied by `apply-0086-prd.sh` |
| Web files | version `e80b770…` → `f8cd7df…` with production's own embedded values | published by `web-prd.sh` |

## 4. V1–V8: passed, waived on TEST, and the production disposition
| # | TEST result | Carries over? | Production disposition in this package |
|---|---|---|---|
| V1 regression set R (`pilot_regression.py`) | EXCEPTED, not run | **No** | The runner writes synthetic rows and uses the TEST pilot accounts: it **must not** be pointed at production. Production disposition: **not applicable to production; run on TEST (same code) before the GO if the Owner wants the evidence**, or the Owner records an exception. Production gets the checks in "P" below |
| V2 pilot checks (`pilot_smoke.py`) | EXCEPTED, not run | **No** | Same: TEST-only (hard-coded synthetic pilot identities). Optional on TEST; production gets P1–P7 |
| V3 every role walks every menu; API log searched | EXCEPTED (Owner role only) | **No** | Production: **P3** (Owner walk; a non-Owner account if one exists) and **P4** (log search for ERROR events, read-only, counts only) are steps of the procedure |
| V4 other-tenant and Caregiver negatives | EXCEPTED (401 / forged token on 13 routes passed) | **No** | Production: **P1** (13 routes × 2 unauthenticated calls, 26 results, run by the package) and the SQL-level negatives (110 checks in `verify-0086.sql` plus the tenant-isolation sweep, run in the full test gate). The authenticated cross-tenant check needs a second organization and a caregiver sign-in: **OPEN** (see D-P4) |
| V5 staff invitation by e-mail | EXCEPTED | **No** | Not run in production: it would create a real Cognito user and send real e-mail. **OPEN**; recommended: run once on TEST with an inbox the Owner controls, or accept an exception for production |
| V6 Scheduler, Caregiver (phone), Authorization validators | EXCEPTED | **No** | **OPEN.** These cover the caregiver and authorization screens, which this release does not change in the database or API beyond the staff additions; the Owner decides whether to require them |
| V7 reviewer signature, `SECURITY_REVIEW_0086.md` | EXCEPTED (author-prepared only) | **No** | **OPEN.** A second person reads the 0086 SQL against the checklist, or the Owner records a production exception in writing. Residual notes R-1 to R-4 in that file remain |
| V8 signatures | SIGNED for TEST | **No** | Production Phase E signature and the explicit GO are the Owner's |

The "P" checks in the procedure: **P1** unauthenticated route smoke; **P2** database markers and the 110 SQL checks; **P3** Owner walk (and one non-Owner account if present); **P4** ERROR log count and ComplianceSweep; **P5** ledger 85 / 0085 and 0086 present afterwards; **P6** people-and-access counts equal before and after; **P7** deployed record mapping every artifact to the commit.

## 5. Records, accounts, permissions and audit history
- The release deletes and updates nothing. The apply is one transaction that creates new objects; `note_my_sign_in` is replaced (restored by the rollback). The script compares the row counts of `app_users`, `organization_memberships`, `audit_events`, `caregiver_records` and `organizations` before and after and stops if any differs.
- Audit events, memberships and roles are never touched. The new permissions `staff.read` and `staff.manage` are held by the Owner role only.
- No TEST data is copied into production; the package contains no production data and reads none beyond ledger and counts.
- The procedure never creates staff, users, invitations or clients in production.

## 6. Backup and rollback
| Layer | Before | Rollback |
|---|---|---|
| Database | a manual, encrypted RDS snapshot `ogevia-prod-postgres-pre-0086-prd-YYYYMMDDHHMM` taken **inside the window** and verified before any change (Step 7); it also contains `ogevia_sv_test`, so it is never restored in place | R3: the pinned down script drops the two staff tables **with their rows** (BACKUP REQUIRED) and restores `note_my_sign_in`; rehearsed on a real PostgreSQL. Last resort R4 (isolated restore), not rehearsed on AWS |
| API | previous code asset `debd1d43…` verified present; live zip downloaded | R2: `update-function-code` from the verified asset (code only; CloudFormation then needs a reconcile step chosen by the Owner) |
| Auth | client URLs captured | R2b: the change only adds URLs; leaving them breaks nothing |
| Web | the whole bucket (83 files) downloaded with a hash manifest | R1: `web-prd.sh rollback` (restores captured files, puts back the captured `index.html`, verifies; deletes nothing) |

## 7. Remaining risks (each stated, none hidden)
1. **The package has never run against AWS.** It was tested with fake `aws`/`psql`/`curl`/`npx`, real synthesized templates and a real PostgreSQL. Its TEST twin ran in CloudShell on 2026-10-25/26 and passed its steps. (NOT VERIFIED on production)
2. **The Handler asset key may differ in production's CloudShell** (the key depends on the build environment). TEST's CloudShell reproduced it; Step 4 checks it and stops otherwise. (INFERRED safe)
3. **Rollbacks R1, R2, R2b, R4, R5 are documented, not rehearsed on AWS.** R3 is rehearsed on a real PostgreSQL.
4. **The shared RDS instance and VPC:** a temporary single `/32` rule is added to the shared RDS security group three times (Steps 6, 9, 16) and verified removed each time; a failure to remove it is exit 3 with prepared commands (R5).
5. **Data classification is not verified.** The Owner's statement of 2026-10-20 (synthetic only) is recorded; nothing in this package depends on it or changes it. If production now holds real client data, 0086's seeding and the staff pages operate on it as designed; the rollback (R3) drops only the staff tables.
6. **V4 (authenticated cross-tenant and Caregiver negatives), V5, V6 and V7 remain open** unless the Owner runs or excepts them in writing (D-P4).
7. **Hostnames:** `app.ogevia.com`/`admin.ogevia.com` DNS is outside this release; the added Cognito URLs and CORS origins are harmless if DNS does not point at the distribution.
8. **Users signed in during the web publish** see the new menu after a refresh; the release window is outside business hours for that reason.
9. **Stella is both Owner and Operator;** the procedure is written so that the Operator pastes back evidence and the development session reads it, which gives a second look.

## 8. Proposed execution window (Pacific time, with UTC; DST is in force until Sunday 2026-11-01, so Pacific = UTC − 7)
| | Pacific | UTC | Note |
|---|---|---|---|
| **Recommended window** | Tue 2026-10-27 20:00 → Wed 2026-10-28 04:00 PDT | `2026-10-28T03:00:00Z` → `2026-10-28T11:00:00Z` | 8 hours (limit 12); leaves a full day to review the package and decide V4–V7; evening/overnight, outside business hours |
| Alternative (if the GO is given today) | Mon 2026-10-26 20:00 → Tue 2026-10-27 04:00 PDT | `2026-10-27T03:00:00Z` → `2026-10-27T11:00:00Z` | possible only if D-P4 is decided today |
Expected operator time: about 90 to 120 minutes (snapshot 5 to 15 minutes, apply a few minutes, two stack deployments, web publish, checks). Start the clock at Step 7: the snapshot must be taken inside the window. If a stop condition fires the procedure ends and waits; nothing is retried with changed values.

## 9. Test evidence (local run: committed state `37250c9`, PostgreSQL 16; CI run: PR #106, head `6030924`, PostgreSQL 18; RDS runs 18.3)
| Check | Result |
|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm build` | exit 0 each (6 of 6 tasks) |
| `pnpm test` | exit 0; infra: 44 files, 997 tests passed, none skipped |
| New production package tests (`test/operator-prd-*.test.ts`) | gate and assembly (64), deploy guard (35), apply (55), ledger recheck (18), snapshot and smoke (16), web guard, baseline and record (9), tarball and pin check (11), procedure (12): all passed |
| `pnpm test:db` in `apps/sv-api` | exit 0; 22 files, 152 tests passed |
| `pnpm test:db` in `infra/aws` | **1,216 passed, 27 failed** in three older files: `auth-cutover-scripts.db.test.ts` (6), `prd-rehearsal.db.test.ts` (8), `prd-release-exec.db.test.ts` (13). The new `operator-prd-sql.db.test.ts` (24 of 24, real PostgreSQL) passed |
| The 27 local failures | Identical (the same 27) at `7870a04`, `a9d1ae6` and `f8cd7df` in this container (PostgreSQL 16), so not caused by this package or the production flag. **Resolved by CI on PostgreSQL 18: those three files pass there** (see the next row). Cause: this container's PostgreSQL version (VERIFIED by the CI result, not by reproducing on 18 locally) |
| **CI on PostgreSQL 18 (GitHub Actions, `postgres:18`), PR #106, head `6030924`** | `postgres` job (`pnpm test:all`: unit, infra database and API tests, 0 skipped allowed): **success**, 30 min 37 s. `validate` (typecheck, lint, build, `pnpm test`, deployment bundle): **success**, 23 min 47 s. `harness`: **success**, 1 min. The PR is mergeable (clean), draft, with no review threads. History of the run: run 1 (`22435a6`) `postgres` success, `validate` cancelled at its 15-minute limit; run 2 (`fb200e8`, `validate` 30 minutes) `validate` success, `postgres` cancelled at its 30-minute limit with no failed test seen; run 3 (`6030924`, `postgres` 60 minutes) all three jobs green. The only changes between runs are the two timeout lines in `.github/workflows/ci.yml` (no test skipped or removed, none of the package changed, the tarball is unaffected) |

## 10. Decision gates for the Owner
| Id | Decision | State / recommendation |
|---|---|---|
| D-P1 | Enable the 13 staff routes in production (`staffManagement: true`) | **Approved by the Owner on 2026-10-26** (in scope of the instruction) |
| D-P2 | Apply 0086 to production outside the ledger, the same tested path as TEST (the ledger stays 85 / 0085; the reason, the tracking and the repeat-run protection were explained in the session) | **Needs the Owner's explicit approval**; recommended yes |
| D-P3 | Whether production data is synthetic or real | Not decided by the package; the Owner's 2026-10-20 statement is recorded; nothing is inferred from counts |
| D-P4 | V3/V4/V5/V6/V7 for production: run each, or record a written Owner exception per item. (The earlier open item "the 27 database failures on PostgreSQL 18" is closed: CI is green.) | Recommended: run V7 (second reader of the 0086 SQL) and the authenticated V4 negatives on TEST before the GO; accept V5/V6 exceptions in writing if they are not wanted |
| D-P5 | The window (section 8) | Recommended: Tue 2026-10-27 20:00 PDT → Wed 04:00 PDT |
| GO | Final GO message naming the Operator, window, approval reference, tarball sha256 and admin host IP | After the package is accepted |

## 11. Next
The Owner reviews this record and the operator procedure, answers D-P2, D-P4 and D-P5, and gives the GO message (template in the session). After the GO the development session guides the Operator step by step and verifies the live production application from the pasted evidence; the deployed record is written only from that evidence. Nothing is pushed, merged or deployed without the Owner's explicit instruction.
