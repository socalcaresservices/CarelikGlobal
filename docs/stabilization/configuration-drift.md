# Configuration drift audit

STATUS: COMPLETE for everything the repository can prove; **NEEDS HUMAN INPUT** for the live-template comparison (no AWS access from this environment). "Production value" below is taken from the production records and release gates in the repository (operator outputs, the retained-route list and guards in `production-office-assignments-release.py`), not from a fresh read of AWS. Computed comparison method: `cdk synth Ogevia-prd-ServiceVerificationApi -c env=prd -c mode=plan` locally, route logical ids compared with the ids the production helpers inserted.

## Computed result (before → after this branch's change)
| | At c7691b63 | On this branch |
|---|---|---|
| Routes the repo synthesizes for production (switches as in `config.ts`) | 258 (the four release switches absent) | **270** |
| Release route logical ids compared with the production helpers (18 release routes + 2 sign-in-override routes) | n/a (routes absent) | **20 compared, 0 mismatches** |
| Production route total per records (258 before the Offices release + 9 + 9) | 276 | 276 |
| Remaining difference repo vs production | 18 | **6 routes** (the `liveTestRepairs` routes: business documents ×2, missing visits ×2, QR check-in, QR card), 270 + 6 = 276 |

## Discrepancies
| # | Item | Repository value (c7691b63) | Production value (source) | Expected | Risk | Remediation | Status |
|---|---|---|---|---|---|---|---|
| 1 | `signInOverride` (PRD) | `false` | routes live since 2026-11-15 (b3a22741; owner accepted; used in this build) | `true` | **High** if anyone runs `cdk deploy`: the 2 override routes would be removed | Merged `claude/keen-hawking-e9o2jg` (carries the config change); ids verified equal | FIXED on this branch |
| 2 | `requestCleanup` (PRD) | absent (off) | ON: 3 routes live (Offices release, "request cleanup ON", aeaed304) | `true` | **High** (same: a deploy would remove 3 routes) | Set `true`; test updated | FIXED on this branch |
| 3 | `offices` (PRD) | absent (off) | ON: 6 routes live (aeaed304) | `true` | **High** | Set `true`; test updated | FIXED on this branch |
| 4 | `officeAssignments` (PRD) | absent (off) | ON: 8 routes live (c7691b63) | `true` | **High** | Set `true`; test updated | FIXED on this branch |
| 5 | `assignmentHistory` (PRD) | absent (off) | ON: 1 route live (c7691b63) | `true` | **High** | Set `true`; test updated | FIXED on this branch |
| 6 | `liveTestRepairs` routes (6) | **TEST-only by code** (`"Accepted live repair routes are TEST-only"`, `service-verification-api-stack.ts:455`); not synthesized for production | production serves all 6 (listed as retained in every production gate) | synthesized for production with the **live logical ids** | **High**: `cdk deploy` of the production API stack would delete 6 routes | Plan `docs/releases/2026-11-15-cdk-branch-alignment/PLAN.md` Stages 0 to 3 (a separate production-only compatibility mode; needs the live logical ids) | **NEEDS HUMAN INPUT**: Stage 0 read-only capture (commands in that plan; the read-only drift tool `production-template-drift.py` is already in the repo) |
| 7 | QR parameter | `ClientQrEncryptionKey` (only in the TEST-only path) | `QrEncryptionKey0102` (alignment plan, VERIFIED in repo docs; live value unread) | same name as live | Medium: preserved today by "previous parameters" in the release scripts; a fresh deploy would create a different parameter | Same Stage 0 to 2 | NEEDS HUMAN INPUT (capture) |
| 8 | `RepairCodeBucket` / `RepairCodeKey` parameters, Handler tags | defined by the TEST-only path | live template carries them (CloudFormation warns "Parameter RepairCodeBucket is not referenced") | match live | Low (warning only) | Stage 2 | NEEDS HUMAN INPUT |
| 9 | Handler code | CDK-built asset | a packaged zip, patched by key in each release (current `index.js` sha256 `4df8dee3…6d5a`, equal in source trees to the TEST code of 7fca7784) | CDK asset only if its bytes equal the accepted bundle | Medium | Stage 2 decision 3 of the plan (parameterized zip, or CDK asset if bytes match); not decided | NEEDS HUMAN INPUT (owner decision) |
| 10 | `bulkImport` | `false` | routes absent (on the production STAY-OFF list) | `false` until the feature is approved (see `feature-readiness.md`: FIX FIRST) | none (consistent) | none | NO DRIFT |
| 11 | `staffDuplicates` | `false` | routes absent (same list) | `false` (DO NOT ENABLE) | none (consistent) | none | NO DRIFT |
| 12 | Handler environment | `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd`, `DB_HOST=ogevia-prod-postgres…rds.amazonaws.com`, `COGNITO_USER_POOL_ID` = import of `Ogevia-prd-Auth` (names: COGNITO_APP_CLIENT_ID, COGNITO_USER_POOL_ID, DB_HOST, DB_NAME, DB_PORT, DB_SECRET_ARN, DB_SET_ROLE, EVIDENCE_BUCKET, EVIDENCE_KEY_ARN, IDENTITY_FUNCTION_NAME, LOG_LEVEL, NODE_EXTRA_CA_CERTS, OGEVIA_ENV, OGEVIA_FORBIDDEN_POOL_IDS) | the production release gate asserts exactly `DB_NAME=ogevia_prd`, host, pool `us-west-2_FHJoX71ca`, runtime `nodejs24.x` before every release, and the 2026-11-22 run passed it | same | none found | none | NO DRIFT (as asserted by the gate; live values of the other variables unread) |
| 13 | Secret references | `DB_SECRET_ARN` = import of `Ogevia-prd-DatabaseSecret`; no secret values in the repository (checked: names only) | the gates never read a secret value | same | none found | none | NO DRIFT |
| 14 | Web release toggles | no runtime feature flags in the web app: UI controls hide when their data request fails (switch off) | n/a | n/a | none | none | NO DRIFT |
| 15 | Database object ownership | `ogevia_owner` owns objects in a repository-built database | `ogevia_admin` owns 4 tables and 17 functions in production; two manual grants/policy (see `database-audit.md`) | aligned or captured in migration 0108 | Medium | `database-audit.md` section 7 | NEEDS HUMAN INPUT (capture) |

## Particular review items
- **Sign-in override**: drift #1, fixed. Production behavior unchanged.
- **Bulk import / duplicate staff merge**: no drift (both off in repository and absent in production); readiness in `feature-readiness.md`.
- **Release switches / offices release routes**: drift #2 to #5, fixed; every route logical id matches the production helpers (computed).

## Read-only capture to close items 6 to 9 and 15 (owner, CloudShell; unchanged from the alignment plan, Stage 0)
Use the commands in `docs/releases/2026-11-15-cdk-branch-alignment/PLAN.md` section 3 (they run `cdk synth -c env=prd -c mode=plan`, read the six production stack templates with `aws cloudformation get-template`, and compare with `infra/aws/scripts/production-template-drift.py`, which prints no secret value). Nothing is created or changed.
