# Release checklist: 2026-10-26-redesign (TEST)

Prepared 2026-10-26. Status of this release: **implemented; tested (development, local harness); NOT deployed anywhere; NOT accepted.** Boxes are ticked only where this container produced the evidence; everything that needs AWS or a person is left open.

Copy this file to `docs/releases/<release-id>/CHECKLIST.md` and complete it. **Every box must be ticked or marked N/A with a reason.** A blank line is a failed line. Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. Status words: proposed, implemented, tested, deployed, accepted (never interchangeable).

Evidence rules: link or paste real command output and screenshots. Never include passwords, tokens, secret values, real client or caregiver data, or signature images.

---

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-10-26-redesign` |
| Commit SHA to deploy (full 40 characters) | `7870a04c43545bacc378ad93ffc6a09d63345b5a` (code). Later commits on the branch are documentation only. |
| Branch / pull request | `claude/redesign-review-nav-ui`; no pull request opened |
| Prepared by (name, date) | Claude Code session, 2026-10-26 (owner approval for TEST given in the session; window, Operator and approval reference still to be named: `DEPLOY_PLAN_TEST.md` D4) |
| Change classification | ☑ feature ☑ migration ☑ API ☑ dashboard ☑ report ☐ scheduling ☐ authorization ☐ visits/verification ☐ availability/matching ☑ user admin ☐ notifications ☐ infrastructure (routes only) ☐ web only |
| Feature Test Plan | `FEATURE_TEST_PLAN.md` (written after the build: a process gap, noted) |
| Catalog areas required (process section 6.3) | USR, DSH, RPT, plus set R and the isolation cases; migration rollback cases; API route area |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations in this release (**include every earlier migration not yet live**) | **0086** `staff_management` (staged in `infra/aws/db/pending`, applied to TEST only, no ledger row: decision D1). Earlier migrations: none missing; 0001-0085 unchanged since the last recorded TEST deployment (`e80b770`, ledger 85 / 0085) |
| Rollback script for each migration (path, class) | `infra/aws/db/pending/rollback/0086_staff_management.down.sql`, BACKUP REQUIRED (drops 2 tables with rows) |
| API routes added / changed / removed | +13 (`/v1/staff-types` x4, `/v1/staff` x5, `/v1/staff-members/{id}/profile`, `/v1/staff-roles/{id}`, `/v1/role-permissions`, `/v1/staff-audit`); none changed or removed |
| Screens added / changed | Added: Staff, Staff Types, Roles & Permissions. Changed: shell and menu, Help control, Reports filter bar and actions, Clients/Schedule/Caregivers titles, Dashboard title, top status |
| Infrastructure (`cdk diff` summary: expected resources only) | Expected: `Ogevia-prod-ServiceVerificationApi` +13 routes and Handler code only; `WebHosting` no difference if the 2026-10-23 hostname changes are live (D2). Offline evidence only; the live diff is Step 8 |
| What deliberately does NOT change | Production (`Ogevia-prd-*`, `ogevia_prd`, Cognito production pool); any calculation, billing state or export; permissions of existing routes; Netlify, Supabase, DNS, `config.json` |
| Data changed or created by the release | Default staff types seeded per agency (7 each); `note_my_sign_in` replaced; nothing else |

---

## A. Development gates (Phase A)
Run on a clean checkout of the commit above. Paste the summary line of each. `OGEVIA_TEST_DATABASE_URL=<local database> pnpm test:all` runs A4, A6 and A7 together and fails on any skipped test; if you use it, paste its final `PASS` line and the counts in A4, A6 and A7.

| # | Gate | Command | Result | Evidence |
|---|---|---|---|---|
| A1 | Install | `pnpm install --frozen-lockfile` | ☑ ok | Worktree installed with the frozen lockfile; a second frozen install from the operator tarball also succeeded (`PINS HOLD`). 2026-10-26 |
| A2 | **Lint (G1)** | `pnpm lint` | ☑ exit 0 | SHA `bfb851c`: `Tasks: 6 successful, 6 total` (5 from the turbo cache, same inputs). Lint in this repo is `tsc --noEmit` |
| A3 | **Typecheck (G2)** | `pnpm typecheck` | ☑ exit 0 | SHA `bfb851c`: `Tasks: 7 successful, 7 total` (6 cached) |
| A4 | **Unit and static tests (G3a)** | `pnpm test` | ☑ exit 0. Counts: 2,456 tests, 0 failed (shared 118, auth 150, sv-api 96, ui 73, web 1,263 in 129 files, infra-aws 756 in 35 files) | Run as part of `pnpm test:all` on SHA `bfb851c`, clean tree: `PASS all suites ran, none skipped, all passed.` |
| A5 | Build | `pnpm build` | ☑ exit 0 | SHA `bfb851c`: `Tasks: 6 successful, 6 total`, 0 cached. turbo warns that five packages declare no output files (a configuration warning, not a failure) |
| A6 | **Database tests (G3b)** | `OGEVIA_TEST_DATABASE_URL=... pnpm --filter @carelik/infra-aws test:db` | ☑ all passed, **0 skipped**. Counts: 1,218 tests in 103 files | Local PostgreSQL 16; part of `pnpm test:all` on `bfb851c`. Includes `operator-0086-sql.db.test.ts` (real PostgreSQL, real 0001-0085 migrations) |
| A7 | **API tests (G3c)** | `OGEVIA_TEST_DATABASE_URL=... pnpm --filter @carelik/sv-api test:db` | ☑ all passed, **0 skipped**. Counts: 152 tests in 22 files | Same run; includes `tenant-isolation-sweep.db.test.ts` |
| A8 | CI run on the pull request | link | N/A: no pull request is open (none was requested) | |
| A9 | Test counts did not drop versus the baseline (process section 3.1) | | NOT VERIFIED: no baseline count was recorded for the pre-redesign commit in this session, so a comparison would be invented. Tests were added (the redesign, staff management and the operator package); none was deleted or skipped on purpose. One test (`dst-local-times`) was edited to be date-independent (`bfb851c`); no product code changed in that commit | |

Change-specific:
- ☐ Bug fix: the reproducing test **failed before** the fix (failure text recorded) and **passes after**: ____________
- ☐ Every changed rule has a test that fails without the change, and a control test: ____________
- ☐ Failure-first cases covered: PARTIAL, evidenced for the operator package (15 SQL sabotage cases, snapshot/pin/ledger/people-count/interruption/failed-revoke cases) and the staff-management and tenant-isolation DB tests; not yet itemised per case ID. Left open for the Phase D reviewer
- ☑ Migration: one new file (`db/pending/migrations/0086_staff_management.sql`); applied files unedited (set hash of 0001-0085 `de0c8abb…` equals the one applied to TEST on 2026-10-19); `.down.sql` present, classified BACKUP REQUIRED; rollback and round-trip run on a real PostgreSQL (`operator-0086-sql.db.test.ts`). `01_schema_version.sql` and the ledger-tail tests are unchanged by design: 0086 writes no ledger row (decision D1 b), so the ledger tail stays 0085
- ☐ Migration touches `SECURITY DEFINER`, grants or tenant access: `docs/security-review-checklist.md` completed: OPEN. `verify-0086.sql` checks the grants mechanically (fixed `search_path`, no PUBLIC, `ogevia_app` execute only, RLS on), but the checklist document itself has not been completed in this session
- ☐ API (OPEN, not itemised): permission, other-tenant, unauthenticated, bad-input and (if it creates records) idempotency tests exist; `slice-contract.test.ts` passes
- ☐ UI (OPEN here; screenshots and checks are in `REDESIGN_NOTES.md`): loading, empty, error, success states; 390 px and 1280 px checked; no horizontal page scroll; contrast tests pass
- ☐ No instructional paragraph where a label or tooltip works

**Phase A signed:** name ____________ date ____________

## B. Local harness (Phase B), gate G4
| # | Step | Result | Evidence |
|---|---|---|---|
| B1 | `harness:setup` run on this commit (fresh database, all migrations applied; migration count: 85) | ☑ with a caveat: `harness:setup` applies 0001-0085 only; **0086 was applied to the harness database by hand as `ogevia_owner`** (it is pending). To fix if this becomes a release: apply pending migrations in setup | Session log 2026-10-26 |
| B2 | `harness:build` and `harness:serve` run on this commit | ☑ (built after the last code change, 7870a04) | |
| B3 | Seed data covers the change (if not, `setup.ts` was extended in this change) | ☑ demo agency has an Owner, Manager, Scheduler, caregivers, 11 staff rows | |
| B4 | Every catalog ID in the Feature Test Plan performed as the named persona (list IDs and PASS/FAIL below) | ☐ partial: `verify-redesign.mjs` ALL PASS covers NAV-01..04, HLP-01, STF-01..03, STF-06 (Manager, Scheduler), ROL-01, ROL-02, RPT-10 (via tests). **Not done in a browser on the harness: STF-04 (invite/role change; automated tests only), RPT-11 export file comparison, DSH-13 zero state.** | `verify-redesign.mjs` output in the session; script kept in this folder |
| B5 | Screenshots saved under `docs/releases/<release-id>/evidence/` (desktop 1280 for administrator, 390 for caregiver) | ☑ desktop 1360 and emulated phone 390, as `screenshots/before` and `screenshots/after` (not under `evidence/`; no caregiver-persona screenshots) | `screenshots/` |
| B6 | Bug fix or rule change: **before and after** screenshots of the same record | ☑ before (starting commit) and after, same data | `screenshots/` |
| B7 | Browser console and network: no unexpected errors or 4xx/5xx | ☐ not recorded: the harness server log showed no error lines during the runs; the browser console was not captured | |
| B8 | Negative checks: forbidden action refused for the wrong role; Caregiver sees no Administrator data | ☑ Manager and Scheduler refused on Roles & Permissions; caregiver menu is My Work only (`verify-redesign.mjs`) | |
| B9 | Regression set R spot-checked | ☐ automated R in test suites only; no manual R pass on the harness for this commit | |
| B10 | List what the harness **cannot** prove and that this change touches (Cognito, authorizer, IAM, S3/KMS, CloudFront, RDS TLS, email): staff invitation through Cognito and email; authorizer on the 13 new routes; CloudFront bundle and headers; CORS from `demo.ogevia.com` | ☑ carried to C6 | |

Catalog results (copy rows as needed):
| Catalog ID | Persona | PASS / FAIL | Notes |
|---|---|---|---|

**Phase B signed:** name ____________ date ____________

## C. Pilot/test environment (Phase C), gate G5
Owner has stated in writing: commit SHA ______, target **pilot/test only**, who runs it ______, window ______. ☐ recorded (link).

| # | Step | Result | Evidence |
|---|---|---|---|
| C0 | Target confirmed as pilot/test: stacks `Ogevia-prod-*`, database `ogevia_sv_test`, banner "TEST — synthetic data only" visible. **Not** `Ogevia-prd-*` | ☐ | |
| C1 | Pre-flight (read-only): migration ledger **before**: `count=__ max=____` (expected: ____) | ☐ | |
| C2 | Previous web bundle and previous API template captured (rollback inputs) | ☐ | |
| C3 | Manual RDS snapshot taken. Identifier: ____________ status `available` | ☐ | |
| C4 | Deployed in order: database, API, web, using the reviewed script/commands: ____________ | ☐ | |
| C4a | `cdk diff` shows only the expected resources (anything else: STOP) | ☐ | |
| C4b | Ledger **after**: `count=__ max=____` (expected: ____); verification SQL `db:verify` all PASS | ☐ | |
| C5 | Smoke: standard suites (`smoke.py`, `pilot_smoke.py`, release live checks) and catalog set S | ☐ | |
| C6 | Changed workflows verified on the pilot, **including the items listed in B10** | ☐ | |
| C7 | Regression set R: all PASS. Automated part: `pilot_regression.py` exit code 0, report attached (`docs/release-process/PILOT_REGRESSION_RUNNER.md`); remaining cases by hand | ☐ | |
| C8 | Every role opened every menu item: no error screens; API logs searched for 5xx and error codes for the window (read-only) | ☐ | |
| C9 | Negative checks: unauthenticated 401, forged token 401, other tenant sees nothing, Caregiver cannot reach Administrator data | ☐ | |
| C10 | Rollback readiness: previous bundle and template available; down script rehearsed (tests; on the pilot if the owner approved) | ☐ | |

Catalog results on the pilot (copy rows as needed):
| Catalog ID | Tester | PASS / FAIL | Notes |
|---|---|---|---|

Any FAIL: stop. Fix forward with a new commit and **restart at Phase A**.

**Phase C signed (Operator + validator):** names ____________ date ____________

## D. User acceptance (Phase D)
Run on the pilot/test environment with synthetic data, from scripts built from the Feature Test Plan.

| Validator | Name | Scripts run (catalog IDs) | Result | Open defects | Signature / date |
|---|---|---|---|---|---|
| Owner | | | ☐ accepted ☐ rejected | | |
| Scheduler | | | ☐ accepted ☐ rejected | | |
| Caregiver (phone) | | | ☐ accepted ☐ rejected | | |
| Authorization (three balances recalculated by hand: low use, near limit, amended; match to the minute) | | | ☐ accepted ☐ rejected | | |

Defect log:
| # | Class (Blocker / Major / Minor) | Description (steps, screen) | Status | Owner exception (Major only) |
|---|---|---|---|---|

☐ No open Blocker. ☐ No open Major, or each has a written owner exception.

## E. Production approval (Phase E), gate G6
| # | Item | Done | Link |
|---|---|---|---|
| E1 | Change summary (per role, plain words; all migrations including earlier undeployed ones) | ☐ | |
| E2 | Risk assessment (cause, likelihood, effect on money/hours/access/data, detection, reversal) | ☐ | |
| E3 | Rollback plan: order (web, API, database), commands, what each step cannot undo, who runs it, duration, the point at which rollback is called | ☐ | |
| E4 | **Backup confirmation**: production snapshot identifier ________ time ________ status `available`; backup retention ________ days; S3 signature bucket versioning confirmed; restore goes to a NEW instance (separate approval) | ☐ | |
| E5 | Evidence index complete (this checklist, test output, screenshots, UAT sign-offs) | ☐ | |
| E6 | All six gates passed: G1 ☐ G2 ☐ G3 ☐ G4 ☐ G5 ☐ (G6 is this decision) | ☐ | |
| E7 | Deployment window and Operator named; owner available for post-deploy checks | ☐ | |

### Decision record
| Field | Value |
|---|---|
| Decision | ☐ **GO** ☐ **NO-GO** |
| Owner (name) | |
| Date and time | |
| Commit SHA the decision covers | |
| Approval reference | |
| Window | |
| Operator | |
| Conditions or exceptions (written) | |

A GO covers that SHA and that window only.

## F. After deployment (production)
| # | Step | Result | Evidence |
|---|---|---|---|
| F1 | Same SHA and same script as the pilot | ☐ | |
| F2 | Ledger after: `count=__ max=____` | ☐ | |
| F3 | Read-only production smoke (`deploy-production.sh smoke`) | ☐ | |
| F4 | Owner checks the changed workflows with the owner's own account | ☐ | |
| F5 | Monitoring period observed (length: ____): no new 5xx, no support reports | ☐ | |
| F6 | Release marked **deployed** and **accepted**; this folder committed | ☐ | |
| F7 | Rollback invoked? ☐ no ☐ yes (details, time, result): | | |
