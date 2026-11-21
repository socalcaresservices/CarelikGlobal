> Current owner decisions (2026-11-10): Excel/ZIP parsing and exceljs are removed; the Excel-library options below are historical and require no selection. SEC-5 privacy is accepted as built. Duplicate merge stays OFF in both environments. CPR/TB remains one-click. Current evidence/commands: RELEASE_READINESS.md and TEST_DEPLOYMENT_PLAN.md. No new sign-off form is requested. The prepared DB script uses a TEST-only logical dump, refuses instance snapshots, and records migration checksums transactionally. Nothing deployed or applied to AWS.

# Release checklist: 2026-11-10-ux-redesign-test (TEST only; Phase A and B evidence prepared, C to E NOT STARTED)

> Status 2026-11-10: nothing deployed. Evidence for A and B is in `RELEASE_PACKAGE.md` section 6 and `docs/ux/REQUIREMENTS-TRACKER.md`. Phase C waits for the owner's written statement (SHA, TEST only, operator, window).

Copy this file to `docs/releases/<release-id>/CHECKLIST.md` and complete it. **Every box must be ticked or marked N/A with a reason.** A blank line is a failed line. Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. Status words: proposed, implemented, tested, deployed, accepted (never interchangeable).

Evidence rules: link or paste real command output and screenshots. Never include passwords, tokens, secret values, real client or caregiver data, or signature images.

---

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-11-10-ux-redesign-test` |
| Commit SHA to deploy (full 40 characters) | **NOT SET: the owner states it in writing at Phase C (C0).** **Proposed release commit `7f9483d39690ae94db2710465d6995cd0b82b271`** (adds the dependency overrides and the TEST-only switches to the code verified on a clean clone at `d7f7147`); CI run 431 on it: success. Not authorized by the owner yet |
| Branch / pull request | `claude/ogevia-ux-audit-redesign-w36cov`; draft PR #108 to `main` (never merged) |
| Prepared by (name, date) | Claude Code (AI assistant) for the owner, 2026-11-10. Not a human sign-off. |
| Change classification (tick all) | ☒ feature ☐ bug fix ☒ migration ☒ API ☒ dashboard ☒ report ☒ scheduling ☐ authorization ☒ visits/verification ☒ availability/matching ☒ user admin ☐ notifications ☒ infrastructure (route switches, Lambda bundle) ☐ web only |
| Feature Test Plan | **NOT WRITTEN.** The requirements and acceptance criteria are in `docs/ux/REQUIREMENTS-TRACKER.md` (R1 to R31); a Feature Test Plan with catalog IDs is still to be made from it |
| Catalog areas required (from process section 6.3) | NOT YET MAPPED (follows the Feature Test Plan). Touched: navigation, dashboard, schedule and shifts, caregiver visit screens, Care Team, Staff, Clients, documents readiness, import, tenant isolation |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations in this release (number and name; **include every earlier migration not yet live**, per the contiguity rule) | Pending, applied to TEST outside the ledger: `0103_caregiver_signin_override`, `0104_caregiver_client_labels`, `0105_bulk_import`, `0106_staff_duplicates`, `0107_standard_document_types`. Earlier migrations not yet live: **UNKNOWN until the Phase C pre-flight reads the ledger** (the last recorded TEST ledger is 88/0088 as of 2026-11-01) |
| Rollback script for each migration (path, class) | `infra/aws/db/pending/rollback/`: 0090 BACKUP REQUIRED, 0091 SAFE, 0092 BACKUP REQUIRED, 0093 BACKUP REQUIRED, 0094 SAFE. Each rollback is exercised in its database test |
| API routes added / changed / removed | Added, each behind a release switch: `POST /v1/caregivers/{caregiverRecordId}/signin-override`, `GET /v1/signin-overrides` (`signInOverride`); `POST /v1/imports/{kind}` (`bulkImport`); `GET /v1/staff/duplicates`, `POST /v1/staff/{profileId}/merge` (`staffDuplicates`). Changed: none. Removed: none. `exceljs` added to sv-api (larger Lambda bundle) |
| Screens added / changed | See tracker rows R1 to R27: navigation, help panel, dashboard, schedule (drawer, exceptions), caregiver tabs and Verify Visit, Care Team, Staff (import, duplicates), Clients (import), readiness setup, Accounts and Reporting wording, phone touch targets |
| Infrastructure changes (`cdk diff` summary: expected resources only) | **`cdk diff` NOT RUN** (no AWS access from this session). Expected only: 5 new API routes on `Ogevia-prod-*` once `TEST-switches-on.patch` is applied, plus the Lambda code. Anything else: stop |
| What deliberately does NOT change | Production (`Ogevia-prd-*`, `ogevia_prd`); released ledger 0001 to 0088; billing, authorization, schedule and visit rules; hosting; no migration moved into `db/migrations` |
| Data changed or created by the release (expected: none unless stated) | 0094 adds up to two document types (CPR, TB; names only) per agency with an owner, with audit events. Nothing else; imports and merges create data only when a person confirms them |

---

## A. Development gates (Phase A)
Run on a clean checkout of the commit above. Paste the summary line of each. `OGEVIA_TEST_DATABASE_URL=<local database> pnpm test:all` runs A4, A6 and A7 together and fails on any skipped test; if you use it, paste its final `PASS` line and the counts in A4, A6 and A7.

| # | Gate | Command | Result | Evidence |
|---|---|---|---|---|
| A1 | Install | `pnpm install --frozen-lockfile` | ☒ ok | fresh clone of `d7f7147`, exit 0 |
| A2 | **Lint (G1)** | `pnpm lint` | ☒ exit 0 | clean clone of `d7f7147` |
| A3 | **Typecheck (G2)** | `pnpm typecheck` | ☒ exit 0 | clean clone of `d7f7147` |
| A4 | **Unit and static tests (G3a)** | `pnpm test` | ☒ exit 0. Counts: web 1,309 (141 files), infra 684 (36), sv-api 110 (6), auth 150 (9), shared 118 (14), ui 73 (20) | `pnpm test:all` step 1, clean clone of `d7f7147` |
| A5 | Build | `pnpm build` | ☒ exit 0 | clean clone of `d7f7147` |
| A6 | **Database tests (G3b)** | `OGEVIA_TEST_DATABASE_URL=... pnpm --filter @carelik/infra-aws test:db` | ☒ all passed, **0 skipped**. Counts: 1,157 (107 files) | `pnpm test:all` final line "PASS all suites ran, none skipped, all passed", clean clone of `d7f7147`, local PostgreSQL 16 |
| A7 | **API tests (G3c)** | `OGEVIA_TEST_DATABASE_URL=... pnpm --filter @carelik/sv-api test:db` | ☒ all passed, **0 skipped**. Counts: 173 (26 files), including the cross-tenant sweep with all pending migrations applied | same run |
| A8 | CI run on the pull request | link | ☒ green for every commit from `16d9f21` to the head: runs 421 to 428 (head `c77bc78` = run 428). Earlier failures 416, 419, 420 were fixed (tenant sweep, lint warning) | GitHub Actions, branch above |
| A9 | Test counts did not drop versus the baseline (process section 3.1) | | ☐ **no, explained:** the web suite went from 1,303 to 1,308 net; 18 old tests that asserted the removed header chip, the "Needs attention now" tile and the tab strip were rewritten to the new design, not skipped. No numeric baseline file was compared | |

Change-specific:
- N/A (feature work; the one bug found, a flaky assertion in `workflow.db.test.ts`, was fixed with a field-specific check): the reproducing test **failed before** the fix (failure text recorded) and **passes after**: ____________
- ☒ Every changed rule has a test (0090 to 0094 each have database, API and web tests); "fails without the change" was **not demonstrated for each**: ____________ partial
- ☒ Covered: invalid and malformed files, duplicate rows, re-upload of the same file, partial-failure rollback, 1,000-row and 2,001-row files, wrong role, other tenant, unauthenticated, network refusal messages. **Not covered:** concurrent imports of different files racing on the same names (serialized by an advisory lock, not stress-tested)
- ☒ Migration: new files only; applied files unedited; `.down.sql` present and classified; rollback tests run. `01_schema_version.sql` and ledger-tail tests: **N/A by design** (pending files are outside the ledger until a later integration)
- ☐ Migration touches `SECURITY DEFINER`, grants or tenant access: **Applied by Claude, human sign-off still needed:** `SECURITY_AND_COMPATIBILITY_REVIEW.md` (all new functions checked; SEC-1 zip-bomb crash FIXED, SEC-2 FIXED, SEC-3 exceljs dependency advisories need the owner's decision)
- ☒ API: permission, other-tenant, unauthenticated, bad-input and (if it creates records) idempotency tests exist; `slice-contract.test.ts` passes
- ☒ UI: states tested on every changed screen; 390 px: 0 of 20 office screens overflow and 0 controls under 44 px (emulated, `touch-targets.mjs`); 1280 px not re-measured in this pass; contrast tests pass inside the web suite
- ☐ Not audited line by line: new Import, Duplicates and CPR/TB setup contain short inline sentences by design

**Phase A signed:** name ____________ date ____________   (NOT SIGNED: needs a human; open items above are A1, A8, the security review and the Feature Test Plan)

## B. Local harness (Phase B), gate G4
| # | Step | Result | Evidence |
|---|---|---|---|
| B1 | `harness:setup` run on this commit (fresh database, all migrations applied; migration count: ___) | ☒ | Ledger 0001 to 0088 applied by `harness:setup`; then 0090 to 0093 applied by hand with psql. **0094 not applied to the harness** (its database test covers it); count 88 + 4 outside the ledger |
| B2 | `harness:build` and `harness:serve` run on this commit | ☒ | built after the touch-target change; served at https://localhost (commit `16d9f21` plus the CSS change, since committed) |
| B3 | Seed data covers the change (if not, `setup.ts` was extended in this change) | ☒ | `harness:seed-today -- --startable` (visit today), two synthetic duplicate staff, client cities. `setup.ts` not extended; the duplicates and cities were inserted by a one-off SQL block |
| B4 | Every catalog ID in the Feature Test Plan performed as the named persona (list IDs and PASS/FAIL below) | ☐ **PARTIAL.** `FEATURE_TEST_PLAN.md` written (UXR-01 to UXR-23). Automated cases pass; harness screenshots done for UXR-01, 02, 09, 13; UXR-01c, 14c, 22, 03b need the owner. Done instead: recording of 70 owner and 18 caregiver screens, the touch-target walk of 20 screens as Olivia Owner, the offline preview check | |
| B5 | Screenshots saved under `docs/releases/<release-id>/evidence/` (desktop 1280 for administrator, 390 for caregiver) | ☒ saved for the administrator at 1360 and 390 px (10 files); **caregiver-screen captures not saved** (shown in the preview only). Earlier galleries: `docs/ux/pr2/`, `docs/ux/pr3/`; the final Staff and Dashboard 390 px captures were viewed but not committed | |
| B6 | Bug fix or rule change: **before and after** screenshots of the same record | ☐ partial | before/after for navigation and help in `docs/ux/pr2/`, `pr3/`; none for R19, R23, R11, R6, R7 |
| B7 | Browser console and network: no unexpected errors or 4xx/5xx | ☐ partial | the offline preview: 0 page errors, 0 network requests. Live harness console/network not inspected |
| B8 | Negative checks: forbidden action refused for the wrong role; Caregiver sees no Administrator data | ☒ | automated: tenant isolation sweep (9/9, all pending migrations applied), per-route 401/403/404 tests for override, import, duplicates; unassigned caregiver gets no client name (0091 test) |
| B9 | Regression set R spot-checked | ☐ **PARTIAL:** `pilot-regression-local.sh`: 35 passed, 0 failed, 1 not run (SMK-06 needs the deployed API address; exit code 3, the gate needs 0). Report `evidence/regress-local.md` | |
| B10 | List what the harness **cannot** prove and that this change touches (Cognito, authorizer, IAM, S3/KMS, CloudFront, RDS TLS, email): ____________ | ☒ carried to C6 | Touches: Lambda bundle size and cold start (`exceljs`), the real JWT authorizer on 5 new routes, API Gateway payload limit for a 2 MB import (base64 about 2.8 MB), shared RDS instance behaviour. Does not touch S3/KMS, CloudFront config, email, IAM |

Catalog results (copy rows as needed):
| Catalog ID | Persona | PASS / FAIL | Notes |
|---|---|---|---|

**Phase B signed:** name ____________ date ____________   (NOT SIGNED: B4, B5, B6, B7 and B9 are open)

## C. Pilot/test environment (Phase C), gate G5

> **NOT STARTED. Every line below stays blank on purpose.** It needs the owner's written statement (SHA, TEST only, who runs it, window) and the read-only checks U1 to U4. Nothing in Phase C, D, E or F has been done or claimed.
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
| E8 | **Drift check against the last record** (section 8.1): no unexplained change to code, configuration or infrastructure; explained changes listed: ________ | ☐ | |

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
| F8 | **Deployed record** written from pasted evidence and committed (`DEPLOYED_RECORD_PRD.md`). Status: ☐ DEPLOYED - RECORD COMPLETE ☐ DEPLOYED - RECORD INCOMPLETE (nothing redeployed automatically) | ☐ | |
| F9 | Next release's baseline pointer updated (this record is the baseline) | ☐ | |
| F7 | Rollback invoked? ☐ no ☐ yes (details, time, result): | | |
