# Release checklist: 2026-10-30-caregiver-readiness

**Status (updated 2026-10-30, after the owner's decisions of the same day): TEST/PILOT package only. Operator: Stella Okereke. Target environment: DESIGNATED 2026-10-30 (existing TEST/pilot; see C and `DECISION_RECORD.md` A1; unsigned; identifiers not verified live). Phase A: G1 and G2 pass; G3 RESOLVED and validated (date-dependent tests made calendar-independent: see `TEST_REMEDIATION_DATE_DEPENDENT.md`). Phase B: B9 RUN, FAIL (pre-existing defect D1; no human tester). Phases C, D, E NOT RUN. Not deployed anywhere. 0086 is NOT RELEASABLE (open: B9, Phases C, D, E, security review, live verification of the target). GO / NO-GO not given.**
Status words: implemented and tested on a disposable local database only. "Demo" environment: UNKNOWN.
Template: `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. Evidence below is real command output from this session (2026-10-30), local PostgreSQL 16, synthetic data.

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-10-30-caregiver-readiness` |
| Commit SHA to deploy | **`44dbd2ec8a8b6c87562d30245e80e66a6441dfdb`** (recorded 2026-10-30 at the owner's request, `DECISION_RECORD.md` A2; the pushed head of `claude/practical-tesla-r07odb` at that time). The deployable code last changed in `dd59c8b`; **no deployable file changed between `dd59c8b` and this SHA** (checked with git). Later commits are documentation/tests only; before Phase C the Operator re-runs `git diff --stat 44dbd2ec8a8b6c87562d30245e80e66a6441dfdb HEAD -- apps/sv-api/src apps/web/src infra/aws/lib infra/aws/bin infra/aws/db/migrations infra/aws/db/rollback infra/aws/db/verification pnpm-lock.yaml` and expects no output. **A GO covers this SHA only; it has not been given.** |
| Branch / pull request | `claude/practical-tesla-r07odb` / no pull request opened |
| Prepared by | Claude Code (cloud session), 2026-10-30, for the owner |
| Change classification | ☑ feature ☑ migration ☑ API ☑ scheduling ☑ user admin ☑ infrastructure (8 routes, same stacks) ☐ others |
| Feature Test Plan | `FEATURE_TEST_PLAN.md` |
| Catalog areas | RDY (added), CMP, USR, SMK, R rows |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations in this release | `0086_caregiver_readiness_approve_for_work`. Earlier migrations not yet live on the target: **UNKNOWN** until `RUNBOOK.md` section B is run. 0001 to 0085 are unedited (set sha `de0c8abb…08ef`, equal to the 2026-10-19 package's). |
| Rollback | `infra/aws/db/rollback/0086_caregiver_readiness_approve_for_work.down.sql`, class **BACKUP REQUIRED** |
| API routes added | 8 (see Feature Test Plan 1). None changed or removed. |
| Screens | Caregiver page rebuilt; Caregivers list; Staff list; Recruiting board link. Removed: Compliance card, Onboarding card, status picker, Documents status labels, duplicate Name/Status sections. |
| Infrastructure (`cdk diff` summary) | **Verified by synthesizing both versions locally** (not a diff against the live stack): `Ogevia-prd-ServiceVerificationApi` and `Ogevia-prod-ServiceVerificationApi` each +8 `AWS::ApiGatewayV2::Route`, 1 `AWS::Lambda::Function` code asset changed; all other stacks identical. The operator's real `cdk diff` is still required (C4a). |
| What does NOT change | See Feature Test Plan 1. |
| Data changed by the release | One `legacy_status` approval per Ready/Active caregiver; onboarding requirements of category background_check/document/clearance set inactive. Nothing deleted. |

## A. Development gates (Phase A) — run on this working tree
| # | Gate | Command | Result | Evidence |
|---|---|---|---|---|
| A1 | Install | `pnpm install --frozen-lockfile` | ☑ ok | completed in the session |
| A2 | Lint (G1) | `pnpm lint` | ☑ exit 0 | `Tasks: 6 successful, 6 total` |
| A3 | Typecheck (G2) | `pnpm typecheck` | ☑ exit 0 | `Tasks: 7 successful, 7 total` |
| A4 | Unit and static tests (G3a) | `pnpm test` (run per package) | ☑ pass | web 1215/1215; sv-api 96/96; **infra/aws 458/458 in 23 files**. The 10 failing release-pin tests of the earlier run belonged to the superseded 2026-10-19 and 2026-10-21 packages and were **retired on the owner's instruction** (moved to `infra/aws/retired-tests/`, not deleted, not re-pinned; see its README). |
| A5 | Build | `pnpm build` | ☑ exit 0 | `Tasks: 6 successful, 6 total` (turbo output warnings only) |
| A6 | Database tests (G3b) | `OGEVIA_TEST_DATABASE_URL=… pnpm --filter @carelik/infra-aws test:db` | ☑ **pass (resolved 2026-10-30, validated)** | Real date, full suite after the remediation: **99 of 99 files, 1,084 of 1,084 tests pass**. The earlier 41 failures were: 37 obsolete/harness tests of superseded packages (retired) and 4 date-dependent tests. Those 4 (plus 2 more of the same family found by the sweep) are now calendar-independent: exact root cause, code changes and the before/after results over 18 dates are in `TEST_REMEDIATION_DATE_DEPENDENT.md`. **Fixed tests: 34/34 on all 18 frozen dates (month ends, year end, both DST days, 2026-11-02 and later); the original files fail on 10 of those 18 dates.** No production code, migration or API changed. |
| A7 | API tests (G3c) | `… pnpm --filter @carelik/sv-api test:db` | ☑ all passed | 152/152 in 22 files; skipped not counted by this session |
| A8 | CI on the pull request | | ☐ N/A: no pull request opened | |
| A9 | Counts did not drop (3.1) | | ☑ with explanation | Infra unit suite: 552 before; 458 now after the owner-approved retirement of 4 package test files (94 tests of the superseded packages; none of the 458 fails). Web: removed the Compliance card tests (9 of `compliance.test.tsx`) and the Onboarding-card test (1) because those components were deleted by the brief; added readiness, approve, extend, sign-in link, accounts and mobile tests. DB: 3 retired package files (62+32+14 tests); +22 new, existing tests changed only where the 2026-10-30 rules reverse earlier ones (list below). |

Existing tests changed (rule changes, not weakened controls): `compliance-hold` and `apps/sv-api/test/compliance.db` (14 becomes the agency setting, set to 14 in those suites; "inside the period" now allowed again), `cpr-tb-verified-required` (documents past the due date; new inside-period test), `onboarding` and `scheduling-onboarding.db` (one onboarding item left; approval through Approve for work), `caregiver-gate-no-service`, `caregiver-service-admin`, `invitations-planned`, `workflow.db` (status picker refuses Approved/Active; resend rate limit), plus count/list updates in `schema`, `verification`, `rollback-range`, `readiness-*`, `upgrade-*`, `merged-gate`; verification SQL `01` and `08` updated to 0086.

Change-specific:
- ☑ Every changed rule has a test that fails without it, and a control: RDY-01 to RDY-17 in the plan.
- ☑ Failure-first cases covered (plan section 3).
- ☑ Migration: new file only; applied files unedited (0001 to 0085 set hash unchanged); `.down.sql` present and classified; rollback tests run; `01_schema_version.sql` and ledger-tail tests updated.
- ☑ Security review (SECURITY DEFINER, grants, tenant access) — see "Security notes" below; `docs/security-review-checklist.md` not separately filled by Claude: ☐ owner/reviewer to confirm.
- ☑ API: permission, other-tenant, unauthenticated, bad-input, idempotency tests exist; `slice-contract` passes (route list updated in the CDK stack).
- ☑ UI: loading, empty, error, success states; 390 px (and 320 px) and 1280 px checked in a real browser; no horizontal scroll; contrast tests pass.
- ☑ No instructional paragraph where a label works (one short note under the checklist about the due-date rule).

**Phase A signed:** NOT SIGNED (A4 and A6 are not clean).

Security notes (for the reviewer): all new functions are `SECURITY DEFINER` with `set search_path = ogevia, pg_temp` and `revoke all … from public`, granted to `ogevia_app` only; each checks `is_active_member`, then the permission (`caregivers.manage`, `caregivers.compliance.manage`, or the compliance read guard); cross-agency calls return 404. `caregiver_contacts` (email, phone) has row-level security enabled and **no** grant to `ogevia_app` or `ogevia_readonly`; it is reachable only through two functions; the audit rows record that a contact was set, never the value; no list returns it. Approvals and extensions are append-only (trigger). No client names, identifiers or health data enter any new table or message.

## B. Local harness (Phase B), gate G4
| # | Step | Result | Evidence |
|---|---|---|---|
| B1 | `harness:setup` on this commit (fresh database, migrations applied: 86) | ☑ | "migrations applied: 86" |
| B2 | `harness:build` and `harness:serve` | ☑ | served at https://localhost, HTTP 200 |
| B3 | Seed covers the change | ☑ | `setup.ts` extended (legacy approvals, Reese, Quinn, Dana) |
| B4 | Catalog IDs performed as named personas | ☑ by script, ☐ by a person | `readiness-scenario.mjs` as Olivia (administrator), Morgan (manager), Alex (caregiver): **22 of 22 checks pass at 1280 px and 22 of 22 at 390 px**, on the real production bundle, real API handler and real PostgreSQL. Covers RDY-04, 05, 07, 09, 12, 14 (access), 15, 16. |
| B5 | Screenshots | ☑ | `evidence/desktop-*.png` (8), `evidence/phone-*.png` (8) |
| B6 | Before/after of the same record | ☑ | `desktop-03-reese-before-approve.png` and `desktop-04-reese-approved.png` |
| B7 | Browser console and network: no unexpected errors or 4xx/5xx | ☑ | `readiness-scenario.mjs` now records console errors, page errors and every 4xx/5xx for the administrator and manager sessions (desktop): none, apart from the deliberate resend refusal (409). Phone session not recorded. |
| B8 | Negative checks | ☑ partly | manager has no Extend (checked); caregiver refused (checked); resend refused inside a minute (checked); other-tenant and wrong-role refusals are covered by the DB/API tests, not the browser |
| B9 | Regression set R spot-checked | ☒ **RUN 2026-10-30: FAIL (1 pre-existing defect, D1)** | Worksheet `B9_REGRESSION_WORKSHEET.md` executed by Claude Code with an automated browser (**not a human tester**) on the local harness at `996a182` (no deployable file differs from the recorded Phase C SHA): 30 steps, **28 PASS, 2 FAIL**, 0 script errors, 0 skipped. The 2 FAILs are the same defect: the **Authorization changes** page crashes (`TypeError: w.createdAt.slice is not a function`) because `withClientNames` turns every `Date` into `{}`; reproduced on the commit **before** 0086, so it is **not a 0086 regression**, but it is a real product defect that the deployed API shares (the Lambda does not parse timestamptz either). Seven other call sites use the same helper and were not audited. Everything else in the set passed, including the new readiness flows, the legacy people staying Active, caregiver-visible data (client codes only), scheduling, recurring preview, visit start/end/confirm on a phone, and role refusals. Screenshots and `b9-results.json` in `evidence/b9/`. **Owner decision needed** (fix, or accept as a Major with a written exception); B9 must then be repeated, and a human spot-check is still advised. |
| B10 | What the harness cannot prove | ☑ listed | Cognito invitation and expiry, email content, authorizer/IAM, CloudFront, RDS TLS, real data volumes: carried to `RUNBOOK.md` F |

Database check after the browser run: one `caregiver_work_approvals` row and one `caregiver.approved_for_work` audit row for the caregiver the script double-clicked; the contact audit row holds `{"email_set": true, "phone_set": false}` only.

**Phase B signed:** NOT SIGNED (B9 FAIL: defect D1 open; no human tester).

## C. Pilot/test environment (Phase C), gate G5 — NOT RUN
**C0 Target environment (designated 2026-10-30 by the owner in conversation; recorded in `DECISION_RECORD.md` amendment A1, unsigned):** the existing **TEST/pilot** slice: stacks `Ogevia-prod-*` (CDK `-c env=prod`), database **`ogevia_sv_test`** on RDS `ogevia-prod-postgres` (account 300094796789, `us-west-2`), banner "TEST — synthetic data only". **Not** `Ogevia-prd-*` and **never** `ogevia_prd`, which lives on the same RDS instance. Identifiers come from repository documents and are **NOT VERIFIED LIVE** (Claude has no AWS access): the Operator confirms them read-only first (`RUNBOOK.md` section B). Last recorded state: commit `e80b770`, ledger 85 / 0085 (2026-10-19); the current live ledger is UNKNOWN until the probe is run.

Operator: **Stella Okereke**. **Commit SHA recorded: `44dbd2ec8a8b6c87562d30245e80e66a6441dfdb` (A2). Window: NOT SET; to be recorded after B9 is PASS and the Operator confirms her availability. GO to run Phase C: NOT given.** Until the window and the GO are stated in writing, nothing is run against the TEST slice; Claude runs nothing against any shared environment in any case. The real `cdk diff` (C4a) is the Operator's first Phase C step once the owner states the SHA and window. Steps C0 to C10 are in `RUNBOOK.md`; nothing was run.

## D. User acceptance (Phase D) — NOT RUN
No validator has run any script. Owner, Scheduler, Caregiver (phone) and the Authorization validator rows are blank. Scripts to use: RDY-01 to RDY-16 in the plan.

## E. Production approval (Phase E), gate G6 — NOT PREPARED FOR PRODUCTION
| # | Item | Done | Link |
|---|---|---|---|
| E1 | Change summary | ☑ draft | `README.md` |
| E2 | Risk assessment | ☑ draft | below |
| E3 | Rollback plan | ☑ draft | `RUNBOOK.md` G |
| E4 | Backup confirmation | ☐ | needs the real snapshot id |
| E5 | Evidence index | ☑ partial | this file, `evidence/` |
| E6 | All six gates | ☐ G1 ☑, G2 ☑, G3 ☑ (validated), G4 ☐ (B9 FAIL: defect D1), G5 ☐, G6 ☐ | |
| E7 | Window and Operator | ☐ | |

Risk assessment (draft). (1) The migration backfills approvals and retires three onboarding requirement categories: if the target holds caregivers whose stored status is Ready/Active, they remain schedulable, but the **page will show them as Approved/Active with missing items** until Task 8 is reviewed: nothing is blocked, because enforcement is unchanged. Likelihood low, effect on access none, detected by the section F count. (2) Reversal of the 0081 rule widens what can be scheduled before enforcement is on, by owner decision. (3) A new table holds email addresses and phone numbers (restricted, encrypted at rest with the rest of RDS). (4) The rollback drops four tables: BACKUP REQUIRED. (5) The release-pin tests of the superseded packages are retired, not re-pinned: a new release-pin baseline is created only after the target and release candidate are final.

### Decision record
Owner decisions recorded 2026-10-30 (given in the conversation with Claude Code). **Filed as `DECISION_RECORD.md`, prepared for signature but NOT YET SIGNED**: ☐ owner signs; ☐ Operator acknowledges.
| # | Decision | Effect in this package |
|---|---|---|
| D1 | Treat 0086 as a **TEST/PILOT package only** until a deployment target is formally designated. **Operator: Stella Okereke.** Do not schedule, script or execute deployment against any shared environment until the target is explicitly identified and documented. | `RUNBOOK.md` header; C section above. Target: **NOT DESIGNATED** |
| D2 | **Retire** the release-pin tests tied exclusively to the superseded 2026-10-19 and 2026-10-21 packages. **Do not re-pin.** Create a new release-pin baseline only after the target is identified and the release candidate is finalized. | 7 files moved to `infra/aws/retired-tests/` (not deleted) |
| D3 | Categorize the 41 database failures as pre-existing environment issue, obsolete test, harness/container issue or product defect. | `TEST_FAILURE_CATEGORIZATION.md` |
| D4 | Run the real `cdk diff` once the target is identified. | **Blocked: no target** |
| D5 | Complete Phase B (console, network, regression) and all gates and activities of Phases C, D, E. | B7 done; **B9 open**; C, D, E **not run** |
| D6 | Keep the failed gate marked failed until resolved. | G3 was marked OPEN/FAILED until validated; **now resolved** (A6, `TEST_REMEDIATION_DATE_DEPENDENT.md`) |
| D7 | Do **not** mark 0086 releasable, deployment-ready or production-approved until: the failed gate is resolved, outstanding validations are complete, the deployment target is documented, and the release record is updated. | See the status table below |

**Release status table (the only status that counts):**
| Condition for "releasable" (D7) | State |
|---|---|
| Failed gate resolved (G3) | ☑ **RESOLVED 2026-10-30 and validated** (real date: 99/99 files, 1,084/1,084 tests; fixed tests 34/34 on 18 frozen dates incl. after 2026-11-02) |
| Outstanding validations complete (B9 regression spot-check, Phase C, Phase D, security review) | ☐ **NOT COMPLETE**: B9 was run and FAILED on pre-existing defect D1 (owner decision pending); Phases C, D and the security review not done |
| Deployment target documented | ☑ **DESIGNATED 2026-10-30** (existing TEST/pilot; identifiers from repo docs, **not verified live**; unsigned) |
| Release record updated after the above | ☐ not applicable until the three rows above are done |
| **0086 releasable / deployment-ready / production-approved** | **NO** |

GO / NO-GO decision (G6): ☐ GO ☐ NO-GO — **not given**. Owner / date / SHA / reference / window / conditions: blank.

## Open items (nothing below is done unless ticked)
1. ☑ **Target designated** (existing TEST/pilot, C0). ☐ Owner signs `DECISION_RECORD.md` A1. ☐ Operator confirms the identifiers read-only (runbook B). ☑ Commit SHA recorded (A2). ☐ Owner states the window (after B9 PASS) and gives a GO for Phase C in writing.
2. ☐ **Real `cdk diff`** in the TEST slice, by the Operator, after the owner states the window and gives the GO (C4a). Expected: only the 8 routes and one Lambda code asset per API stack (`RUNBOOK.md` D).
3. ☑ **G3 clean:** the date-dependent tests are calendar-independent and validated (see above).
4. ☒ **B9 run: FAIL.** ☐ Owner decides on defect D1 (Authorization changes page crashes; root cause in `withClientNames`; pre-existing, reproduced before 0086): **(a)** fix it (a deployable-code change: new commit, new SHA, gates and B9 re-run, Phase C SHA re-recorded) or **(b)** accept it as a Major with a written exception. ☐ B9 repeated afterwards; ☐ a human spot-check.
5. ☐ **Phase C, D, E** in full (pilot validation, user acceptance by Owner, Scheduler, Caregiver and the authorization validator, owner GO).
6. ☐ Confirm the decisions listed in `README.md` ("Decisions taken without asking"). ☐ **Owner signs `DECISION_RECORD.md`** (filed, unsigned).
7. ☐ Security review checklist (`docs/security-review-checklist.md`) confirmed by a reviewer.
8. ☑ Release-pin tests of the 2026-10-19 and 2026-10-21 packages retired (moved, not deleted, not re-pinned).
9. ☑ The 41 database failures categorized: 37 obsolete (retired), 4 date-dependent, 0 defects.

**0086 is NOT RELEASABLE, deployment-ready or production-approved.** Remaining blockers: items 1, 2 (signing, live verification, the owner's window and GO, and the real `cdk diff`), 4 (B9 failed on pre-existing defect D1: owner decision, then repeat), 5 (Phases C, D, E) and 7 (security review confirmation).
