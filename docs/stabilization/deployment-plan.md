# Phase 10 — Deployment plan (PROPOSED; nothing here has been executed or approved)

Date: 2026-11-23 · Branch `stabilization/main-reconciliation` · STATUS: **COMPLETE (plan); every step marked OWNER GO is a human approval gate**
Governing documents: `CLAUDE.md` §0/§13, `docs/TESTING_AND_RELEASE_PROCESS.md`, `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. I have no AWS access; every AWS command is run by the owner in CloudShell, one block at a time, only after CI is green on the exact commit.

## What would be deployed (INFERRED from the diff against production c7691b63)
| Change | Needs deploying? |
|---|---|
| Sorting on 8 tables, branded-invitation code (OFF), docs | Web bundle only (new CloudFront asset) |
| Dependency upgrades (react-router-dom, zod 4, @aws-sdk, jose, qs override, TypeScript…) | Web bundle **and** the API Lambda bundle (sv-api AWS SDK changed) — a code-only change set |
| `config.ts` aligned to live production switches (4 switches) | **No deployment effect**: the CDK route table already equals what is live (config-drift computation: 18 release + 2 override route ids match, 0 mismatches). Verify with the read-only drift capture below before relying on it |
| Branded invitation (`auth.invitationEmail` absent) | None: the pool's synthesized shape is unchanged (test) |
| Migrations | **None.** Ledger stays at 111 rows (0001–0112 minus 0108). 0108 stays a proposal |
| Cover-shift notifications | Not in this release (needs owner decisions) |

## 0. Before anything (owner GO #1: whether to ship this at all)
1. PR `stabilization/main-reconciliation` → `main`, review, merge as a **merge commit** (not squash) — a human GitHub action; I will not push or merge `main`.
2. CI green on the exact merge commit; `validation-report.md` reflects that commit.
3. Complete `RELEASE_CHECKLIST_TEMPLATE.md` for the release; re-pin (`release_pins`) to the release commit.

## 1. Pre-deployment checks (read-only, owner runs; production not changed)
1. Capture live state with the existing tool: `infra/aws/scripts/production-template-drift.py` (plan: `docs/releases/2026-11-15-cdk-branch-alignment/PLAN.md`, Stage 0). Expected: route count 276 including the 6 `liveTestRepairs` routes only in TEST code, i.e. production = 270 routes; no logical-id drift.
2. Ledger: `select count(*), max(version) from <ledger>` = 111 rows, latest 0112, and 0108 absent. Run `docs/stabilization/compare-production-schema.sh` (owner-run schema comparison; created with the schema file — see database-audit.md) if the owner wants the 0108/ownership questions answered first.
3. RDS manual snapshot (name it with the release commit). Capture current web files (the existing web release script already does this and prints a rollback path).

## 2. Deployment order (each stage: owner GO, evidence recorded, stop on any failure)
| # | Stage | Where | How (existing tooling) |
|---|---|---|---|
| 1 | TEST: web + API from the release commit | TEST (`Ogevia-prod-*`, `ogevia_sv_test`) | TEST toolchain (`docs/releases/2026-11-20-test-plan/toolchain/`); then the Phase C/D checks in §4 |
| 2 | Owner acceptance on TEST | https://d2xumch5w0izfg.cloudfront.net | Sorting on the eight screens; sign-in; one visit flow; Offices pages |
| 3 | PRODUCTION: API code-only change set | `Ogevia-prd-*` | The reviewed change-set method used for the previous code releases (patch the live template; never `cdk deploy`); no route or IAM change |
| 4 | PRODUCTION: web publish | production site bucket + CloudFront | `infra/aws/scripts/production-web-release.sh` pattern (asserts the dedicated pool, uploads without delete, invalidates CloudFront, captures a rollback copy first) |
| 5 | Post-deployment verification | production | §4–§6 |
Routes-only change sets are **not** part of this release (no switch changes). Do not enable `bulkImport`, `staffDuplicates`, branded invitations or notifications here; each is a separate approval (`feature-readiness.md`).

## 3. Rollback
- Web: the capture taken in stage 4 and the script's printed recovery path (`web-before.tgz`); restore and invalidate CloudFront. Time to rollback: minutes.
- API code-only: re-run the change set with the previous Lambda bundle (the previous handler hash is `index.js sha256 4df8dee3…` from the production release record); or switch to the previous published Lambda version. No database change was made, so no data rollback exists or is needed.
- Dependency note: if the zod 4 or react-router upgrade shows a defect that only appears in a deployed bundle, roll back web alone (the API does not use zod; the API change is the AWS SDK/jose patch level).
- Database: nothing to roll back. A snapshot exists only as a safety net.

## 4. Smoke test checklist (owner or tester; production uses a test caregiver and non-PHI actions only)
- [ ] https://app.ogevia.com loads; sign-in with MFA works; sign-out works.
- [ ] Dashboard loads; **Hours by service** sorts by two columns and reverses; no error banner.
- [ ] Reports: Reconciliation, Correction history and Caregiver hours sort; Visits still sorts; export file order unchanged (standard order).
- [ ] Monthly chain report loads and sorts; Authorization impacts sorts; Readiness card sorts.
- [ ] Schedule: day lists sort; add/assign a shift still works; unfilled list sorts.
- [ ] Staff and Care Team pages load (Offices column and filters present); Documents loads.
- [ ] Caregiver phone (390 px): sign-in, Verify Visit start screen, no horizontal scroll.
- [ ] Browser console: no failed network calls other than the intentional 404s for switched-off routes (bulk import, duplicates).
- [ ] Switched-off features stay hidden: no Bulk import or Merge controls visible.

## 5. Database validation steps (read-only)
1. Ledger count and latest version unchanged (111 / 0112, 0108 absent).
2. `ogevia.import_batches` and `ogevia.staff_merge_links` exist and have 0 rows (features off; nothing written).
3. No new objects: schema comparison script output equals the pre-release capture.

## 6. Feature flag and route validation
- Read-only drift capture again after stage 3: route count and ids identical to the stage-1 capture; features live: staffManagement, signInOverride, requestCleanup, offices, officeAssignments, assignmentHistory = ON; bulkImport, staffDuplicates = OFF (routes `POST /v1/imports/{kind}`, `GET /v1/staff/duplicates`, `POST /v1/staff/{profileId}/merge` return 404).
- API Gateway 404 lacks CORS headers by design; the web handles it (SWITCHED_PATHS).
- Handler hash recorded in the release record; Cognito pool id `us-west-2_FHJoX71ca` unchanged.

## 7. Post-deployment monitoring (first 24 hours, then the normal alarms)
- CloudWatch: API Lambda errors and 5xx rate, throttles, p95 duration (existing alarms in the observability stack); RDS CPU/connections/free storage.
- Watch for: failed sign-ins (new react-router build), validation errors from the web env check (zod 4), "Something went wrong" banners.
- Owner confirms in-app production verification of the already-deployed 2026-11-22 feature release and the first sign-in of caregiver CG-CBBE8E1D (still open items).
- Stop condition: any smoke-test failure → roll back web first, then API; record in the release checklist.
