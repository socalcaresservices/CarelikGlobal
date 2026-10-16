# Phase C authorization statement: TEST web release (for the owner to approve)

**Status: PROPOSED. NOT APPROVED. Nothing is deployed.** This is the exact text the owner approves. The only blanks are the window times, which are set when the owner approves. Under `docs/TESTING_AND_RELEASE_PROCESS.md` section 5.1, a GO is valid for the named commit, target and window only.

---

**Owner's written Phase C statement: TEST web release (pilot/test only)**

- **Reference:** `owner-go-test-web-0052-2026-10-16` *(assigned for this approval; the operator uses it as `OGEVIA_DEPLOY_APPROVAL`)*.
- **Target:** the AWS TEST environment only: stacks `Ogevia-prod-*` (in these names "prod" means TEST), site `https://d2xumch5w0izfg.cloudfront.net`, API id `s0epy5rgzb`, database `ogevia_sv_test` (not touched). **Never** `Ogevia-prd-*` or any PROD resource.
- **Application baseline:** commit `d82fefcd37407d837e7c94f6ac57a907ea286ed1`. The web files published are the baseline application built with `VITE_APP_ENV=test`. No application code differs from the baseline.
- **Tooling:** `infra/aws/slice/test-web-release.sh` with sha256 `3470a9a3c8127dbe013f93dd49946d1b441de5e047c8cec3634138c67c4c350e`, run from a checkout that contains the baseline and whose application files equal it (the script enforces both). The operator records the checkout's full commit in `release.log`.
- **Operator:** Ogechi Okereke *(as in the 2026-10-15 statement; the owner confirms or replaces)*.
- **Window (America/Los_Angeles):** from `____-__-__ __:__` to `____-__-__ __:__` (two hours). The operator sets `OGEVIA_WINDOW_END` to the end time in UTC; `publish` refuses to start after it. A running step finishes.
- **Approved:**
  1. read-only `preflight` and `verify`;
  2. a local `build` with `VITE_APP_ENV=test`;
  3. `capture`: copying the current TEST site to the operator's local disk;
  4. `publish`: uploading the new web files to the TEST site bucket and one CloudFront invalidation on the TEST distribution;
  5. `rollback` of this release's web files on TEST **without a separate approval** if any stop condition below occurs, so a failed check cannot leave TEST looking like production.
- **NOT approved:** any change to PROD (`Ogevia-prd-*`); `config.json`; Cognito (pool, clients, users); the API, Lambda, IAM or any CloudFormation stack; the database or any migration; DNS; Netlify or Supabase; `smoke.py`, `pilot_smoke.py`, `pilot_regression.py` and seed 03 (they write synthetic records and need a separate one-line approval); merging the pull request (a separate decision); deleting anything.
- **Stop conditions (the operator stops and reports; nothing further is written):** any `REFUSED` or `FAILED` line; the checksum of the script differs from the one above; the build is not labelled `test`; the live `config.json` says production or names another API; `verify` fails; the banner "TEST — synthetic data only" is not visible on every page after sign-in (SMK-07); a console error on a core screen; the owner says stop.
- **Consequence:** UI-level validation of the Wave 1 screens (acceptance list in `OPERATOR_CHECKLIST.md`) can be done on TEST by the owner and testers with synthetic data. Smoke, regression and seed writes remain unapproved. PROD and Phase E are not decided and not affected.

*Approved by (name): __________________  Date and time: __________________*

---

Notes for the owner (not part of the statement):
- Returning TEST to its pre-window database state is NOT part of this release: this release changes web files only.
- The script has been tested only against test doubles, not against real AWS. The first real run is this one, under this statement.
