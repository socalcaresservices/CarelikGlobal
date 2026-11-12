# Ogevia testing and release process

**Status:** ADOPTED by the owner on 2026-10-13. It applies to every change from that date. Nothing in this document deploys anything or authorizes a deployment.
**Related:** `CLAUDE.md` (sections 0 and 13), `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`, `docs/release-process/FEATURE_TEST_PLAN_TEMPLATE.md`, `docs/release-process/ACCEPTANCE_TEST_CATALOG.md`, `infra/aws/local-harness/README.md`.

## 1. The rule

**No change reaches production until it has passed, in this order: Phase A (development), Phase B (local harness), Phase C (pilot/test environment), Phase D (user acceptance), Phase E (production approval).** A later phase never starts before the earlier one is complete and recorded. Only the owner can give the final GO.

This applies to every feature, bug fix, migration, API change, dashboard change, report change, scheduling change and authorization change, however small. The only exemption is a change that touches documentation only (no file under `apps/`, `packages/`, `infra/`, `supabase/`, `netlify.toml` or `.github/`).

### 1.1 The six hard gates (all required, none waivable)
No migration, feature or bug fix may be deployed to production without all six:

| # | Gate | Command or evidence |
|---|---|---|
| G1 | Lint | `pnpm lint` exits 0 |
| G2 | Typecheck | `pnpm typecheck` exits 0 |
| G3 | Tests | `pnpm test` exits 0, **plus** the database and API suites in section 3.1, which `pnpm test` does not run |
| G4 | Local harness verification | Phase B complete: affected workflows verified by hand, screenshots recorded |
| G5 | Pilot environment validation | Phase C complete on the pilot/test environment |
| G6 | Owner GO | Phase D sign-offs and Phase E decision recorded |

A gate that was not run is a failed gate. "It should work" is not evidence (`CLAUDE.md` section 0: report the tests actually run).

### 1.2 Status vocabulary
Use these words exactly and never let one stand in for another: **proposed**, **implemented**, **tested** (say where: development, harness, pilot), **deployed** (say where), **accepted** (by whom). "Implemented" never means deployed.

## 2. Roles

| Role | Does | Cannot |
|---|---|---|
| Owner | Approves the plan, performs or names UAT people, gives GO / NO-GO, supplies the approval reference | |
| Operator | Has admin AWS credentials; runs deployments, snapshots and live checks in CloudShell | Skip a step the checklist requires |
| Claude Code (cloud session) | Writes code, tests, migrations, harness data, documents; runs Phase A and Phase B; prepares Phase C commands and the Phase E package | Run anything against AWS (no AWS access), give GO, deploy, modify production |
| UAT testers | Owner (Administrator), Scheduler, Caregiver, Authorization validator (Phase D) | |

## 3. Phase A: development

Entry: a written change description and a completed **Feature Test Plan** (`FEATURE_TEST_PLAN_TEMPLATE.md`). Exit: every item below green, evidence attached to the release checklist.

### 3.1 Required runs
Run from a clean checkout of the exact commit that will move forward. Record the commit SHA.

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm lint                  # G1
pnpm typecheck             # G2
pnpm test                  # G3, part 1: unit and static tests (all workspaces)
pnpm build                 # the web app and packages must build

# G3, part 2: database and API tests. NOT included in `pnpm test`.
# Needs a LOCAL PostgreSQL 16+ superuser (see local-harness/README.md for Docker).
export OGEVIA_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres
pnpm --filter @carelik/infra-aws test:db     # database logic, migrations, rollbacks, tenant/role isolation
pnpm --filter @carelik/sv-api test:db        # the API handler against a real database

# One command that runs all of the above test steps (unit/static with `turbo --force`, then both database suites),
# refuses to start without a LOCAL database URL, and FAILS if any test is skipped or no test ran:
OGEVIA_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres pnpm test:all
```
`pnpm test:all` replaces the three test lines for G3. Lint, typecheck and build are still run separately. Its summary parser has a self-test: `node scripts/test-all.mjs --self-test`.

Baseline measured 2026-10-13 on this branch (for comparison; a change must not lower these without an explicit, explained reason):

| Suite | Result |
|---|---|
| `pnpm test` | shared 118, auth 138, sv-api 67, ui 73, infra-aws 124, web 762 (all pass) |
| `infra/aws test:db` | 54 files, 521 tests (all pass) |
| `sv-api test:db` | 3 files, 69 tests (all pass) |

**Rules**
1. **Zero skipped.** A database suite run without `OGEVIA_TEST_DATABASE_URL` reports its tests as *skipped*, not failed. Skipped tests count as **not run = gate failed**. Read the summary line.
2. **CI is an additional check, not a substitute.** `.github/workflows/ci.yml` (jobs `validate` and `postgres`) runs on Node 22 with a frozen lockfile: `validate` runs typecheck, lint, build, `pnpm test` and the deployment-bundle build; `postgres` runs `pnpm test:all` on PostgreSQL 18 (unit, database and API suites, failing on any skip). Run section 3.1 yourself before opening the pull request; a green CI run does not replace it. Whether CI jobs are *required* before merge: Unable to verify from repository evidence (the job ids were left unchanged so existing branch-protection rules keep matching).
3. **Bug fixes start with a failing test.** Write the test that reproduces the defect, show it failing on the unchanged code (record the failure text), then fix it, then show it passing. Where the defect cannot be fixed yet, commit the reproduction as `it.fails` with a comment naming the defect; remove `.fails` in the fix. (Example: `infra/aws/db/test/authorization-accounting-risks.db.test.ts`.)
4. **Every changed rule needs a test that would fail without the change**, and a test for the nearest case that must NOT change (a control).
5. **Failure-first cases are mandatory** wherever they apply: invalid input, stale data, concurrent requests, duplicate/retried request, wrong role, other tenant, network failure at submit, old data still readable. Use the catalog IDs your plan lists.

### 3.2 Test types and where they live
| Type | Where | Covers |
|---|---|---|
| Unit | `packages/*/src/*.test.ts`, `apps/web/src/**/*.test.ts(x)`, `apps/sv-api/test/unit.test.ts` | Pure logic, formatting, permissions, UI components |
| Database | `infra/aws/db/test/*.db.test.ts` | Functions, constraints, concurrency, tenant and role isolation, migrations from zero, rollbacks |
| Migration static | `infra/aws/db/test/migrations.static.test.ts` | Contiguous numbering, search_path, no Supabase dependency, every migration has a classified rollback |
| API | `apps/sv-api/test/*.db.test.ts` | Routes, permissions, error shapes, idempotency, over the real handler |
| UI | `apps/web/src/**/*.test.tsx` | Screens, states (loading, empty, error), accessibility basics, contrast |
| CDK | `infra/aws/test/*.test.ts` | Synthesized infrastructure assertions |

### 3.3 Migration rules (any change under `infra/aws/db/migrations`)
1. A **new** numbered file only. An applied migration is never edited (the runner stops on a checksum change, "Drift").
2. A matching `rollback/NNNN_*.down.sql` with a header line `-- ROLLBACK NNNN | CLASS: ...` stating what it does and what it cannot undo.
3. Prefer additive and function-only changes. Anything destructive (drop, rewrite of stored rows) needs a separate written owner approval before it is written, a backup plan and a test on a populated database (see `upgrade-0046-to-0048.db.test.ts`).
4. Update every place that names the latest version: `db/verification/01_schema_version.sql` and the ledger-tail expectations in tests (`readiness-restore`, `upgrade-*`). Search for the previous number.
5. **Contiguity.** The runner applies every missing migration in order. Deploying migration N therefore also deploys every earlier migration that is not live yet. The release checklist lists them all, and each one needs its own approval and its own Phase C/D validation.
6. Prove the rollback: run the down script against a migrated database and run the suite again (see `rollback.db.test.ts`, `readiness-rollback.db.test.ts`).
7. Security-sensitive changes (new SECURITY DEFINER function, grants, tenant access) also need `docs/security-review-checklist.md` completed.

### 3.4 API changes
Add or change the route in `apps/sv-api/src/routes.ts` **and** the API stack route list (`infra/aws/lib/service-verification-api-stack.ts`); both are tested. Every route needs: permission test, other-tenant test, unauthenticated test (401), bad-input test, and idempotency test if it creates records.

### 3.5 UI changes
Test loading, empty, error and success states. Check at 390 px wide (caregiver screens) and 1280 px (administrator screens): no horizontal page scroll, visible primary action, tap targets, contrast. No instructional paragraph where a label or tooltip works (owner directive of 2026-10-11).

## 4. Phase B: local harness

Entry: Phase A complete for the same commit. Exit: every affected workflow verified in a browser, screenshots saved, checklist section B signed by whoever ran it.

### 4.1 Procedure
```bash
# one-time: a local PostgreSQL (Docker command in infra/aws/local-harness/README.md)
export HARNESS_ADMIN_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres
pnpm --filter @carelik/infra-aws harness:setup    # fresh database, all migrations, seeded demo data
pnpm --filter @carelik/infra-aws harness:build    # builds the web app for this commit
pnpm --filter @carelik/infra-aws harness:serve    # https://localhost  (port 443; see README)
```
1. **Start from a fresh setup** so the migration chain from zero is exercised. If the change needs data the seed lacks, extend `infra/aws/local-harness/setup.ts` in the same change and say so.
2. For every catalog ID in the Feature Test Plan, sign in as each persona the plan names and perform the **How** steps. Compare with the **Expected** column. Record PASS / FAIL.
3. **Screenshots.** Desktop 1280 wide for administrator screens, 390 wide for caregiver screens. Save as `docs/releases/<release-id>/evidence/<catalog-id>-<what>-<before|after>.png`. Bug fixes and rule changes need a **before and after** pair of the same record. To get "before", set up a second database at the previous state (for a migration, run its `.down.sql` on a copy).
4. Check the browser console and network panel: no errors, no 4xx/5xx other than ones the scenario expects. The Playwright pattern in `infra/aws/local-harness` history (a script that signs in and fails on page errors) may be reused.
5. **Negative checks** in the harness: another persona's forbidden action is refused with the right message; a Caregiver cannot see Administrator data.
6. Re-run the unaffected-workflow set (section 6.2, "Regression set") quickly.

### 4.2 What the harness cannot prove
Real Cognito (MFA, token validation), the API Gateway authorizer, IAM, S3 and KMS (signature objects are in memory), CloudFront, RDS TLS, real email, and performance on real data. **Anything in that list that the change touches must be proven in Phase C.** The checklist makes you state which.

## 5. Phase C: pilot/test environment

Entry: Phase B complete. Exit: smoke, regression and changed-workflow validation recorded as PASS on the pilot/test environment.

### 5.1 Target and safety
- The target is the **pilot/test** environment only: stacks `Ogevia-prod-*`, database `ogevia_sv_test`, synthetic data, banner **"TEST — synthetic data only"** visible in the app. Addresses are in `docs/aws/URL_REGISTRY_AND_LAUNCH_CHECKLIST.md`; re-verify them at the start of every release because they are records, not live checks.
- **Never** `Ogevia-prd-*`, database `ogevia_prd`, production users or real clients. If the banner is missing, stop.
- The deployment is **YELLOW** (`CLAUDE.md` section 13). The owner states in writing: the commit SHA, the target, who runs it, the window.
- Claude Code cannot run this phase. It prepares the exact commands and a pre-flight list; the Operator runs them in CloudShell with admin credentials.

### 5.2 Steps
1. **Pre-flight (read-only).** Record: the commit SHA; the pilot's migration ledger (`select count(*), max(version) from ogevia_meta.schema_migrations`), compared with the checklist's expected "before" value; stack status; the previous web bundle and API template (the rollback inputs). Existing helpers: `infra/aws/slice/live-status-check.sh`, `owner-access-check.sh`, `phase7_evidence.py`.
2. **Backup.** A manual RDS snapshot with a recorded identifier (the rollback anchor).
3. **Deploy in order:** database, API, web. Use the release's reviewed script, built from the latest release script pattern (`infra/aws/slice/increment-*`, `release-0026-*`, `release-0036-*`, `pilot-*`; for the production candidate `infra/aws/scripts/deploy-production.sh`). A new release gets its own script or an explicit command list, reviewed in Phase A. Read any `cdk diff`: anything outside the stated scope (another stack, a security group, a secret, a deletion, a replacement) is a STOP.
4. **Smoke.** Run the standard smoke suites for the environment (`infra/aws/slice/smoke.py`, `pilot_smoke.py`, and the release's `release_*_live.py` checks) and the catalog's **Smoke set S** (section 6.1). All PASS.
5. **Regression.** Run the catalog's **Regression set R** (section 6.2). The API-level cases are automated by the pilot regression runner (`infra/aws/slice/pilot_regression.py`, instructions in `docs/release-process/PILOT_REGRESSION_RUNNER.md`; a release gate needs its exit code 0); the remaining cases are performed by hand with the people and data of the pilot. All PASS.
6. **Changed workflows.** Every ID in the Feature Test Plan, on the pilot, including the checks the harness cannot prove (4.2).
7. **No unrelated breakage.** Beyond set R, sign in as each role and open every menu item the role has; no error screens; no errors in the API logs for the period (read-only log search for 5xx and `errorCode`).
8. **Negative checks on the pilot:** unauthenticated request gets 401; a forged token gets 401; the other tenant sees nothing; a Caregiver cannot reach Administrator data.
9. **Rollback readiness.** For a migration that changes calculations or stored behaviour, the down script has been rehearsed (in tests: always; on the pilot: when the owner approves, after the snapshot). The previous web bundle and API template are confirmed available.
10. Record everything in the checklist, section C, with times, names and evidence links. Any FAIL: stop, fix forward in a new commit, and **restart from Phase A** for that commit.

## 6. Acceptance-test sets (details in the catalog)
### 6.1 Smoke set S (every release, every environment, minutes)
`SMK-01` sign in as each role; `SMK-02` Home loads with numbers; `SMK-03` Schedule opens; `SMK-04` a Caregiver sees only assigned clients; `SMK-05` start and end a visit; `SMK-06` unauthenticated API call returns 401; `SMK-07` environment banner shows TEST.
### 6.2 Regression set R (every release)
The catalog cases marked **R**. They cover scheduling, recurrence, authorization balance, visit confirm and correction, tenant and role isolation. A change in an area adds that area's full list.
### 6.3 Which catalog areas a change must run
| Change type | Minimum catalog areas |
|---|---|
| Scheduling or recurrence | SCH, REC, AUT, DSH, plus R |
| Authorization or accounting | AUT, SCH, REC, DSH, RPT, VIS, plus R |
| Visit, signature, service verification | VIS, EVV, AUT, RPT, plus R |
| Dashboard or report | DSH, RPT, and every area whose numbers it shows, plus R |
| Availability or matching | AVL, MAT, SCH, plus R |
| User administration or permissions | USR, plus R and the isolation cases |
| Notifications | NTF, plus R |
| Migration of any kind | The areas whose functions it replaces, `rollback` cases, plus R |
| API route | The area of the route, the isolation cases, plus R |

## 7. Phase D: user acceptance testing
Entry: Phase C complete. Exit: all four sign-offs recorded; no open blocker.

UAT runs on the **pilot/test environment** with synthetic data, using scripts written from the catalog IDs in the Feature Test Plan. Each tester gets a one-page script: the steps, the expected result, a place to record PASS / FAIL / note.

| Validator | Who | Validates |
|---|---|---|
| Owner | The agency owner (Administrator) | Home and dashboard figures, reports, settings, billing review; that wording and numbers make sense |
| Scheduler | A person who schedules | Creating, repeating, changing, cancelling shifts; coverage and call-outs; warnings and refusals read clearly |
| Caregiver | A caregiver (phone-sized screen) | Start, end and confirm a visit; My shifts; availability; no screen is confusing |
| Authorization | The person who owns authorizations (Administrator or delegate) | Balances are right: **recalculate by hand** three authorizations (one low use, one near limit, one amended) from the underlying visits and shifts; used, reserved and remaining must match to the minute |

Defect classes: **Blocker** (wrong money, hours, access or data; or a workflow cannot be completed): NO-GO until fixed and re-tested from Phase A. **Major** (workflow works but is wrong or confusing for a role): fix before GO unless the owner records a written exception for that item. **Minor** (cosmetic): logged; the owner decides.
Testers who find a defect do not fix it; they record the steps and the screen.

## 8. Phase E: production approval
Entry: Phases A to D complete. Claude Code assembles the package; the **owner** decides. Nothing here is automatic.

The package (all in `docs/releases/<release-id>/`):
1. **Change summary**: what changes for each role, in plain words; migrations (all of them, per the contiguity rule); routes; screens; what does not change.
2. **Risk assessment**: for each risk: what could go wrong, how likely, the effect (money, hours, access, data), how it is detected, how it is reversed. Include data-affecting and calculation-affecting changes in separate rows.
3. **Rollback plan**: the exact order (web, then API, then database), the commands, what each step cannot undo, who runs it, how long it takes, and the point at which the rollback is called.
4. **Backup confirmation**: the snapshot identifier, its time and status "available", the RDS backup retention, S3 signature-bucket versioning confirmed, and the restore procedure (a restore goes to a **new** instance and is a separate approval).
5. **Evidence index**: links to the completed checklist, test outputs, screenshots, UAT sign-offs.
6. **Decision record**: `GO` or `NO-GO`, the owner's name, date and time, the commit SHA, the approval reference, the window, who runs it. A GO is valid for that SHA and window only; a new commit or a missed window needs a new decision.

After a GO the Operator deploys the same SHA with the same script that ran on the pilot. Afterwards: run the read-only production smoke (`deploy-production.sh smoke`), the owner checks the changed workflows with the owner's own account, and the checklist's monitoring period is observed. Anything unexpected: stop and apply the rollback plan.

### 8.1 Production release records and drift checks (added 2026-10-27 on the Owner's instruction)
**Why.** The production deployments of 2026-10-21 to 2026-10-23 left no deployed record, so the running code could not be mapped to a commit afterwards (see `docs/aws/PRODUCTION_AS_FOUND_2026-10-26.md`). A site that worked does not prove which code was deployed.

1. **Three status words, never interchangeable.** **DEPLOYED - RECORD COMPLETE** (every artifact maps to the approved commit and the record is committed to the repository); **DEPLOYED - RECORD INCOMPLETE** (the release took effect but a record check failed or the record is not yet committed); **NOT DEPLOYED OR NOT PROVABLE**. "Implemented", "tested", "deployed" and "accepted" keep their meanings above.
2. **A production release is not closed until `DEPLOYED_RECORD_PRD.md` is committed** to its `docs/releases/<release-id>/` folder, written from pasted evidence only. The checklist rows F8 and F9 carry this.
3. **If the deployment succeeds but recording fails, report "deployed - record incomplete".** Nothing is redeployed automatically: once the record state exists, the package's deploy, apply and publish steps refuse to run. Recording is read-only and is simply repeated after the cause is understood. A deliberate second deployment needs the Owner's new written instruction.
4. **Drift check before every release.** Compare the live deployment-controlled resources with the last committed record (or, for the first release after this rule, the as-found baseline): CloudFormation stack templates and statuses, Lambda code hashes and environment, the web bundle version and CloudFront configuration, API routes, authorizer and CORS, Cognito app-client settings, IAM roles and policies, security-group rules, and the database ledger and schema fingerprint. **Stop for any unexplained change to code, configuration or infrastructure.** Expected data activity (client, caregiver, visit, shift or user records; log volume; snapshots taken by schedule) is out of scope and is never a reason to stop.
5. **Baseline.** The latest committed record is the next release's baseline. The first baseline is the as-found document; its commit mappings that are unknown stay NOT VERIFIED until a later release proves them.
6. **Version stamp.** The API will report its commit, build time and approval reference so that the running system can answer "what are you". It is planned for the release after the 2026-10-26 staff-management release and is not part of that candidate.
7. **Ongoing drift monitoring** runs automatically, not from memory: see `docs/aws/DRIFT_MONITORING_PROPOSAL.md` (proposed; nothing is deployed).

## 9. Failure handling and exceptions
- Any failed gate or step stops the release. Fix forward with a new commit, then restart at Phase A. Do not patch the pilot by hand.
- **No bypass of G1 to G5.** If production is down, the emergency action is the rollback to the previous release (its plan is already approved). A forward hotfix still passes all six gates; only the owner may reduce Phase D to the roles the fix affects, in writing, for that fix only.
- A waiver of a Major defect is allowed only as a written owner exception inside the decision record. Blockers cannot be waived.
- Never edit production data by hand, never delete snapshots, databases, tables or users as part of a release (`CLAUDE.md` section 13, RED).

- **Hotfix base while migrations 0047 to 0052 are unreleased (added 2026-10-14).** Main now contains migrations 0047 to 0052 and Wave 1 code that no environment has received. Until the owner records those migrations as released, any hotfix must branch from the last DEPLOYED commit, not from `main`, and must be re-checked against that commit's schema.
  - AWS releases: the last deploy commit designated by the owner is `1639cf6` (`docs/releases/2026-10-13-0047-0048-0049/DEPLOYMENT_PLAN.md`). Whether it has actually been deployed is recorded in that release's CHECKLIST, not here.
  - Netlify production (Supabase build): the last deployed commit is NOT VERIFIED. No Netlify record was available to Claude Code on 2026-10-14. The owner must read it from the Netlify deploy list and write it into `docs/releases/2026-10-13-wave1/POST_MERGE_VERIFICATION.md`. Until then, branch hotfixes from the commit shown there, never from `main`.
  - A hotfix branch still passes all six gates. Do not merge a hotfix branch into `main` without reconciling it with 0047 to 0052.

## 10. Records
Each release gets `docs/releases/<release-id>/` containing `CHECKLIST.md` (the completed template), `evidence/` (screenshots and command output without secrets or personal data), and `DECISION.md`. Commit it. Evidence never contains passwords, tokens, secret values, real client or caregiver data, or signature images.

## 11. Known gaps in the current tooling (stated, not hidden)
| Gap | Effect | Proposed fix (needs owner approval) |
|---|---|---|
| `pnpm test` runs no database or API-integration tests | A green `pnpm test` says nothing about database rules | **Done 2026-10-13:** `pnpm test:all` runs everything and fails on skips; G3 requires it (or the three commands it wraps) |
| Database tests skip silently without `OGEVIA_TEST_DATABASE_URL` | A skipped suite can look like a pass | **Done for `test:all`** (refuses to start without the variable and fails on any skip). The individual `test:db` commands still skip silently when run on their own; CI sets the variable |
| CI used Node 20 and `--frozen-lockfile=false` | CI did not match local | **Done 2026-10-13:** CI uses Node 22, a frozen lockfile and `pnpm test:all` (CI not yet observed running: first run happens on the next pull request) |
| Other Node versions in play: Netlify's production build uses Node 20 (`netlify.toml`), the Lambda runtime is Node 24 (`service-verification-api-stack.ts`) | Code is tested on 22 but built on 20 (Netlify) and run on 24 (Lambda) | Netlify is production configuration (YELLOW): owner decision; Lambda runtime changes are a deployment |
| `.github/pull_request_template.md` referred only to `supabase/migrations` | The AWS migration path had no PR prompt | **Done 2026-10-13:** the template follows this process; the legacy Supabase section is kept at the end |
| Whether CI checks are required before merge | Unable to verify from repository evidence | Owner confirms branch protection |
| Phase C deploy scripts are per release (`pilot-*`, `increment-*`, `release-*`), and `pilot-e2e` browser scripts target older migrations (README: 0001-0018) | Deployment is still per-release scripted | **Regression part done 2026-10-13:** `pilot_regression.py` runs the automatable catalog cases (implemented and tested locally; not yet run on the pilot). Deployment scripts remain per release |
| The harness was not run in CI | Harness breakage was found late | **Done 2026-10-13:** CI job `harness` runs setup, build and `harness:smoke` (41 checks; not rendering screens). CI not yet observed running |
| No EVV/Sandata, GPS or SMS in the AWS build | Catalog sections for these are "not built" placeholders | Add cases when built |
| The pilot's current migration ledger and deployed commit are not recorded in the repository | Phase C pre-flight must read them live | Record them in each checklist. **Production: addressed 2026-10-27 by section 8.1 and `docs/aws/PRODUCTION_AS_FOUND_2026-10-26.md`** |
| Seeded signature images do not exist in the harness | Signature viewing cannot be checked locally | Prove in Phase C against real S3 |

## 12. How Claude Code works under this process
- Start every change by writing or updating the Feature Test Plan; finish by completing sections A and B of the checklist with real output, and say clearly that C, D and E are not done.
- Report in the `CLAUDE.md` section 16 format. Use PROPOSED / IMPLEMENTED / TESTED / DEPLOYED precisely.
- Never claim a phase is complete without its evidence. Never deploy, never modify production, never state that something works in AWS without Phase C evidence.
- If a change cannot satisfy a gate, say which and stop.
