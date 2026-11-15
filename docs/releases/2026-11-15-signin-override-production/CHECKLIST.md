# Release checklist: 2026-11-15-signin-override-production

Template: `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. Status words: proposed, implemented, tested, deployed, accepted. **This release is IMPLEMENTED and TESTED (Phase A). It is NOT deployed and NOT accepted.** Boxes that are not ticked are open on purpose; nothing is ticked that was not run.

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-11-15-signin-override-production` |
| Commit SHA to deploy | **Not yet fixed.** Set by the owner's GO: the head of this pull request at the time of the GO (40 characters). |
| Branch / pull request | `claude/keen-hawking-e9o2jg` → base `claude/ogevia-ux-audit-redesign-w36cov`, [socalcaresservices/CarelikGlobal#109](https://github.com/socalcaresservices/CarelikGlobal/pull/109) (draft). The base is the branch production runs; `main` does not contain this code. |
| Prepared by | Claude Code for the owner, 2026-11-15 |
| Change classification | ☑ API ☑ infrastructure ☑ user admin (permission-gated action) ☐ migration (none) ☐ web only (no web change) |
| Feature Test Plan | Test coverage is listed in `README.md` section 4 and below; no separate `FEATURE_TEST_PLAN.md` was written. Owner to say whether one is required. |
| Catalog areas | Authorization/roles, caregiver readiness, tenant isolation (see rows below) |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations | **None.** 0103 is already in the production ledger (owner-reported 2026-11-11; verify with `VERIFY_PRODUCTION_DB.sql`). Contiguity rule: nothing earlier is pending for this feature. |
| Rollback script per migration | n/a. The existing `pending/rollback/0103_caregiver_signin_override.down.sql` is BACKUP REQUIRED and is not part of this release |
| API routes added | `GET /v1/signin-overrides`, `POST /v1/caregivers/{caregiverRecordId}/signin-override` (JWT). None changed or removed |
| Screens | None (production bundle already contains the action) |
| Infrastructure | Exactly two `AWS::ApiGatewayV2::Route` resources, enforced by `production-signin-override-release.py` against the captured live template |
| Deliberately NOT changing | Lambda code and configuration, IAM, invoke permission, parameters, stage, database, website, bulk import, duplicate-staff review |
| Data created | None by the release. Override records appear only when an administrator approves someone |

## A. Development gates (Phase A), local PostgreSQL 16, this checkout
| # | Gate | Result | Evidence |
|---|---|---|---|
| A1 | `pnpm install --frozen-lockfile` | ☑ ok | |
| A2 | `pnpm lint` | ☑ exit 0 (6 tasks) | run 2026-11-15 on the working tree that became this commit |
| A3 | `pnpm typecheck` | ☑ exit 0 (7 tasks) | same |
| A4 | Unit and static tests (`turbo test --force`, stage 1 of `pnpm test:all`) | ☑ exit 0, 0 skipped. shared 14 files / 118 tests, auth 9 / 150, sv-api 6 / 107, ui 20 / 73, web 142 / 1,314, infra-aws 43 / 775 | final `test:all` log, 2026-11-15, on commit `ab00dc61` |
| A5 | `pnpm build` | ☑ exit 0 (6 tasks) | same |
| A6 | Database tests (`@carelik/infra-aws test:db`) | ☑ **112 files / 1,184 tests passed, 0 skipped**, local PostgreSQL 16. Includes `signin-override-0090.db.test.ts` 13/13 and the new `signin-override-production-verify.db.test.ts` 10/10 (verdict passes on a production-shaped database and fails for each of eight defects) | final `test:all` log |
| A7 | API tests (`@carelik/sv-api test:db`) | ☑ **29 files / 183 tests passed, 0 skipped**. Includes `signin-override.db.test.ts` 8/8 | `test:all` log |
| A8 | CI on the pull request | ☐ head `ab00dc61`: `harness` and `validate` passed; `postgres` was still running when this was written. Re-read for the SHA the GO covers | [Actions run 43676249640](https://github.com/socalcaresservices/CarelikGlobal/actions/runs/43676249640) |
| A9 | Counts did not drop versus the baseline | ☑ **No test was removed.** Baseline = the working tree before my test additions: infra-aws unit run 718 tests (716 passed, 2 failed because they encoded the old "off in production" rule: rewritten, not deleted). Now 775 = 718 + 57 new (26 release-gate, 29 deploy-script, 1 older-gate, 1 switch). Database +11 (1 no-verification-before-sign-in, 10 verification-verdict; 1,173 to 1,184). API +1 (HTTP 422; 182 to 183). Web unchanged at 1,314 (the three tests added and then reverted with the web "hide" change net to zero). The 2026-11-10 record's counts came from a different (Windows) environment and are not comparable | `test:all` PASS line: "all suites ran, none skipped, all passed" |

Change-specific:
- ☑ Every changed rule has a test that fails without the change. Production switch: `signin-override-switch.test.ts` asserts the switch is on for production and that it adds exactly two JWT routes (the old assertions failed when the switch was turned on, as expected, and were rewritten). Release gate: 26 tests in `production-signin-override-release.test.ts`, including refusals of the TEST database, a live route already present, a public route, another authorizer, an extra route property, a third change in the change set, a modify, a replacement.
- ☑ Controls: bulk import and duplicate-staff review stay off in production (`staff-routes-switch.test.ts`, gate refusals); the older `production-ux-release.py` still refuses them.
- ☑ Failure-first cases for the approval flow, all existing and passing: invalid and blank reason, background check not clear (409, nothing recorded), required training outstanding, manager/scheduler/caregiver/unauthenticated refused, other agency 404, already signed in, idempotent and concurrent calls, append-only record, badge list visibility by role, rollback/re-apply, no reason or name in logs. **Added in this PR:** an overridden caregiver cannot verify a visit (database: `OGR30` for administrator and manager, visit count unchanged; HTTP: 422 `not_ready`, visit count unchanged).
- ☑ Migration/definer checks on a production-shaped database (0001–0102 then the real production upgrade SQL, 107 ledger rows): `VERIFY_PRODUCTION_DB.sql` prints `VERDICT: PASS`, and `VERDICT: FAIL` for each of eight injected defects (missing permission row, a manager holding it, app role cannot execute, PUBLIC can execute, table owned by another role, function owner cannot execute a helper, ledger short a row, append-only trigger disabled). Found and fixed one defect in the SQL itself (enum cast).
- ☑ Deploy script (`production-signin-override-deploy.sh`) tested end to end against a fake aws, curl, npx and corepack in a throw-away git checkout: 29 tests covering plan, apply (execute once, six accepted routes kept, bulk import and duplicate review stay off), refusals (no approval, wrong account, wrong or modified checkout, stale or failing verification, unsettled stack, wrong API or Handler, route already live, extra candidate route, extra change in the change set, stack changed after the plan, bad workspace path), automatic rollback on a failed smoke check or a live template that differs from the plan, no automatic rollback when CloudFormation fails the update, and the rollback mode. Not run against real AWS.
- ☐ UI states: not changed in this release. The action's loading/error behaviour is covered by the existing `signin-override-ui.test.tsx` (11 tests, passing).
- ☐ 390 px / 1280 px visual check: not run (no UI change; no browser harness here).
- ☑ No migration; applied migration bytes untouched (`0103` checksum verified by the SQL and by `production-ux-release.py`).
- ☑ Security checklist: no definer function, grant or tenant rule is added or changed by this release.

**Phase A signed:** ☐ owner/operator. A1–A7, A9, lint, typecheck (6 and 7 tasks, re-run on the final code) are done; sign after CI (A8) is green on the SHA the GO covers.

## B. Local harness (Phase B)
☐ **Not run.** The local harness (`harness:setup/build/serve`, browser personas) was not run in this session. Recommended minimum before GO if the owner requires Phase B: harness run with the override persona script (owner approves, manager does not see the action, background-check hard block). B10 (what the harness cannot prove): Cognito production pool and authorizer on the new routes, API Gateway route table, CloudFront/CORS behaviour for the two routes. These are covered by `RUNBOOK.md` section 6.

## C. Pilot/test environment (Phase C)
☐ **Not run for this change.** TEST (`Ogevia-prod-*`, `ogevia_sv_test`) already has these routes on and migration 0103 applied and was accepted on 2026-11-11 (`RELEASE_READINESS.md`); no new TEST deployment is needed because the code is unchanged. Owner decision needed: accept TEST's existing acceptance as Phase C for this production-only route enablement, or require a fresh TEST pass.

## D. User acceptance (Phase D)
☐ Not run. Production acceptance is built into `RUNBOOK.md` section 7 (owner's own account, one real approval).

## E. Production approval (Phase E)
| # | Item | Done | Link |
|---|---|---|---|
| E1 | Change summary | ☑ | `README.md` sections 1–2 |
| E2 | Risk assessment | ☑ | `README.md` section 7 |
| E3 | Rollback plan | ☑ | `README.md` section 6, `RUNBOOK.md` section 8 |
| E4 | Backup confirmation | ☐ **open**. No database change, so no snapshot is required for this release; the rollback input is the captured live template (uploaded to the private assets bucket by `RUNBOOK.md` step 4). Owner to confirm that a fresh manual RDS snapshot is not required, or ask for one | |
| E5 | Evidence index | ☑ | this folder |
| E6 | Gates G1–G5 | ☐ G1 ☑ G2 ☑ G3 pending A6–A9 ☐ G4 not run ☐ G5 not run | |
| E7 | Window and operator named | ☐ | |
| E8 | Drift check against the last record | ☐ **open, partly done:** two manual production database changes of 2026-11-14 are recorded in `PRODUCTION_DB_CHANGES_2026-11-14.md`; the second security-group window's closing is unconfirmed; production API/web state beyond the 2026-11-11 record is unverified | |

### Decision record
| Field | Value |
|---|---|
| Decision | ☐ GO ☐ NO-GO |
| Owner (name) | |
| Date and time | |
| Commit SHA the decision covers | |
| Approval reference | |
| Window | |
| Operator | |
| Conditions or exceptions | |

## F. After deployment
All open: F1–F9 are completed by the operator from pasted evidence (`RUNBOOK.md` sections 6, 7 and 9).
