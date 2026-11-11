# Phase C commands (UX redesign, TEST only). PREPARED, NOT AUTHORIZED, NOT RUN.

Run only after the owner's written statement. Every step stops on a surprise; "stop" means change nothing further and report. Replace the angle-bracket values from the owner's statement; nothing here has a default for the window or the GO reference.

## 0. Shell setup (CloudShell, us-west-2, account 300094796789)
```bash
export OGEVIA_WINDOW_START="<YYYY-MM-DD HH:MM:SS UTC from the statement>" OGEVIA_WINDOW_END="<YYYY-MM-DD HH:MM:SS UTC>"
export OGEVIA_DEPLOY_APPROVAL="<the owner's GO reference>"
git clone <repo URL> ogevia && cd ogevia && git checkout 7f9483d39690ae94db2710465d6995cd0b82b271
git rev-parse HEAD            # must print 7f9483d39690ae94db2710465d6995cd0b82b271
corepack enable && pnpm install --frozen-lockfile
# scripts and their pins: copy docs/releases/2026-11-10-ux-redesign-test/toolchain/* from the docs commit to ~/ux-toolchain and check each sha256 against PINS.md
cd ~/ux-toolchain && sha256sum OPERATOR_TEST_DB.sh OPERATOR_TEST_DEPLOY.sh diff_gate_ux.py VERIFY_0090_0094.sql
export REPO=~/ogevia
```
## S1 local selftests (no AWS, no database)
```bash
bash OPERATOR_TEST_DB.sh selftest        # expects: pins ok ... selftest done
bash OPERATOR_TEST_DEPLOY.sh synth       # builds /tmp/ogevia-cdk-ux.out; expects PASS all checks (Handler af1a8769..., 255 routes)
bash OPERATOR_TEST_DEPLOY.sh selftest
```
## S2 read-only baseline
```bash
bash OPERATOR_TEST_DB.sh probe           # ledger 88/0088 and VERIFY expect=absent: 53 checks, 0 failing
bash OPERATOR_TEST_DEPLOY.sh capture     # writes ~/ogevia-before-ux (live API template, Lambda config, previous code asset, web copy); confirms the Lambda serves ogevia_sv_test
```
## S3 expected-only gate
```bash
bash OPERATOR_TEST_DEPLOY.sh check       # cdk diff text + "EXPECTED-ONLY: YES" (exactly 5 routes + the Handler asset). Anything else: stop
```
## S4 backup
```bash
bash OPERATOR_TEST_DB.sh snapshot        # prints SNAPSHOT_ID=ogevia-prod-postgres-pre-ux-<time>; must be available and encrypted
export SNAPSHOT_ID=<the printed id>
```
## S5 migrations (0090, 0091, 0092, 0093, 0094, in that order; TEST database only)
```bash
bash OPERATOR_TEST_DB.sh apply           # asks you to type: G1 AUTHORIZED, then APPLY 0090-0094; ends with "POST-STATE MATCHES"
```
## S6 API, S7 web (in this order)
```bash
bash OPERATOR_TEST_DEPLOY.sh deploy-api  # asks you to type DEPLOY-Ogevia-prod-ServiceVerificationApi; ends with POST-API OK (401 on the 5 routes)
bash OPERATOR_TEST_DEPLOY.sh web         # asks you to type PUBLISH-WEB; ends with WEB VERIFIED (bundle carries 7f9483d...)
```
## S8 demo day (synthetic data, TEST only; the SQL refuses any database but ogevia_sv_test; do not run after 21:00 Pacific)
Use `infra/aws/db/deploy/07_seed_ux_demo_visits.sql` as described in its header (needs the agency slug and a caregiver code who can sign in).
## S9 validation
Regression runner in AWS mode (must exit 0), smoke suites, the TEST cases in `FEATURE_TEST_PLAN.md` section 7, and the owner's own review. Commands: `docs/release-process/PILOT_REGRESSION_RUNNER.md`, `infra/aws/slice/smoke.py`, `infra/aws/slice/pilot_smoke.py`.
## S10 final read
```bash
bash OPERATOR_TEST_DB.sh final
```
## Rollback (only after a stop condition; newest layer first)
```bash
bash OPERATOR_TEST_DEPLOY.sh rollback-web
bash OPERATOR_TEST_DEPLOY.sh rollback-api
bash OPERATOR_TEST_DB.sh rollback        # needs the owner's written DB-rollback authorization; down scripts 0094 -> 0090
```
Return to the owner (text, no secrets): the output of every step, the snapshot id, the Lambda `CodeSha256` before and after, the served `VITE_APP_VERSION`, the ledger before and after (must both read 88/0088).
