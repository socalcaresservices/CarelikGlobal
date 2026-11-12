# Release checklist: 2026-11-01-prd-0088 (production release of migrations 0086, 0087, 0088)

**Status (2026-11-01 15:11 UTC): DRAFT. PRODUCTION RELEASE NOT APPROVED, NOT DEPLOYED.** Template: `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. ☑ = done with the evidence named; ☐ = open. Evidence rules: no passwords, tokens, secret values, real client or caregiver data. Nothing here is a claim of production health.

## 0. Release identity
| Field | Value |
|---|---|
| Release ID | `2026-11-01-prd-0088` |
| Commit SHA to deploy | **not yet named by the owner.** Pilot commit: `464dea64cb939c49fbca624b652f34b2863db2f2`; the branch tip differs from it only in four test files and documents (`PHASE_E_PACKAGE.md` section 6) |
| Branch | `claude/practical-tesla-r07odb` (no pull request opened) |
| Prepared by | Claude Code at the owner's instruction, 2026-11-01 15:11 UTC |
| Change classification | ☑ migration ☑ API ☑ user admin ☑ authorization-adjacent (caregiver approval) ☑ infrastructure (API stack only) ☐ scheduling rules ☐ visits ☐ billing |
| Feature Test Plan | `docs/releases/2026-10-30-caregiver-readiness/FEATURE_TEST_PLAN.md` |

## 1. Change contents
| Item | Value |
|---|---|
| Migrations | 0086 `staff_management`, 0087 `staff_invitation_acceptance`, 0088 `caregiver_readiness_approve_for_work` (production is at 85 / 0085) |
| Rollback scripts | `infra/aws/db/rollback/0086..0088*.down.sql`; set hash `4b53cb1908a5939bb3aac47ca0725b16d264690d2d83f78e4cca7cae4d035d05`; rehearsed locally: rolls back exactly 0088, 0087, 0086 to 85 / 0085 |
| API routes | 22 added (14 staff, 8 readiness), 228 to 250; none removed or changed |
| Screens | Staff, Staff Types, Roles and Permissions, caregiver readiness checklist and approval, caregiver list status, Accounts statuses |
| Infrastructure | `Ogevia-prd-ServiceVerificationApi` only (code asset, routes, tag); production web files |
| Does NOT change | authorization and hours arithmetic, billing, visits, signatures, scheduling rules (enforcement stays OFF), Cognito, network, secrets, TEST |
| Data changed or created | approvals backfilled for ready or active caregivers; existing onboarding requirements of three categories retired (not deleted); permission seed rows; seven default staff types per agency; ledger +3 |

## A. Development gates (Phase A), on the tree at the time of the run (`INTEGRATION_RECORD.md` section 25)
| # | Gate | Result |
|---|---|---|
| A1 | Install | ☑ `pnpm install --frozen-lockfile` |
| A2 | **Lint (G1)** | ☑ exit 0 (`--force`, nothing cached) |
| A3 | **Typecheck (G2)** | ☑ exit 0 (7 of 7) |
| A4 | **Unit and static (G3a)** | ☑ shared 118, auth 150, sv-api 100, ui 73, web 1266, infra-aws 635 |
| A5 | Build | ☑ exit 0 (6 of 6) |
| A6 | **Database tests (G3b)** | ☑ 1124 of 1124 (101 files), 0 skipped |
| A7 | **API tests (G3c)** | ☑ 158 of 158 (23 files), 0 skipped |
| A8 | CI run | ☐ no pull request; CI not run |
| A9 | Test counts did not drop | ☑ above the 2026-10-13 baseline in every suite |
- ☑ five failing tests were fixed test-only, shown failing first and verified on other calendar days (`INTEGRATION_RECORD.md` section 25).
- ☐ **G3 must be run again on the final release commit** if anything under `apps/`, `packages/` or `infra/` changes before the GO.
**Phase A signed:** ☐ (owner or Operator, date)

## B. Local harness (Phase B), gate G4
☑ for the same application code, on the pilot release: the automated B9 regression run was accepted by the Operator on 2026-10-31 (`docs/releases/2026-10-30-caregiver-readiness/CHECKLIST.md` section B; that record states there is no separate signed Phase B form). B10 (what the harness cannot prove) was carried to the pilot's C6. ☑ The production database change was rehearsed locally on a throwaway database at ledger 85 / 0085 with synthetic rows (`rehearse_local.sh`: PASSED).
**Phase B signed:** ☐

## C. Pilot/test environment (Phase C), gate G5
| # | Step | Result |
|---|---|---|
| C0 to C10 | Phase C on TEST, 2026-11-01 07:30 to 14:13 UTC, commit `464dea64...` | ☑ `DEPLOYED_RECORD_0088_TEST.md` sections 1 to 4; ledger 88 / 0088, 250 routes, web verified; every script defect found was fixed with the owner's approval and recorded (A23 to A26) |
Gaps accepted by the owner **for TEST only** (D38): live cross-agency isolation, authorization arithmetic on three clients, live role gating, the regression and smoke sets, Task 8, scheduler steps, CPR/TB extension history details. **Not accepted for production.** Open defects: none Blocker, none Major; two Minor wording items.

## D. User acceptance (Phase D)
☑ UAT run and closed on TEST with outstanding items (`DEPLOYED_RECORD_0088_TEST.md` section 4; `UAT_OUTSTANDING_CHECKLIST.md`): Owner and Caregiver steps passed, the other validators BLOCKED or NOT RUN by owner decision. ☐ No open Blocker: ☑. ☐ No open Major: ☑ (none found).

## E. Production approval (Phase E), gate G6 (`PHASE_E_PACKAGE.md`)
| # | Item | Done | Link |
|---|---|---|---|
| E1 | Change summary | ☑ drafted | `PHASE_E_PACKAGE.md` section 1 |
| E2 | Risk assessment | ☑ drafted (likelihoods are my assessment) | section 2 |
| E3 | Rollback plan | ☑ drafted | section 3 |
| E4 | Backup confirmation | ☐ the production snapshot does not exist yet; S3 bucket versioning not read back | section 4 |
| E5 | Evidence index | ☑ | section 5 |
| E6 | Six gates | G1 ☑ G2 ☑ G3 ☑ G4 ☑ (pilot record) G5 ☑ for TEST with accepted gaps; G6 ☐ | section 6 |
| E7 | Window and Operator | ☐ window not set | section 7 |
| E8 | Drift check | ☑ baseline 2026-11-01 (no drift since 2026-10-26); ☐ repeat on release night; ☐ new gate not yet read against production's live API template | section 8; `docs/aws/PRODUCTION_BASELINE_2026-11-01.md` |
### Decision record
UNSIGNED: `PHASE_E_PACKAGE.md` section 10.

## F. After deployment (production): all open
| # | Step | Result |
|---|---|---|
| F1 | Same SHA and same logic as the pilot (the production scripts derive from the pilot scripts; differences in `PRD_DEPLOYMENT_DESIGN.md` sections 4 and 11) | ☐ |
| F2 | Ledger after: `count=88 max=0088` expected | ☐ |
| F3 | Read-only production smoke (`STELLA_PRD_DEPLOY.sh smoke`) | ☐ |
| F4 | Owner checks the changed workflows with the owner's own account (`PRD_RUNBOOK.md` P7) | ☐ |
| F5 | Monitoring period observed (length: [owner]) | ☐ |
| F6 | Release marked deployed and accepted | ☐ |
| F7 | Rollback invoked? | ☐ |
| F8 | `DEPLOYED_RECORD_PRD.md` written from pasted evidence and committed | ☐ |
| F9 | Baseline pointer updated | ☐ |
