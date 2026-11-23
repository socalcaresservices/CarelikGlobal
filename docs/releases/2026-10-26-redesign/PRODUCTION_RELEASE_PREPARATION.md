# Production release preparation: 2026-10-26-redesign (staff management and the redesigned navigation)

**Status: PACKAGE PREPARED (re-built 2026-10-27, see section 12); CI ON POSTGRESQL 18 GREEN ON `6030924` AND `ea7281d`, CI ON THE LATEST HEAD PENDING; AWAITING THE OWNER'S DECISIONS AND FINAL GO. Nothing is deployed to production. No GO has been given.** Opened 2026-10-26 on the Owner's instruction ("I want this update deployed to PRODUCTION. Begin production release preparation now."). Owner and AWS Operator: Stella Okereke. TEST exceptions do not carry over to production (the Owner's words); section 4 shows what that means item by item.

Labels: VERIFIED (read from the repository, a recorded run or the read-only production capture of 2026-10-26), INFERRED, UNKNOWN. Words: *implemented*, *tested (where)*, *deployed (where)*, *accepted (by whom)*.

## 1. What was tested on TEST, and how the production code relates to it
| Item | Value | Label |
|---|---|---|
| Code deployed to TEST | commit `7870a04c43545bacc378ad93ffc6a09d63345b5a` (Handler asset `94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip`, Identity asset `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip`, 241 routes = 228 + 13 staff routes) | VERIFIED (`DEPLOYED_RECORD_TEST.md`) |
| Migration deployed to TEST | `0086_staff_management.sql` from `infra/aws/db/pending/` (sha256 `8eb7b4a3…a16a4f`), applied outside the ledger; TEST ledger stayed 85 / 0085; `verify-0086.sql` 110 of 110 | VERIFIED |
| Production code commit | `24fd8b17795dd7e0ba6f36eec1791918feefb216` (supersedes `f8cd7df` of the first package; see section 13) = the TEST-tested code plus **one configuration line** (`ENVIRONMENTS.prd.features.staffManagement: true`, commit `515c49a`, which the Owner approved) plus tests. A synthesis of this commit gives the same Handler and Identity builds as TEST (VERIFIED by the package build, which refuses otherwise) | VERIFIED |
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

## 12. Update 2026-10-27: release comparison, remaining checks, record controls
Written on the Owner's instruction of 2026-10-27. Nothing here approves, waives or accepts anything.

### 12.1 What the release is (the candidate)
| Item | Value | Label |
|---|---|---|
| Code commit the package deployed in the first draft | `f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45` (**superseded by section 13**) | VERIFIED |
| Operator tarball | `ogevia-prd-operator-f8cd7df.tar.gz`, sha256 `80f2d3eaded34520846ec0b7df5b0c1124ab1be1003110ebe657d4f9209a6bbd`, approval reference baked in: `owner-go-prd-20261027-01` (1068 manifest files; manifest sha256 `0579c46f998e704284121790e1352f63a31ece7316e49948a008bd91aee1e9e9`). It replaces the earlier tarball because the package scripts and procedure changed (12.4). Pins unchanged: migrations 0001-0085 `de0c8abb…608ef`, 0086 up `8eb7b4a3…a16a4f`, down `d2773fdf…c2942`, lockfile `7f596402…cae` | VERIFIED (build output) |
| Environment-label fix (sign-in screens and larger band) | **Included on the Owner's instruction of 2026-10-27**, as commit `d788c1f` (cherry-picked from `5de9ee2`), plus a comment-only correction in `config.ts` (`24fd8b1`, review note I-3). Web only: the API code and the synthesized API/Auth/WebHosting templates are unchanged. Production still shows no band. See section 13 | VERIFIED (git) |
| API version stamp | **Not in this release.** Planned for the next one. Verification of this release does not need it: the Handler asset hash and the web version string identify the build | decision recorded |

### 12.2 Comparison with what production runs (all production facts from `docs/aws/PRODUCTION_AS_FOUND_2026-10-26.md`)
Production runs a web bundle labelled `e80b770`, a Lambda asset `debd1d43…` (commit mapping NOT VERIFIED), ledger 85 / 0085. The release is `f8cd7df`. In plain English:

**Features and appearance** (all: not deployed to production; included; tested = automated tests and CI, plus TEST deployment of `7870a04`)
- Staff directory with staff types, invite, resend, disable and role change (Owner only). V5 invitation by e-mail not run.
- New five-section menu, Help control, Roles & Permissions page, "OWNER VIEW" label.
- Reports filter bar, legend contrast, larger "Reporting & billing" target; smaller tidy-ups (help lines, tips, headers).

**Permissions and security**
- Two new permissions `staff.read` and `staff.manage`, Owner only (not deployed; included; tested on TEST, 110 checks; second review is an AI read only, no human signature).
- 13 new JWT-authorized API routes (not deployed; included; TEST authenticated negatives 36 of 36 passed, same-agency Caregiver not run).
- Production sign-in return URLs and CORS gain `app.` and `admin.` (not deployed; included; checked by the gate on real synthesized templates only).
- Already in production and not part of this release: the dedicated production sign-in pool and the API refusing the shared pool (2026-10-21, mapping NOT VERIFIED); the website header fix for production's sign-in domain (WebHosting equals the release template).

**Database changes**
- Migration 0086 (2 tables, 21 functions, 1 trigger, 2 permissions, `note_my_sign_in` replaced, 7 default staff types per agency; ledger stays 85 / 0085): not applied to production; included; applied on TEST (110 of 110), 24 of 24 on real PostgreSQL, CI green; D-P2 undecided.
- Migrations 0047-0085: already applied in production (ledger), not part of this release.

**Infrastructure and configuration**
- `staffManagement: true` for production (`515c49a`); API stack 244 to 257 resources with the new Handler asset and two CORS origins; Auth stack URL properties; web files `e80b770` to `f8cd7df`. WebHosting: an export-only difference, not deployed. All included, none deployed.

**Tests and documentation**
- The production operator package (scripts, procedure, 223 mocked tests in 8 files plus 24 on real PostgreSQL), release records, the 0086 security review (AI read), this record, the as-found baseline, the drift proposal, release-process section 8.1.

**Production changes made outside GitHub:** see section 4 of the as-found baseline. They are largely unrecorded; each stays NOT VERIFIED.

### 12.3 Remaining checks (state at the time of writing; nothing here is passed on the Owner's behalf)
| Check | State |
|---|---|
| V1 regression set R | Not run on TEST. Not applicable to production (it writes synthetic rows) |
| V2 pilot checks | Not run |
| V3 every role walks every menu | Not run; production P3/P4 are steps of the procedure |
| V4 authenticated cross-tenant and Caregiver negatives | **PARTIAL on TEST (2026-10-26, run by the Owner in CloudShell, read-only):** 36 of 36 checks that ran passed: Owner 200 on 4 staff GET routes; same-agency non-Owner Manager 403 on 4; the test-slice Manager and Caregiver refused (404, no data) on the pilot agency's 4 routes and the Owner refused (404) on the test-slice agency's; an unknown agency 404; no organization id 400. **Not run: a same-agency Caregiver (the pilot agency has none).** The checks call the Lambda directly; they are not a browser sign-in. Not accepted as a V4 pass or exception by the Owner |
| V5 staff invitation by e-mail | **Not run.** TEST site configuration confirmed first (pool `849AYz5J7`, client `ogevia-web-prod-test-slice`, API `s0epy5rgzb`, bundle environment `test`); the Owner's browser sign-in is the next step |
| V6 role validators | **Not run** (people-run) |
| V7 human review of `SECURITY_REVIEW_0086.md` | AI second read done; **no human signature**; finding M-1 needs an Owner decision |
| V8 | Production Phase E signature is the Owner's |
| D-P2, D-P3, D-P4, D-P5, GO | Undecided / unsigned |
| CI | Green on PostgreSQL 18 for `ea7281d`; CI on the head carrying section 12 is pending |

### 12.4 New record controls in this package (documentation and scripts; no production resource touched)
- `record-deployed-prd.sh` now ends in one of three statuses: **DEPLOYED - RECORD COMPLETE** (exit 0), **DEPLOYED - RECORD INCOMPLETE** (exit 3: the pinned Handler build is live but a record check failed), **NOT DEPLOYED OR NOT PROVABLE** (exit 1). It writes `release-record.state`.
- Once that state exists, `deploy-guard-prd.sh deploy`, `apply-0086-prd.sh apply` and `web-prd.sh publish` refuse to run: nothing is redeployed automatically. Recording is read-only and is repeated. A deliberate second deployment needs the Owner's new written instruction.
- A release is closed only when `DEPLOYED_RECORD_PRD.md` is committed (release-process section 8.1, checklist E8, F8, F9).
- Tests added for each refusal; all 223 `operator-prd-*` tests pass locally.
- Drift monitoring: `docs/aws/DRIFT_MONITORING_PROPOSAL.md` (proposal only; cost and permissions; not deployed).

## 13. Update 2026-10-27 (later): the candidate now includes the label fix; D-P2 explained; V7 evidence
Nothing here approves, waives or accepts anything.

### 13.1 The candidate
| Item | Value |
|---|---|
| Code commit the package deploys | `24fd8b17795dd7e0ba6f36eec1791918feefb216` (`24fd8b1`). It supersedes `f8cd7df` and the tarball with sha256 `80f2d3ea…a6bbd`, which must not be used |
| Difference from `f8cd7df` | web files (the band on the sign-in, callback and loading screens; a larger band), their tests, one comment in `config.ts`, CI timeouts, documentation, and tests for the package. **Identical:** migration 0086 and its down file, `apps/sv-api/src`, every CDK stack file (VERIFIED with `git diff f8cd7df 24fd8b1`) |
| Effect on production | the web bundle carries the new screens; production still shows no band (`VITE_APP_ENV=production`); the API, Auth and WebHosting differences listed in section 3 are unchanged |
| What must be repeated | the tarball (rebuilt), CI on the new head, and the candidate's web build verified on TEST (`TEST_CANDIDATE_VERIFICATION.md`; NOT RUN) |
| Environment-specific configuration | `ENVIRONMENT_DIFFERENCES.md` |

### 13.2 D-P2: why 0086 is applied outside the ledger, where completion is recorded, and what stops a repeat
**The documented technical reason** (`DEPLOY_PLAN_TEST.md` row D1, decided by the Owner for TEST on 2026-10-26; `infra/aws/db/pending/README.md`):
1. The migration runner reads only `infra/aws/db/migrations` and refuses a database that has a migration "not in the repository" (`infra/aws/db/scripts/migrations.ts:86`) and any numbering gap or duplicate (`:39`).
2. The production release package is pinned to exactly migrations 0001-0085 by count and hash (the set `de0c8abb…608ef`), and production's ledger is exactly 85 / 0085 (capture, VERIFIED).
3. So there were two ways to ship 0086: (a) **promote** it into `migrations/`, which re-pins the production release package, the verification files, the tarball and the tests, and then needs a TEST run of that exact set; (b) **apply from `db/pending`** in one transaction as `ogevia_owner` with no ledger row, leaving the pins and the ledger untouched. The Owner chose (b) for TEST; D-P2 asks for the same path for production.
4. **The documented departure:** `DEPLOY_PLAN_TEST.md` section 11 says production needs "promotion of 0086 (D1a) with the production release re-pinned, a second TEST run of that exact set" and the Administrator-role decision. Option (b) for production does not do that. Choosing it knowingly accepts a production schema that is one object set ahead of its ledger until promotion.

**Where completion is recorded.** Not in the database ledger (it stays 85 / 0085 by design). It is recorded by: the database objects themselves (2 tables, 21 functions; the script reads `1|1|21`); the marker `~/ogevia-prd-before/db-0086.ok` containing `85|0085|0086` and `db-0086.snapshot` (written only after a verified apply); `RESULT.txt` of the apply run; the 110 passing checks of `verify-0086.sql`; the deployed record; and, after this release, `DEPLOYED_RECORD_PRD.md` in the repository. **Cost, stated plainly:** the database itself carries no row saying 0086 was applied; anyone asking "was 0086 applied?" must look at those records or at the objects.

**What stops a repeat run from applying it twice or incorrectly**
- The apply script requires the 0086 objects to be **absent** (`0|0|0`) before it runs, and stops otherwise (`apply-0086-prd.sh:317`: "production already has part or all of this migration. Nothing was changed"); it requires all of them present (`1|1|21`) after (`:382`).
- The SQL is a single transaction: plain `create table ogevia.staff_types` / `staff_profiles` (0086 lines 33 and 47, no `if not exists`) and inserts of the two new permission keys, so running the file again fails and rolls back whole (the apply uses `psql -1`).
- The file hash is pinned (`8eb7b4a3…a16a4f`; the pin check fails on any change) and the script refuses a package that is not exactly the approved one.
- New in this package: once `release-record.state` exists (complete or incomplete), the apply, the deploy and the web publish refuse to run again (tests added 2026-10-27).
- **Future migration runs do not apply it:** `db:migrate` and the release packages read only `db/migrations`, where 0086 does not exist, so they cannot attempt it. The ledger matches the repository's 85 files.
- **A future 0087 in `db/migrations`** would be refused by the runner's numbering rule (gap at 0086) until 0086 is deliberately promoted. That fails closed, but it forces the promotion decision, and promotion on a database that already holds the objects needs a deliberate adoption step or the down script first (`DEPLOY_PLAN_TEST.md` D1). No adoption script exists yet.

**Recommendation (not a decision):** approve D-P2 only if the Owner accepts the departure in item 4 and the missing database-side record; the controls above make an accidental repeat fail closed. The alternative is to postpone, promote 0086, re-pin and run the exact set on TEST first. Either way it is the Owner's decision; the GO draft leaves it unticked.

### 13.3 V7
See `SECURITY_REVIEW_0086_AI_SECOND_READ.md`: an AI second read of commit `f8cd7df` (the reviewed files are identical in `24fd8b1`), no blocking finding, one Medium (M-1) that needs the Owner's decision, no human review, no signature.

### 13.4 Checks still to run on TEST (NOT RUN)
Candidate web publish and verification (T0-T5), V4 caregiver checks, V5, V6: steps in `TEST_CANDIDATE_VERIFICATION.md`. Results are recorded only from the Owner's pasted output.
