# TEST web release: release package (2026-10-16)

**Status: PREPARED FOR REVIEW. NOT AUTHORIZED. NOTHING IS DEPLOYED.** Merging the pull request deploys nothing. Deployment needs the owner's approved `PHASE_C_AUTHORIZATION_STATEMENT.md` and is run by the operator.
Companions in this folder: `PHASE_C_AUTHORIZATION_STATEMENT.md`, `OPERATOR_CHECKLIST.md`, `ROLLBACK.md`, `evidence/`.

## 1. Purpose
TEST still runs the web app published on 2026-10-05 (horizontal menu, no environment banner), while its database is at `52|0052` and its API has the 169 routes of `main`. This release publishes the **approved baseline application** `d82fefc` to TEST only, built so that TEST **always** shows "TEST — synthetic data only", without touching `config.json`, Cognito, the API, the database or PROD.

## 2. The defect this fixes
TEST's live `config.json` has no `VITE_APP_ENV` key (written before 2026-10-07), so the **build** value decides the banner. The deployment procedure and four TEST deploy scripts built TEST with `VITE_APP_ENV=production`: such a build shows **no banner** (reproduced in Chromium on the repository harness; `evidence/no-banner-production-build-1280.png`). The banner text exists in the code of every build, so searching a bundle for that text proves nothing; the check that works is the baked-in value `VITE_APP_ENV:"test"`.

## 3. Scope (exact)
| | |
|---|---|
| Application baseline | `d82fefcd37407d837e7c94f6ac57a907ea286ed1`. **No file under `apps/`, `packages/`, `supabase/`, `.github/`, `netlify.toml`, `package.json` or `pnpm-lock.yaml` changes in this pull request** (verified with `git diff --name-only origin/main..HEAD`). |
| Target | TEST only: stacks `Ogevia-prod-*` (`prod` means TEST), site `d2xumch5w0izfg.cloudfront.net`, API id `s0epy5rgzb` |
| What the release writes | new hashed assets, root files and `index.html` in the TEST site bucket; one CloudFront invalidation on the TEST distribution. Never `config.json`, never `--delete` |
| Never touched | PROD (`Ogevia-prd-*`; only its stack outputs are read, for the separation check), database, API, Lambda, IAM, Cognito, DNS, Netlify, Supabase |
| Evidence accepted (owner-reported) | TEST `config.json` has no `VITE_APP_ENV` and names API `s0epy5rgzb`; TEST ledger `52|0052` (`ogevia-release-0052-run`: `RELEASE_0052_SUMMARY.txt`, `step7.log`, `db-verify.txt`); TEST has 169 routes |

## 4. Files changed (25 files, +931/-14 against `main`, including this package; six commits)
| Commit | File | Change |
|---|---|---|
| `246d123` (earlier, documentation only; already on the branch) | `docs/releases/2026-10-14-pilot-readiness/OPERATOR_READONLY_VERIFICATION_2026-10-15.md` (new), `BLOCKER_REGISTER.md`, `docs/releases/2026-10-13-wave1/CHECKLIST.md` | operator instructions for the read-only verification and two record notes |
| `0de834f` | `infra/aws/slice/pilot-lib.sh` | adds `assert_test_web_label` and `assert_live_config_label` |
| | `infra/aws/slice/increment-deploy.sh` | builds with `VITE_APP_ENV=test`; asserts before publishing |
| | `docs/releases/2026-10-14-pilot-readiness/PILOT_DEPLOYMENT_PROCEDURE.md` | step 13: test label, never production; SMK-07 is a stop |
| | `infra/aws/test/web-environment-label.test.ts` (new) | 13 tests |
| `701c726` | `infra/aws/slice/release-0026-deploy.sh`, `release-0036-deploy.sh` | same fix and guards (they keep the live `config.json`, so had the same defect) |
| | `infra/aws/slice/pilot-deploy.sh`, `infra/aws/scripts/build-slice-bundle.sh` | build with the test label (defence in depth; they write a fresh `config.json`) |
| | `infra/aws/test/web-environment-label.test.ts` | script lists extended |
| `fda25fb` | `infra/aws/slice/test-web-release.sh` (new) | the TEST-only release script: preflight, build, capture, publish, verify, rollback |
| | `infra/aws/test/test-web-release.test.ts` (new), `infra/aws/test/fixtures/test-web-release/{aws,curl,npx}` (new) | 27 tests against test doubles |
| `d3fae53` | `docs/releases/2026-10-14-pilot-readiness/PILOT_DEPLOYMENT_PROCEDURE.md`, `PILOT_OPERATOR_RUNBOOK.md` | the outdated migration baseline corrected: TEST started at `36|0036`, not `46|0046`; 0037 to 0052 were applied together |
| this release's documents | `docs/releases/2026-10-16-test-web-release/` (README, PHASE_C_AUTHORIZATION_STATEMENT, OPERATOR_CHECKLIST, ROLLBACK, evidence) | the package |
`deploy-production.sh` is unchanged on purpose: production keeps the production label.

## 5. How the script keeps TEST labelled and cannot target PROD
- **Baseline guard:** the checkout must contain `d82fefc` and its application files (`apps/`, `packages/`, lockfile and workspace files) must be identical to it; the working tree must be clean. Scripts, tests and documents may differ, so it can run from the reviewed branch or from `main` after merge.
- **Account and region:** account `300094796789`, region forced to `us-west-2`.
- **Target identity:** the TEST web address and API id must equal the documented ones; every TEST resource (web origin, bucket, distribution) must differ from the PROD resource of the same kind (PROD stack outputs must be readable, or it stops); the bucket name must not contain `prd`. Every S3 address the script writes to is the TEST bucket variable (a test enforces this).
- **Live `config.json`:** must be a JSON object naming API `s0epy5rgzb`; its `VITE_APP_ENV` must be absent, `test` or `development`; never `production`.
- **Label:** the build uses `VITE_APP_ENV=test`; the built files must contain `VITE_APP_ENV:"test"`, must not contain `VITE_APP_ENV:"production"`, and the output must contain no `config.json`. Checked at `build` and again at `publish`.
- **Authorization:** `publish` needs `OGEVIA_DEPLOY_APPROVAL`, `OGEVIA_WINDOW_END` (UTC, still in the future, at most 4 hours ahead), and the typed phrase `PUBLISH TEST`; `rollback` needs the reference and `ROLLBACK TEST`.
- **Failures:** any failed command stops with its real exit code (account numbers and ARNs scrubbed); a missing CloudFormation output is a failure, never a pass. Exit codes: 0 ok, 2 refused (nothing written), 3 failed.

## 6. Test results (exact commit `d3fae53` exported to an isolated folder; Node 22.22.0, pnpm 9.15.4, frozen lockfile; local PostgreSQL 16)
| Gate | Result |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test:all` | exit 0: "all suites ran, none skipped, all passed". Unit: shared 118, auth 138, sv-api 67, ui 73, infra-aws 177 (13 files), web 792. Database suites: 58 files, 561 tests. API suites: 5 files, 75 tests |
| New: `web-environment-label.test.ts` | 13 tests. On the unpatched baseline 7 of 11 failed (the failing-first record); all pass with the changes |
| New: `test-web-release.test.ts` | 27 tests: static scope checks; guards (live production label, other API, shared TEST/PROD resources, wrong web address, wrong API id, wrong account, missing baseline, changed application files, local changes); failures with real exit codes; build refusals (production label, no label); publish refusals (no build, no capture, no approval reference, no window, past window, window over 4 hours, malformed window, wrong phrase, `config.json` in the build, failed upload); the full publish, verify, stale-cache, rollback cycle |
| Deliberate breakages of the script | 6 (separation check, label check, baseline check, window, live-label check, `config.json` exclusion): each makes the tests fail |
| Browser proof (not part of CI) | Chromium on the repository harness (real API handler, local PG16 with 52 migrations, synthetic administrator), `config.json` without `VITE_APP_ENV`: test build shows "⚠ TEST — synthetic data only" (`data-environment="test"`) at 1280 px and 390 px with no console errors; the production-labelled control shows no banner. See `evidence/` |
| Build repeatability | two independent builds of the baseline are byte-identical; fingerprint in `evidence/BUILD_FINGERPRINT.txt` |
**Not tested:** the script against real AWS (the first real run is the authorized one); the banner on the real TEST site (SMK-07 in the checklist is the final proof); a real-phone check.

## 7. GO / NO-GO
**GO only if all are true:** the owner approved the statement (reference, operator, window, script checksum); CI is green on the commit used; `preflight`, `build`, `capture` pass; no other TEST change is in progress; the window is open.
**NO-GO / stop if any:** a guard refuses; the live `config.json` says production or names another API; the label check fails; TEST and PROD resources are equal; capture fails; the account is wrong; new evidence contradicts `52|0052`; `verify` fails; SMK-07 fails after publish (roll back).

## 8. Remaining risks and blockers
1. The script has only run against test doubles; its first real run is the authorized one. Mitigation: read-only `preflight` first, rollback copy before any write, a verify step, and a pre-authorized rollback.
2. CloudShell may build a different entry file name (Node version): reported as a note; `verify` compares the live `index.html` with the operator's own build.
3. The sign-in pool is shared by TEST and PROD: during acceptance, Disable/Enable on the Accounts page only for a synthetic TEST-only account.
4. PROD's ledger (owner-reported `46|0046`) is still unverified, and the PROD web is older than `main` (it lacks the Accounts, visit-rules and open-shift screens). Not part of this release; PROD is untouched.
5. `smoke.py`, `pilot_smoke.py`, `pilot_regression.py` and seed 03 are not part of this approval.
6. Open pull request #98 (a documentation record of the 2026-10-15 statement) is separate and still open.
