# Production release record: migrations 0086, 0087, 0088 (2026-11-01)

**Status: PARTIALLY DEPLOYED. Database: deployed. API: deployed. Website: published, then ROLLED BACK (defect). Not accepted. Not "released".**
Evidence is the Operator's pasted output (REPORTED by the Operator, read by Claude) unless marked otherwise. Nothing here proves production health beyond what is stated. Application commit `fb8b7aa4eb73c0cfe4dd6f718930ea54e318cfd7`; scripts commits `130e1a1` (release scripts) and `5f2c685`; owner GO: "GO ... f117510" (revision 1) and "Approve the dedupe fix, full gates, new GO" (revision 2, ref `GO-PRD-0088-R2-20261101`, window 19:30 to 22:30 UTC, window chosen by Claude). See `PRD_PINS.md`.

## Current production state (2026-11-01 21:20 UTC)
| Part | State | Basis |
|---|---|---|
| Database `ogevia_prd` | **88/0088**: staff and readiness objects present; 0 agencies enforcing; 4 of 5 onboarding requirements retired (training 1 remains active); `verify-0086` 110/0, `verify-0087` 22/0; existing row counts unchanged | migrate 18:57:18Z and final 20:13:16Z, exit 0 (VERIFIED from output; top lines of `final` not pasted) |
| API stack `Ogevia-prd-ServiceVerificationApi` | `UPDATE_COMPLETE`; Lambda environment unchanged; new CodeSha256 `Qkm9W6hmnzo21MOwc7RfNGDSsxms9pgaQ4t4ZX9verI=`; **250 routes (22 added, 0 removed)**; four anonymous calls return 401 | deploy-api 20:22:30Z (VERIFIED from output) |
| Website | **Rolled back** to the pre-release files; served `index.html` equals the captured `c61bfa92975cdf1b5b9171e7749bdfa0ec9f7b6d68bbe2e79a37cc1147548bb8`; the new release's asset files remain in the bucket, unreferenced | rollback-web 21:19:58Z (VERIFIED from output) |
| Other stacks, DNS, Cognito pool settings, TEST | unchanged by the release | no step touched them |
| Cognito (owner-approved separately) | MFA for `admin.ogevia@gmail.com` in the production pool reset at the owner's request (`UserMFASettingList` now null; pool MFA still ON). The owner must enroll a new authenticator at the next sign-in | admin-get-user output (VERIFIED) |
| Security group | temporary rule added and removed four times (probe x2, migrate, final); the complete rule set proven identical to the original each time (`76e9c75367c204f0...`); no `OPEN` marker | VERIFIED from output |
| Snapshot | `ogevia-prod-postgres-pre-0088-prd-20261101t1703z` (manual, available) kept as the restore anchor | VERIFIED |

## Timeline (UTC)
- 16:02 to 17:02 dry run (read-only): found the CORS difference; gate allowance added.
- 17:06 snapshot. 18:57 migrate 0086 to 0088: success.
- 19:02 `deploy-api` (revision 1): **UPDATE_FAILED**: API Gateway refused the duplicated `https://app.ogevia.com` in `AllowOrigins` (HTTP 400); CloudFormation rolled back (`UPDATE_ROLLBACK_COMPLETE`, original Lambda code, 228 routes; VERIFIED). The owner had accepted this as a possible outcome.
- Fix: one line in `service-verification-api-stack.ts` removes duplicate origins; G1, G2 and G3 (`pnpm test:all`, 23 files, 158 tests, none skipped) passed; new commit and GO (revision 2).
- Script corrections found during the run (scripts only): the API stack status `UPDATE_ROLLBACK_COMPLETE` was refused as "not settled" by `capture` (deploy script) and by `final` (database script); both now accept it for the API stack only.
- 20:22 `deploy-api` (revision 2): success. 20:27 `web`: published and "WEB VERIFIED".
- 20:28 `smoke`: 2 checks passed; the runtime-database check wanted the admin host to gain a second security group (test-slice precondition); **not done, not authorized; smoke is PARTIAL**.
- ~20:50 owner's sign-in check at `app.ogevia.com` landed on the TEST pool's sign-in domain (`us-west-2849ayz5j7...`). Investigation (read-only) found the website published at 20:27 contains only the TEST pool and client; the pre-release website contains the production pool `us-west-2_FHJoX71ca` and domain `ogevia-prd-300094796789...`. Owner approved a web rollback; done 21:19:58Z.

## Defect found: production website built against the TEST sign-in pool
**Cause (VERIFIED in the code, `infra/aws/scripts/deploy-production.sh` `do_web` and `print-prd-config.ts`):** the `web` mode takes `userPoolId` from `existing.cognitoUserPoolId` (inherited from the TEST configuration for `prd`) and the app client from the WebHosting stack's `TestSliceAppClient`; it does not read the dedicated production pool of `Ogevia-prd-Auth`. The 2026-11-01 deploy script's `web-verify` checked the API host, the production mode, the commit and the bytes, **not the sign-in pool**: a gap in what Claude built. **Effect (INFERRED, not tested):** production sign-in would have gone through the TEST pool; the production API accepts only production-pool tokens, so this was a broken sign-in, not a data exposure.
**Also unexplained:** the pre-release website contains 8 references to the TEST pool as well as the production pool: UNKNOWN why.

## Not verified / open
1. The owner's five sign-in checks (Staff and Staff Types, Accounts, a caregiver page, Schedule, Roles and Permissions): **NOT VERIFIED** (no working production sign-in during the window because of the defect above).
2. Smoke runtime-database check: NOT RUN (see above).
3. The new Staff and readiness screens are **not visible** to users until the website is republished correctly.
4. Fix needed before republishing the website: the web build must take the pool, domain and client from the production Auth stack (the way the earlier production website was built; the auth-separation cutover scripts), and `web-verify` must assert the production pool and domain and fail on the TEST pool. Then G1 to G3, a new commit, a new GO and window. Not started.
5. The owner's `admin.ogevia@gmail.com` production account needs a new authenticator enrolled at the next sign-in (the production pool, domain `ogevia-prd-300094796789...`).
6. The 4 retired onboarding requirements (background check, clearance and 2 documents) stay retired in the database while the API is new; the rollback script `rollback-db` can restore them (not used; owner decision).
7. Corrections to earlier statements: the migration retired 4, not 5, of the 5 active onboarding requirements; an earlier claim that the `environment` tag changes prod to prd was wrong (retracted in the dry-run record).
8. Remaining owner decisions from Phase E: launch scope, BAA/data class (real vs synthetic production data: UNKNOWN), TEST gaps (cross-agency isolation, authorization arithmetic, role gating, Task 8).
