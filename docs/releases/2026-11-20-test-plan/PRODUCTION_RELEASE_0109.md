# Production release: PR #113 at ef90a2a, request-cleanup switch OFF

**Owner authorization (2026-11-21, verbatim):** "GO production, switch OFF". Given after the owner chose to skip the remaining TEST browser checks (C1 to C10, D1 to D3) and the TEST switch-on step (H2c). Those were not run; this record does not claim them.

**Status: PREPARED, NOT DEPLOYED.** Implemented and tested here; nothing has run in production.

## What goes to production
| Part | Change |
|---|---|
| Database `ogevia_prd` | Migration 0109 (two nullable columns, three functions) with its ledger row, one transaction. Ledger 107 rows to 108. Guard: the ledger must equal the exact 107 accepted rows or the transaction stops. |
| API `Ogevia-prd-ServiceVerificationApi` | **Handler code only** (asset `0877a461...zip`, index.js sha256 `a8b83878...36c6`, the code already running on TEST). Change set reviewed by `production-0109-release.py changes`. No route, IAM, auth or QR change. The three request-cleanup routes stay absent (must answer 404). |
| Web | Production build with the dedicated production Auth pool (`deploy-production.sh web`), stamped with the commit. |
| Not changed | TEST, Cognito, DNS, Netlify, Supabase, any other stack. The switch stays OFF. |

## Method
Same as the 2026-11-11 production promotion (`deploy-production.sh ux-release` and `ux-resume`), re-pinned: `PRD_0109_RELEASE.sh` plus `infra/aws/scripts/production-0109-release.py`. It temporarily attaches the application security group to the admin host (restored on exit), saves a logical backup of `ogevia_prd` to the private encrypted assets bucket, applies the SQL, executes a reviewed code-only change set, publishes the web, and verifies. A typed `GO-PRODUCTION-0109` confirmation precedes any change. `resume <workspace>` finishes the API and web after a verified stop and never reruns the migration.

## Tests (local)
`production-0109-release.test.ts` (template patch, change set), `production-0109-upgrade.db.test.ts` (real PostgreSQL: exact-ledger guard, atomic rollback, ownership, no second run), `prd-0109-release-guards.test.ts` (approval, account, typed confirmation).

## Rollback
API and web: the saved `rollback-api-web.sh` in the private archive (`s3://cdk-hnb659fds-assets-300094796789-us-west-2/ogevia-production-release/<workspace>/before-update.tgz`) restores the previous template and web files. Database: 0109 is additive and inert while the switch is off; restoring the database needs a separate recovery decision (the archive holds the logical dump and the pinned down script).

## Not verified before production
TEST browser checks C1 to C10 and D1 to D3; H2c (the three routes behaving with the switch on). Production sign-in acceptance after deployment is a human check; do not create a real visit to test.
