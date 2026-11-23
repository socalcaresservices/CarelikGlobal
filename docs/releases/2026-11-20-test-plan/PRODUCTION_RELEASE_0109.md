# Production release: PR #113 at ef90a2a, request-cleanup switch OFF

**Owner authorization (2026-11-21, verbatim):** "GO production, switch OFF". Given after the owner chose to skip the remaining TEST browser checks (C1 to C10, D1 to D3) and the TEST switch-on step (H2c). Those were not run; this record does not claim them.

**Status: DEPLOYED TO PRODUCTION 2026-11-21 (request-cleanup switch OFF).** Record built from the operator's pasted CloudShell output; production sign-in acceptance in the app is NOT yet recorded.

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

## Deployed record (2026-11-21, operator: the owner, AWS CloudShell, account 300094796789, us-west-2)
Application commit `ef90a2a42c21e2c68e6fbf3f361e618806699b8d` (PR #113, merged into the production branch as `2b07ae4`). Approval: typed `GO-PRODUCTION-0109` after `OGEVIA_DEPLOY_APPROVAL=owner-production-0109-go`, following the owner's instruction "GO production, switch OFF".

**Evidence (from the operator's pasted output; the tail of the final run):** the production web build passed the production sign-in assertion ("the bundle carries the production sign-in pool, domain and client and nothing of the TEST pool"); files uploaded to the production bucket; origin `https://d3l4psdkokkvnb.cloudfront.net`; "PASS: the three request-cleanup routes are absent in production (switch OFF)"; "PRODUCTION DEPLOYED: migration 0109 applied (108 verified ledger rows), request-cleanup switch OFF, production web published; TEST API unchanged"; "ADMIN HOST RESTORED"; "Release state: database=1 API=1 website-started=1". That final line is printed only after every earlier check in the script passed (ledger 107 before and 108 after with the 20 object checks, the reviewed code-only change set, the deployed Handler hash).
**Private recovery archive:** `s3://cdk-hnb659fds-assets-300094796789-us-west-2/ogevia-production-release/ogevia-production-release.z5JzVG/before-update.tgz` (previous template, Handler code, web files, logical database dump, rollback script). Preserve it.

**An earlier attempt stopped at stage 2, before any change** (`database=0 API=0`): production had two sign-in override routes live since the 2026-11-15 release (branch `claude/keen-hawking-e9o2jg`, PR #109, not merged to the production branch), which the helper then rejected. The helper was corrected to allow exactly those two routes (commit `57828291`), and the release re-run.

## Not verified
The earlier stage lines (ledger 108, 20 checks, change-set check, deployed Handler hash) were not in the pasted tail; they are implied by the final line. Not run anywhere: TEST browser checks C1 to C10, D1 to D3, and the request-cleanup switch ON (H2c). Production sign-in and the ten go-live items still need the owner's check in the app. Do not create a real visit to test.

## Open items
Production is ahead of the production branch in one respect: the 2026-11-15 sign-in override change set exists only on `claude/keen-hawking-e9o2jg`. The CDK code at the production branch still does not synthesize those two routes for production; keep using the code-only change-set method until that branch is reconciled.

## Web follow-up published to production (2026-11-21, owner GO "all now", operator: the owner, AWS CloudShell)
Application commit `26f58384875d55b650b28554bdd5233ba3d3d3cc` (web only: the staff ID `CG-...` removed from the caregiver page header; Reports charts and the shared Chart follow the palette chosen in Settings > Appearance). Method: `infra/aws/scripts/production-web-release.sh` (typed `GO-PRODUCTION-WEB`), which uses the existing `deploy-production.sh web` mode. No database, API, IAM or security-group change.

**Evidence (operator's pasted output):** "PASS the bundle carries the production sign-in pool, domain and client and nothing of the TEST pool"; the files uploaded to the production bucket; "PRODUCTION WEB PUBLISHED: https://d3l4psdkokkvnb.cloudfront.net serves commit 26f58384875d55b650b28554bdd5233ba3d3d3cc" (printed only after the served `index.html` equalled the build and the CSP header was present); "Release state: website-started=1".
**Private recovery:** `s3://cdk-hnb659fds-assets-300094796789-us-west-2/ogevia-production-release/ogevia-production-web.acU1qb/web-before.tgz` (previous web files and the rollback script).

Not yet recorded: the owner's check in the app (caregiver header, chart palette on Home and Reports). The request-cleanup switch is still OFF in production until the route change set (`production-request-cleanup-routes-deploy.sh`, owner approval `owner-production-request-cleanup-go`) is run and its output recorded.
