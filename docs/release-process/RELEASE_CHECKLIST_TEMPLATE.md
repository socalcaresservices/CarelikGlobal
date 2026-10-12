# Release checklist: <release-id>

Copy this file to `docs/releases/<release-id>/CHECKLIST.md` and complete it. **Every box must be ticked or marked N/A with a reason.** A blank line is a failed line. Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. Status words: proposed, implemented, tested, deployed, accepted (never interchangeable).

Evidence rules: link or paste real command output and screenshots. Never include passwords, tokens, secret values, real client or caregiver data, or signature images.

---

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `YYYY-MM-DD-short-name` |
| Commit SHA to deploy (full 40 characters) | |
| Branch / pull request | |
| Prepared by (name, date) | |
| Change classification (tick all) | ☐ feature ☐ bug fix ☐ migration ☐ API ☐ dashboard ☐ report ☐ scheduling ☐ authorization ☐ visits/verification ☐ availability/matching ☐ user admin ☐ notifications ☐ infrastructure ☐ web only |
| Feature Test Plan | link to `FEATURE_TEST_PLAN.md` |
| Catalog areas required (from process section 6.3) | |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations in this release (number and name; **include every earlier migration not yet live**, per the contiguity rule) | |
| Rollback script for each migration (path, class) | |
| API routes added / changed / removed | |
| Screens added / changed | |
| Infrastructure changes (`cdk diff` summary: expected resources only) | |
| What deliberately does NOT change | |
| Data changed or created by the release (expected: none unless stated) | |

---

## A. Development gates (Phase A)
Run on a clean checkout of the commit above. Paste the summary line of each.

| # | Gate | Command | Result | Evidence |
|---|---|---|---|---|
| A1 | Install | `pnpm install --frozen-lockfile` | ☐ ok | |
| A2 | **Lint (G1)** | `pnpm lint` | ☐ exit 0 | |
| A3 | **Typecheck (G2)** | `pnpm typecheck` | ☐ exit 0 | |
| A4 | **Unit and static tests (G3a)** | `pnpm test` | ☐ exit 0. Counts: | |
| A5 | Build | `pnpm build` | ☐ exit 0 | |
| A6 | **Database tests (G3b)** | `OGEVIA_TEST_DATABASE_URL=... pnpm --filter @carelik/infra-aws test:db` | ☐ all passed, **0 skipped**. Counts: | |
| A7 | **API tests (G3c)** | `OGEVIA_TEST_DATABASE_URL=... pnpm --filter @carelik/sv-api test:db` | ☐ all passed, **0 skipped**. Counts: | |
| A8 | CI run on the pull request | link | ☐ green (informational; does not replace A1 to A7) | |
| A9 | Test counts did not drop versus the baseline (process section 3.1) | | ☐ yes ☐ no, explained: | |

Change-specific:
- ☐ Bug fix: the reproducing test **failed before** the fix (failure text recorded) and **passes after**: ____________
- ☐ Every changed rule has a test that fails without the change, and a control test: ____________
- ☐ Failure-first cases covered (invalid input, stale data, concurrency, retry, wrong role, other tenant, network failure, old data): ____________
- ☐ Migration: new file only; applied files unedited; `.down.sql` present and classified; rollback test run; `01_schema_version.sql` and ledger-tail tests updated
- ☐ Migration touches `SECURITY DEFINER`, grants or tenant access: `docs/security-review-checklist.md` completed
- ☐ API: permission, other-tenant, unauthenticated, bad-input and (if it creates records) idempotency tests exist; `slice-contract.test.ts` passes
- ☐ UI: loading, empty, error, success states; 390 px and 1280 px checked; no horizontal page scroll; contrast tests pass
- ☐ No instructional paragraph where a label or tooltip works

**Phase A signed:** name ____________ date ____________

## B. Local harness (Phase B), gate G4
| # | Step | Result | Evidence |
|---|---|---|---|
| B1 | `harness:setup` run on this commit (fresh database, all migrations applied; migration count: ___) | ☐ | |
| B2 | `harness:build` and `harness:serve` run on this commit | ☐ | |
| B3 | Seed data covers the change (if not, `setup.ts` was extended in this change) | ☐ | |
| B4 | Every catalog ID in the Feature Test Plan performed as the named persona (list IDs and PASS/FAIL below) | ☐ | |
| B5 | Screenshots saved under `docs/releases/<release-id>/evidence/` (desktop 1280 for administrator, 390 for caregiver) | ☐ | |
| B6 | Bug fix or rule change: **before and after** screenshots of the same record | ☐ / N/A | |
| B7 | Browser console and network: no unexpected errors or 4xx/5xx | ☐ | |
| B8 | Negative checks: forbidden action refused for the wrong role; Caregiver sees no Administrator data | ☐ | |
| B9 | Regression set R spot-checked | ☐ | |
| B10 | List what the harness **cannot** prove and that this change touches (Cognito, authorizer, IAM, S3/KMS, CloudFront, RDS TLS, email): ____________ | ☐ carried to C6 | |

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
| C7 | Regression set R: all PASS | ☐ | |
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
