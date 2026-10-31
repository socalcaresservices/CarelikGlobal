# Environment-specific configuration: TEST and PRODUCTION for the candidate `24fd8b1`

Written 2026-10-27 on the Owner's instruction ("Document any environment-specific configuration differences"). The same code commit is meant to run in both places; this lists what differs by configuration, where each value comes from, and what TEST therefore cannot prove about production. Labels: VERIFIED (read from a committed file or a pasted live output named), INFERRED, NOT VERIFIED.

| Item | TEST (CDK env `prod`, stacks `Ogevia-prod-*`) | PRODUCTION (CDK env `prd`, stacks `Ogevia-prd-*`) | Source / label |
|---|---|---|---|
| Environment band | build value `VITE_APP_ENV=test`: amber band "TEST — synthetic data only" on the sign-in screens and inside the app | `VITE_APP_ENV=production`: **no band, by design** (a missing or invalid value shows "Environment not verified") | `apps/web/src/aws/environment.ts`; TEST bundle shows `VITE_APP_ENV:"test"` (live read 2026-10-26, VERIFIED); production bundle `production` (capture, VERIFIED) |
| Where the label comes from | the served `/config.json` has **no** `VITE_APP_ENV` key (live read), so the build's own value applies | no `config.json` is served or touched by the package; the value is embedded at build time | live read 2026-10-26; `web-prd.sh` refuses a build containing `config.json` |
| Web address | `https://d2xumch5w0izfg.cloudfront.net` and `demo.ogevia.com` (both are allowed return URLs of the TEST client) | `app.ogevia.com`, `admin.ogevia.com` on the production distribution | TEST client URLs read 2026-10-26 (VERIFIED); DNS for the production names NOT VERIFIED; the CloudFront alias list was requested and not yet received |
| Sign-in pool | shared pilot pool `us-west-2_849AYz5J7` | dedicated pool `us-west-2_FHJoX71ca` | VERIFIED (live read; capture) |
| Web sign-in client | `7po3lrme6a1clkqvif9b7sr9td`, named `ogevia-web-prod-test-slice` (live read 2026-10-26). The TEST API also accepts the older client `1i27abbina08fvg1i9u8vprgo9` | the production pool's own client; production never accepts the shared pool or `1i27…` | VERIFIED (TEST); `lib/config.ts` and `docs/aws/AUTH_SEPARATION_PHASE2_DESIGN.md` (production) |
| API | `s0epy5rgzb`, 241 routes after 0086's 13 | `zk527zk4ua`, 228 routes now, 241 after the release | VERIFIED |
| Database | `ogevia_sv_test`, login `ogevia_app`, secret `ogevia/database/app` | `ogevia_prd`, login `ogevia_prd_app`, secret `ogevia/prd/database/app` | `lib/config.ts` (VERIFIED). Same RDS instance `ogevia-prod-postgres` for both |
| Ledger | 85 / 0085, 0086 applied outside it | 85 / 0085 now; after the release the same (0086 outside) | VERIFIED |
| Staff-management switch (`features.staffManagement`) | `true` | `true` (since `515c49a`, Owner-approved 2026-10-26) | `lib/config.ts` (VERIFIED) |
| API CORS origins added by this release | `https://demo.ogevia.com` (already in TEST) | `https://app.ogevia.com`, `https://admin.ogevia.com` appended | `5d88e07`; the production gate |
| Sign-in return and sign-out URLs | TEST web client lists the CloudFront and `demo` URLs | the production client gains the `app.` and `admin.` URLs (4 properties) | the production gate |
| How the web is built and published | `deploy-test-slice.sh web` with the TEST stack outputs and `VITE_APP_ENV=test` | `web-prd.sh` reusing the embedded values of the live production bundle plus `VITE_APP_VERSION=<commit>` | scripts (VERIFIED) |
| Data | synthetic (the band says so) | the Owner stated on 2026-10-20 that production holds synthetic data only; not verified and not used by the package | NOT VERIFIED |
| MFA | the TEST Owner account has no user-level MFA preference set (read 2026-10-27) | the production pool requires MFA (capture) | VERIFIED (both reads) |
| Alarm email, DNS, certificate attachment in production | not part of this release | NOT VERIFIED | — |

## Identical by design (the candidate is one build)
Same source commit `24fd8b17795dd7e0ba6f36eec1791918feefb216`; the same Handler asset `94b73574…` and Identity asset `7c5f8eb6…` (the API code did not change with the label fix, only the web); migrations 0001-0085 and the pending 0086 byte for byte; the same 13 staff routes behind the same sign-in check.

## What TEST therefore cannot prove about production
- That `app.ogevia.com` and `admin.ogevia.com` resolve to the production site, and that the production client accepts a sign-in from them.
- That the production web build (production's own embedded values) behaves as the TEST build with TEST values. The package's web guard checks the production build mechanically; it is not a browser test of production.
- Anything about production's real stack drift. The expected-only gate checks the live templates, not the Lambda code content beyond the asset key.
- That the band is absent in production: proven only by the tests and the production procedure's Step 13/14 walk.
