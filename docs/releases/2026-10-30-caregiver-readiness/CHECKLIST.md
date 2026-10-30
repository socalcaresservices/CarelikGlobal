# Release checklist: 2026-10-30-caregiver-readiness

**Status: Phase A PARTIAL (one gate FAILED, see A4 and A6). Phase B PARTIAL. Phases C, D and E NOT RUN. Not deployed anywhere. Owner decision: GO / NO-GO NOT GIVEN.**
Status words: implemented and tested on a disposable local database only. "Demo" environment: UNKNOWN.
Template: `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. Evidence below is real command output from this session (2026-10-30), local PostgreSQL 16, synthetic data.

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-10-30-caregiver-readiness` |
| Commit SHA to deploy | **Not set.** Code is `dd59c8b3d56e190ef1f47316c19b4fa287f57d77`; documentation-only commits follow. The owner's GO must name the final SHA. |
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
| A4 | Unit and static tests (G3a) | `pnpm test` (run per package) | ☒ **FAILED, 10 tests** | web 1215/1215 pass; sv-api 96/96 pass; **infra/aws 542 pass, 10 fail of 552**. The 10 are `operator-tarball.test.ts` (5), `rehearsal-operator-scripts.test.ts` (1), `auth-cutover-gate.test.ts` (3), `web-headers-gate.test.ts` (1). Cause: they pin the 2026-10-19/21 release packages to the repository at 85 migrations and to the pre-0086 route set and "before" templates; any new migration or route fails them. They pass on the unmodified code. **Not weakened or edited.** Owner decision needed (see Open items). |
| A5 | Build | `pnpm build` | ☑ exit 0 | `Tasks: 6 successful, 6 total` (turbo output warnings only) |
| A6 | Database tests (G3b) | `OGEVIA_TEST_DATABASE_URL=… pnpm --filter @carelik/infra-aws test:db` | ☒ **not clean** | 1151 pass, 41 fail of 1192 (96 of 102 files). The 41 failures are in `auth-cutover-scripts` (16), `prd-release-exec` (13), `prd-rehearsal` (8), `authorization-tiers` (1), `authorization-single-bucket` (1), `dst-local-times` (2): **the same 6 files and 41 tests fail on the unmodified code in this environment** (checked by running them with 0086 removed). Cause not investigated; looks environmental (operator-script suites, a DST and two authorization date tests). |
| A7 | API tests (G3c) | `… pnpm --filter @carelik/sv-api test:db` | ☑ all passed | 152/152 in 22 files; skipped not counted by this session |
| A8 | CI on the pull request | | ☐ N/A: no pull request opened | |
| A9 | Counts did not drop (3.1) | | ☑ with explanation | Infra unit total unchanged (552). Web: removed the Compliance card tests (9 of `compliance.test.tsx`) and the Onboarding-card test (1) because those components were deleted by the brief; added readiness, approve, extend, sign-in link, accounts and mobile tests. DB: +22 new, existing tests changed only where the 2026-10-30 rules reverse earlier ones (list below). |

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
| B7 | Browser console and network: no unexpected errors or 4xx/5xx | ☐ **NOT DONE** | not recorded by the scenario |
| B8 | Negative checks | ☑ partly | manager has no Extend (checked); caregiver refused (checked); resend refused inside a minute (checked); other-tenant and wrong-role refusals are covered by the DB/API tests, not the browser |
| B9 | Regression set R spot-checked | ☐ **NOT DONE** | |
| B10 | What the harness cannot prove | ☑ listed | Cognito invitation and expiry, email content, authorizer/IAM, CloudFront, RDS TLS, real data volumes: carried to `RUNBOOK.md` F |

Database check after the browser run: one `caregiver_work_approvals` row and one `caregiver.approved_for_work` audit row for the caregiver the script double-clicked; the contact audit row holds `{"email_set": true, "phone_set": false}` only.

**Phase B signed:** NOT SIGNED (B7, B9 open; no human tester).

## C. Pilot/test environment (Phase C), gate G5 — NOT RUN
Owner has stated in writing: **NO**. Target, commit SHA, who runs it and the window are all unset; the environment is UNKNOWN. Steps C0 to C10 are in `RUNBOOK.md` (sections B, C, E, F, G). Nothing was run.

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
| E6 | All six gates | ☐ G1 ☑, G2 ☑, G3 ☒, G4 ☐, G5 ☐, G6 ☐ | |
| E7 | Window and Operator | ☐ | |

Risk assessment (draft). (1) The migration backfills approvals and retires three onboarding requirement categories: if the target holds caregivers whose stored status is Ready/Active, they remain schedulable, but the **page will show them as Approved/Active with missing items** until Task 8 is reviewed: nothing is blocked, because enforcement is unchanged. Likelihood low, effect on access none, detected by the section F count. (2) Reversal of the 0081 rule widens what can be scheduled before enforcement is on, by owner decision. (3) A new table holds email addresses and phone numbers (restricted, encrypted at rest with the rest of RDS). (4) The rollback drops four tables: BACKUP REQUIRED. (5) Release-pin tests of earlier packages are red until rebased.

### Decision record
| Field | Value |
|---|---|
| Decision | ☐ GO ☐ NO-GO — **not given** |
| Owner / date / SHA / reference / window / Operator / conditions | blank |

## Open items for the owner
1. **Name the target** (demo is UNKNOWN) and say whether it is pilot/test, and who is the Operator. Nothing can be scheduled before that.
2. **The 10 red release-pin tests (A4):** recommended: retire the 2026-10-19 and 2026-10-21 package tests when that cutover is complete (their package is superseded), or authorise re-pinning them to a new package built for the named target. I did not touch them.
3. **The 41 environmental DB failures (A6):** pre-existing in this container; need a look by someone with the CloudShell/operator context if they should pass elsewhere.
4. B7 and B9 and all of Phase D need a person.
5. Confirm the decisions in `README.md` ("Decisions taken without asking").
